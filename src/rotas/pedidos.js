const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const db = require('../db');
const cfg = require('../config');
const svc = require('../pedidos');
const mp = require('../mercadopago');
const { criarPedidoSchema, formatarErros, UUID } = require('../validacao');
const acessoPedido = require('../acesso-pedido');
const cobrancas = require('../cobrancas');

const limiteCriar = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false,
  message: { erro: 'Muitas tentativas. Aguarde alguns minutos.' }
});
const limiteConsulta = rateLimit({
  windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false,
  message: { erro: 'Muitas consultas. Aguarde um instante.' }
});

// Catálogo (preços vêm do servidor)
router.get('/produtos', async (req, res, next) => {
  try { res.json((await db.query('SELECT id,nome,descricao,preco_centavos,imagem_url,esgotado FROM produtos WHERE ativo=TRUE ORDER BY nome')).rows); }
  catch (e) { next(e); }
});

// Cria pedido + cobrança Pix
router.post('/pedidos', limiteCriar, async (req, res, next) => {
  const r = criarPedidoSchema.safeParse(req.body);
  if (!r.success) return res.status(400).json(formatarErros(r.error));
  const tokenAcesso = req.get('x-order-access-token');
  if (!acessoPedido.tokenValido(tokenAcesso)) {
    return res.status(400).json({ erro: 'Não foi possível proteger o acompanhamento. Recarregue a página e tente novamente.' });
  }

  let pedido;
  try {
    pedido = await svc.criarPedido(r.data, cfg.pixExpiraMin, tokenAcesso);
  } catch (e) {
    if (e instanceof svc.ErroNegocio) return res.status(e.status).json({ erro: e.message });
    return next(e);
  }

  try {
    await cobrancas.gerarParaPedido(pedido.id);
  } catch (e) {
    console.error(`[pix] tentativa agendada para pedido ${pedido.id.slice(0, 8)} (HTTP ${e.httpStatus || 'indisponível'}).`);
  }
  try {
    const corpo = await svc.visaoPublica(await svc.obterPedido(pedido.id));
    const statusHttp = corpo.pix ? (pedido.reutilizado ? 200 : 201)
      : corpo.status === 'pendente' ? 202 : (pedido.reutilizado ? 200 : 201);
    res.set('Cache-Control', 'no-store').status(statusHttp).json(corpo);
  } catch (e) { next(e); }
});

// Recupera um pedido se a resposta original da criação não chegou ao navegador.
router.get('/pedidos/retomar', limiteConsulta, async (req, res, next) => {
  try {
    const pedido = await acessoPedido.buscarPorToken(req.get('x-order-access-token'));
    if (!pedido) return res.status(404).json({ erro: 'Pedido não encontrado.' });
    res.set('Cache-Control', 'no-store').json(await svc.visaoPublica(pedido));
  } catch (e) { next(e); }
});

// Consulta de status (o site faz polling nesta rota)
router.get('/pedidos/:id', limiteConsulta, async (req, res, next) => {
  if (!UUID.test(req.params.id)) return res.status(404).json({ erro: 'Pedido não encontrado.' });
  try {
    const pedido = await svc.obterPedido(req.params.id);
    if (!pedido) return res.status(404).json({ erro: 'Pedido não encontrado.' });
    if (!await acessoPedido.autorizar(pedido.id, req.get('x-order-access-token'))) return res.status(404).json({ erro: 'Pedido não encontrado.' });
    res.set('Cache-Control', 'no-store').json(await svc.visaoPublica(pedido));
  } catch (e) { next(e); }
});

const limiteCancelamento = rateLimit({
  windowMs: 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false,
  message: { erro: 'Muitas tentativas. Aguarde um instante.' }
});

router.post('/pedidos/:id/cancelar', limiteCancelamento, async (req, res, next) => {
  let pedido;
  let cancelamentoReservado = false;
  try {
    if (!UUID.test(req.params.id)) return res.status(404).json({ erro: 'Pedido não encontrado.' });
    pedido = await svc.obterPedido(req.params.id);
    if (!pedido || !await acessoPedido.autorizar(pedido.id, req.get('x-order-access-token'))) {
      return res.status(404).json({ erro: 'Pedido não encontrado.' });
    }
    if (pedido.status !== 'pendente') return res.status(409).json({ erro: 'Este pedido não pode mais ser cancelado.', status: pedido.status });

    const iniciandoCancelamento = await db.query("UPDATE pedidos SET status='cancelando' WHERE id=$1 AND status='pendente' RETURNING id", [pedido.id]);
    if (!iniciandoCancelamento.rowCount) return res.status(409).json({ erro: 'O pedido mudou de status e não pode mais ser cancelado.' });
    cancelamentoReservado = true;

    const pagamento = await svc.obterPagamento(pedido.id);
    if (pagamento && !String(pagamento.mp_payment_id).startsWith('simulado-')) {
      if (pagamento.mp_order_id) {
        try {
          await mp.cancelarOrder(pagamento.mp_order_id);
        } catch (e) {
          // Compatibilidade com contas/versões da API que recusam o endpoint
          // de cancelamento da Order, mas aceitam cancelar a transação Pix.
          if (e.httpStatus !== 405) throw e;
          await mp.cancelar(pagamento.mp_payment_id);
        }
      } else await mp.cancelar(pagamento.mp_payment_id);
    }
    if (pagamento) {
      await db.query("UPDATE tentativas_cobranca SET estado='concluida',lease_ate=NULL,atualizado_em=$1 WHERE pedido_id=$2", [Date.now(),pedido.id]);
    } else {
      // Se alguma chamada externa já começou, preserve a tentativa para o job
      // recuperar a Order idempotente e cancelá-la após esta transição.
      await db.query(`UPDATE tentativas_cobranca SET estado='abandonada',lease_ate=NULL,atualizado_em=$1
        WHERE pedido_id=$2 AND estado='pendente' AND tentativas=0`, [Date.now(),pedido.id]);
    }
    if (!await svc.mudarStatus(pedido.id, ['cancelando'], 'cancelado')) {
      return res.status(409).json({ erro: 'O pedido mudou de status e não pode mais ser cancelado.' });
    }
    res.json({ ok: true, status: 'cancelado' });
  } catch (e) {
    if (cancelamentoReservado) await svc.mudarStatus(pedido.id, ['cancelando'], 'pendente').catch(() => {});
    console.error('[cancelamento]', e.message);
    next(e);
  }
});

module.exports = router;
