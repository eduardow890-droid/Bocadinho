const router = require('express').Router();
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const cfg = require('../config');
const svc = require('../pedidos');
const mp = require('../mercadopago');
const { criarPedidoSchema, formatarErros, UUID } = require('../validacao');
const acessoPedido = require('../acesso-pedido');
const cobrancas = require('../cobrancas');
const clientes = require('../clientes');

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

// Apenas a chave pública pode chegar ao navegador.
router.get('/config', (req, res) => res.json({ mpPublicKey: cfg.mpPublicKey }));

// Cria pedido + cobrança Pix
router.post('/pedidos', limiteCriar, clientes.carregarCliente, async (req, res, next) => {
  const r = criarPedidoSchema.safeParse(req.body);
  if (!r.success) return res.status(400).json(formatarErros(r.error));
  const tokenAcesso = req.get('x-order-access-token');
  if (!acessoPedido.tokenValido(tokenAcesso)) {
    return res.status(400).json({ erro: 'Não foi possível proteger o acompanhamento. Recarregue a página e tente novamente.' });
  }

  let pedido;
  try {
    pedido = await svc.criarPedido(r.data, cfg.pixExpiraMin, tokenAcesso, req.cliente || null);
  } catch (e) {
    if (e instanceof svc.ErroNegocio) return res.status(e.status).json({ erro: e.message });
    return next(e);
  }

  try {
    if (r.data.metodoPagamento === 'pix') {
      await cobrancas.gerarParaPedido(pedido.id, req.get('x-meli-session-id') || '');
    }
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

const limiteCartao = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: true, legacyHeaders: false,
  message: { erro: 'Muitas tentativas de cartão. Aguarde alguns minutos.' }
});

// Recebe somente dados tokenizados pelo MercadoPago.js; nunca recebe número/CVV do cartão.
router.post('/pedidos/:id/cartao', limiteCartao, async (req, res, next) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(404).json({ erro: 'Pedido não encontrado.' });
    const pedido = await svc.obterPedido(req.params.id);
    if (!pedido || !await acessoPedido.autorizar(pedido.id, req.get('x-order-access-token'))) {
      return res.status(404).json({ erro: 'Pedido não encontrado.' });
    }
    if (pedido.status !== 'pendente') return res.status(409).json({ erro: 'Este pedido não está aguardando pagamento.' });
    if (Number(pedido.expira_em) <= Date.now()) return res.status(409).json({ erro: 'Este pedido expirou. Faça um novo pedido.' });

    // O e-mail confiável é o que foi confirmado na criação do pedido. O Brick
    // possui um campo próprio de e-mail e pode devolvê-lo com outra formatação
    // ou valor; nunca devemos rejeitar o pagamento por essa duplicação de UI.
    const dados = {
      ...(req.body || {}),
      payer: { ...((req.body || {}).payer || {}), email: pedido.email }
    };
    const deviceId = req.get('x-meli-session-id') || '';
    // O token é opaco e o formato/tamanho pode mudar entre versões do Brick.
    // Validamos apenas que é um valor textual não vazio; o número do cartão
    // nunca chega a esta rota.
    if (!/^[a-z0-9_.-]{1,64}$/i.test(String(dados.payment_method_id || '')) ||
        !/^\S{1,500}$/.test(String(dados.token || '')) ||
        !Number.isInteger(Number(dados.installments)) || Number(dados.installments) < 1 || Number(dados.installments) > 24) {
      return res.status(400).json({ erro: 'Dados do cartão inválidos. Tente novamente.' });
    }
    const order = await mp.criarCartao({
      pedido,
      cliente: { email: pedido.email, nome: pedido.nome },
      itens: await svc.obterItens(pedido.id),
      dados,
      deviceId,
      // O mesmo token pode ser reenviado com segurança; um cartão diferente
      // recebe outra chave e pode ser tentado após uma recusa.
      chaveIdempotencia: `${pedido.id}-cartao-${crypto.createHash('sha256').update(String(dados.token)).digest('hex').slice(0, 24)}`
    });
    const pagamento = order.transactions?.payments?.[0];
    if (!order.id || !pagamento?.id) throw new Error('Resposta do Mercado Pago sem transação de cartão.');

    await db.query(`INSERT INTO pagamentos
      (pedido_id,mp_payment_id,mp_order_id,status,valor_centavos,qr_code,qr_base64,criado_em)
      VALUES ($1,$2,$3,$4,$5,NULL,NULL,$6)
      ON CONFLICT (mp_payment_id) DO UPDATE SET status=EXCLUDED.status`,
    [pedido.id, String(pagamento.id), String(order.id), pagamento.status || order.status || 'pending', pedido.total_centavos, Date.now()]);
    await db.query(`UPDATE pagamentos SET metodo_pagamento=$1 WHERE pedido_id=$2`, [dados.payment_type_id === 'debit_card' ? 'debit_card' : 'credit_card', pedido.id]);
    await db.query(`UPDATE tentativas_cobranca SET estado='concluida',lease_ate=NULL,ultimo_erro=NULL,atualizado_em=$1 WHERE pedido_id=$2`, [Date.now(), pedido.id]);

    // O webhook continua sendo a fonte oficial; esta consulta reduz a latência da confirmação.
    await require('../pagamentos').processarPagamento(String(order.id));
    const atualizado = await svc.obterPedido(pedido.id);
    res.set('Cache-Control', 'no-store').json({ ...(await svc.visaoPublica(atualizado)), pagamento: 'cartao' });
  } catch (e) {
    if (e.httpStatus === 400 || e.httpStatus === 401 || e.httpStatus === 422) {
      return res.status(422).json({ erro: 'O Mercado Pago recusou os dados do cartão. Confira os dados ou tente outro cartão.' });
    }
    next(e);
  }
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
