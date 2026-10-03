const db = require('./db');
const mp = require('./mercadopago');
const svc = require('./pedidos');
const { processarPagamento } = require('./pagamentos');

let rodando = false;

/**
 * Rede de segurança: webhooks podem falhar.
 * A cada minuto confere pedidos pendentes direto no Mercado Pago e expira os vencidos.
 */
async function reconciliar() {
  if (rodando) return;
  rodando = true;
  try {
    const pendentes = (await db.query(`
      SELECT p.id, p.expira_em, pg.mp_payment_id, pg.mp_order_id
      FROM pedidos p LEFT JOIN pagamentos pg ON pg.pedido_id = p.id
      WHERE p.status = 'pendente' ORDER BY p.criado_em LIMIT 50`)).rows;

    for (const ped of pendentes) {
      try {
        if (!ped.mp_payment_id) { // cobrança nunca foi criada
          if (ped.expira_em < Date.now()) await svc.mudarStatus(ped.id, ['pendente'], 'cancelado');
          continue;
        }
        if (String(ped.mp_payment_id).startsWith('simulado-')) continue;
        await processarPagamento(ped.mp_order_id || ped.mp_payment_id);
        const atual = await svc.obterPedido(ped.id);
        if (atual.status === 'pendente' && atual.expira_em < Date.now()) {
          await svc.mudarStatus(ped.id, ['pendente'], 'expirado');
          if (ped.mp_order_id) await mp.cancelarOrder(ped.mp_order_id).catch(() => {}); // melhor esforço
        }
      } catch (e) {
        console.error(`[job] pedido ${ped.id}:`, e.message);
      }
    }
  } finally {
    rodando = false;
  }
}

function iniciarJobs() {
  setInterval(() => reconciliar().catch(e => console.error('[job]', e)), 60 * 1000).unref();
}

module.exports = { iniciarJobs, reconciliar };
