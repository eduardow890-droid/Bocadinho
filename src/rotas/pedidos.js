const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const db = require('../db');
const cfg = require('../config');
const svc = require('../pedidos');
const mp = require('../mercadopago');
const { criarPedidoSchema, formatarErros, UUID } = require('../validacao');

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
  try { res.json((await db.query('SELECT id,nome,descricao,preco_centavos FROM produtos WHERE ativo=TRUE ORDER BY id')).rows); }
  catch (e) { next(e); }
});

// Cria pedido + cobrança Pix
router.post('/pedidos', limiteCriar, async (req, res, next) => {
  const r = criarPedidoSchema.safeParse(req.body);
  if (!r.success) return res.status(400).json(formatarErros(r.error));

  let pedido;
  try {
    pedido = await svc.criarPedido(r.data, cfg.pixExpiraMin);
  } catch (e) {
    if (e instanceof svc.ErroNegocio) return res.status(e.status).json({ erro: e.message });
    return next(e);
  }

  try {
    const cobranca = cfg.pagamentoSimulado
      ? {
          mpId: `simulado-${pedido.id}`,
          status: 'pending',
          valorCentavos: pedido.total_centavos,
          qr: `SIMULADO-${pedido.id}`,
          qrBase64: ''
        }
      : await mp.criarPix({ pedido, cliente: r.data });
    await svc.registrarPagamento(pedido.id, cobranca);
    res.status(201).json(await svc.visaoPublica(await svc.obterPedido(pedido.id)));
  } catch (e) {
    console.error(`[pix] falha ao criar cobrança para pedido ${pedido.id.slice(0, 8)} (HTTP ${e.httpStatus || 'indisponível'}).`);
    await svc.mudarStatus(pedido.id, ['pendente'], 'cancelado');
    res.status(502).json({ erro: 'Não foi possível gerar o Pix agora. Tente novamente em instantes.' });
  }
});

// Consulta de status (o site faz polling nesta rota)
router.get('/pedidos/:id', limiteConsulta, async (req, res, next) => {
  if (!UUID.test(req.params.id)) return res.status(404).json({ erro: 'Pedido não encontrado.' });
  try {
    const pedido = await svc.obterPedido(req.params.id);
    if (!pedido) return res.status(404).json({ erro: 'Pedido não encontrado.' });
    res.json(await svc.visaoPublica(pedido));
  } catch (e) { next(e); }
});

const limiteCancelamento = rateLimit({
  windowMs: 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false,
  message: { erro: 'Muitas tentativas. Aguarde um instante.' }
});

router.post('/pedidos/:id/cancelar', limiteCancelamento, async (req, res, next) => {
  if (!UUID.test(req.params.id)) return res.status(404).json({ erro: 'Pedido não encontrado.' });
  const pedido = await svc.obterPedido(req.params.id);
  if (!pedido) return res.status(404).json({ erro: 'Pedido não encontrado.' });
  if (pedido.status !== 'pendente') return res.status(409).json({ erro: 'Este pedido não pode mais ser cancelado.', status: pedido.status });

  try {
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
    if (!await svc.mudarStatus(pedido.id, ['pendente'], 'cancelado')) {
      return res.status(409).json({ erro: 'O pedido mudou de status e não pode mais ser cancelado.' });
    }
    res.json({ ok: true, status: 'cancelado' });
  } catch (e) {
    console.error('[cancelamento]', e.message);
    next(e);
  }
});

module.exports = router;
