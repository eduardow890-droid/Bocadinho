const db = require('./db');
const mp = require('./mercadopago');
const svc = require('./pedidos');
const { notificarLoja } = require('./notificar');

const pagos = new Set(['approved', 'processed', 'completed', 'closed']);
const estornados = new Set(['refunded', 'charged_back']);

/** Consulta a order no Mercado Pago e confirma o pedido de forma idempotente. */
async function processarPagamento(referencia) {
  let pag = (await db.query('SELECT * FROM pagamentos WHERE mp_order_id=$1', [String(referencia)])).rows[0];
  if (!pag) pag = (await db.query('SELECT * FROM pagamentos WHERE mp_payment_id=$1', [String(referencia)])).rows[0];
  if (!pag || !pag.mp_order_id) {
    console.warn(`[pagamento] ${referencia} não corresponde a uma order nossa. Ignorado.`);
    return;
  }

  const order = await mp.consultarOrder(pag.mp_order_id);
  const pedido = await svc.obterPedido(pag.pedido_id);
  if (!pedido) return;

  const pagamentosOrder = order.transactions?.payments || [];
  const p = pagamentosOrder.find(x => String(x.id) === String(pag.mp_payment_id));
  const ordemConfere = String(order.id) === String(pag.mp_order_id)
    && String(order.external_reference || '') === String(pedido.id);
  if (!ordemConfere || !p) {
    console.error(`[pagamento] vínculo inconsistente na order para pedido ${pedido.id.slice(0, 8)}; encaminhado para revisão.`);
    await svc.mudarStatus(pedido.id, ['pendente'], 'revisar');
    return;
  }

  const status = p.status || order.status || 'unknown';
  await db.query('UPDATE pagamentos SET status=$1 WHERE id=$2', [status, pag.id]);

  if (estornados.has(status)) {
    if (await svc.mudarStatus(pedido.id, ['pago', 'em_preparo', 'enviado', 'concluido'], 'estornado')) {
      console.warn(`[pagamento] pedido ${pedido.id} ESTORNADO (${status}).`);
    }
    return;
  }
  if (!pagos.has(status)) return;

  const valor = Number(p.amount);
  const metodo = p.payment_method?.id || p.payment_method_id;
  const valorOk = Number.isFinite(valor) && Math.round(valor * 100) === pedido.total_centavos;
  if (metodo !== 'pix' || !valorOk) {
    console.error(`[pagamento] valor ou método divergente para pedido ${pedido.id.slice(0, 8)}; encaminhado para revisão.`);
    await svc.mudarStatus(pedido.id, ['pendente'], 'revisar');
    return;
  }

  if (await svc.marcarPago(pedido.id)) {
    console.log(`[pagamento] pedido ${pedido.id.slice(0, 8)} pago.`);
    await notificarLoja(await svc.obterPedido(pedido.id));
  } else if (['expirado', 'cancelado'].includes(pedido.status)) {
    await svc.mudarStatus(pedido.id, ['expirado', 'cancelado'], 'revisar');
    console.error(`[pagamento] pedido ${pedido.id.slice(0, 8)} foi pago após expirar/cancelar. Revisar.`);
  }
}

module.exports = { processarPagamento };
