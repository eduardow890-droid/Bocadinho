const db = require('./db');
const cfg = require('./config');
const mp = require('./mercadopago');
const svc = require('./pedidos');
const { atrasoRetryMs } = require('./politica-retry');

const DURACAO_LEASE_MS = 60 * 1000;
const ESTADOS_NAO_ATIVOS = new Set(['cancelando', 'cancelado', 'expirado']);

async function cancelarPagamentoRemoto(pagamento) {
  if (!pagamento || String(pagamento.mp_payment_id).startsWith('simulado-')) return;
  if (!pagamento.mp_order_id) return mp.cancelar(pagamento.mp_payment_id);
  try {
    await mp.cancelarOrder(pagamento.mp_order_id);
  } catch (e) {
    if (e.httpStatus !== 405) throw e;
    await mp.cancelar(pagamento.mp_payment_id);
  }
}

async function registrarFalha(pedidoId, tentativas, erro) {
  const atraso = atrasoRetryMs(tentativas);
  await db.query(`UPDATE tentativas_cobranca
    SET estado='pendente',proxima_tentativa=$1,lease_ate=NULL,ultimo_erro=$2,atualizado_em=$3
    WHERE pedido_id=$4 AND estado IN ('processando','cancelamento_pendente')`,
  [Date.now() + atraso, String(erro.message || 'Falha ao gerar Pix').slice(0, 240), Date.now(), pedidoId]);
}

async function gerarParaPedido(pedidoId) {
  const agora = Date.now();
  const estadoInicial = await svc.obterPedido(pedidoId);
  if (!estadoInicial) return { pronto: false, em_processamento: false };
  const pagamentoInicial = await svc.obterPagamento(pedidoId);
  if (pagamentoInicial && estadoInicial.status === 'pendente') return { pronto: true, pagamento: pagamentoInicial };
  if (pagamentoInicial && ESTADOS_NAO_ATIVOS.has(estadoInicial.status)) {
    await db.query(`UPDATE tentativas_cobranca SET estado='cancelamento_pendente',proxima_tentativa=$1,
      lease_ate=NULL,atualizado_em=$1 WHERE pedido_id=$2 AND estado='concluida'`, [agora,pedidoId]);
  }

  const tentativa = (await db.query(`UPDATE tentativas_cobranca t
    SET estado='processando',tentativas=tentativas+1,lease_ate=$1,atualizado_em=$2
    FROM pedidos p
    WHERE t.pedido_id=$3 AND p.id=t.pedido_id
      AND t.proxima_tentativa<=$2
      AND (t.estado IN ('pendente','cancelamento_pendente')
        OR (t.estado='processando' AND COALESCE(t.lease_ate,0)<=$2))
      AND ((p.status='pendente' AND p.expira_em>$2)
        OR (p.status IN ('cancelando','cancelado','expirado') AND t.tentativas>0))
    RETURNING t.chave_idempotencia,t.tentativas`,
  [agora + DURACAO_LEASE_MS, agora, pedidoId])).rows[0];

  if (!tentativa) {
    const pagamento = await svc.obterPagamento(pedidoId);
    return { pronto: Boolean(pagamento && estadoInicial.status === 'pendente'), pagamento: pagamento || null, em_processamento: !pagamento };
  }

  const pedido = await svc.obterPedido(pedidoId);
  if (!pedido) {
    await db.query(`UPDATE tentativas_cobranca SET estado='abandonada',lease_ate=NULL,atualizado_em=$1
      WHERE pedido_id=$2 AND estado='processando'`, [Date.now(),pedidoId]);
    return { pronto: false, em_processamento: false };
  }

  try {
    let pagamento = await svc.obterPagamento(pedidoId);
    if (!pagamento) {
      const pedidoAtivo = pedido.status === 'pendente' && Number(pedido.expira_em) > Date.now();
      const recuperandoPossivelRemota = ESTADOS_NAO_ATIVOS.has(pedido.status) && Number(tentativa.tentativas) > 1;
      if (!pedidoAtivo && !recuperandoPossivelRemota) {
        await db.query(`UPDATE tentativas_cobranca SET estado='abandonada',lease_ate=NULL,atualizado_em=$1
          WHERE pedido_id=$2 AND estado='processando'`, [Date.now(),pedidoId]);
        return { pronto: false, em_processamento: false };
      }

      const cobranca = cfg.pagamentoSimulado
        ? {
            mpId: `simulado-${pedido.id}`,
            status: 'pending',
            valorCentavos: pedido.total_centavos,
            qr: `SIMULADO-${pedido.id}`,
            qrBase64: ''
          }
        : await mp.criarPix({
            pedido,
            cliente: { email: pedido.email, nome: pedido.nome },
            chaveIdempotencia: tentativa.chave_idempotencia
          });

      await db.withTransaction(async client => {
        const pagamentoAtual = (await client.query('SELECT mp_payment_id FROM pagamentos WHERE pedido_id=$1 FOR UPDATE', [pedidoId])).rows[0];
        if (pagamentoAtual && String(pagamentoAtual.mp_payment_id) !== String(cobranca.mpId)) {
          throw new Error('A chave idempotente retornou uma cobrança diferente da já vinculada.');
        }
        if (!pagamentoAtual) {
          await client.query(`INSERT INTO pagamentos
            (pedido_id,mp_payment_id,mp_order_id,status,valor_centavos,qr_code,qr_base64,criado_em)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [pedidoId,String(cobranca.mpId),cobranca.mpOrderId ? String(cobranca.mpOrderId) : null,
            cobranca.status,cobranca.valorCentavos,cobranca.qr,cobranca.qrBase64,Date.now()]);
        }
      });
      pagamento = await svc.obterPagamento(pedidoId);
    }

    const estadoFinal = await svc.obterPedido(pedidoId);
    if (estadoFinal && ESTADOS_NAO_ATIVOS.has(estadoFinal.status)) {
      await cancelarPagamentoRemoto(pagamento);
      await db.query(`UPDATE tentativas_cobranca
        SET estado='concluida',lease_ate=NULL,ultimo_erro=NULL,atualizado_em=$1 WHERE pedido_id=$2`,
      [Date.now(),pedidoId]);
      return { pronto: false, pagamento, em_processamento: false };
    }
    await db.query(`UPDATE tentativas_cobranca
      SET estado='concluida',lease_ate=NULL,ultimo_erro=NULL,atualizado_em=$1 WHERE pedido_id=$2`,
    [Date.now(),pedidoId]);
    return { pronto: true, pagamento };
  } catch (e) {
    await registrarFalha(pedidoId, Number(tentativa.tentativas), e).catch(err => {
      console.error('[cobranca] não foi possível agendar nova tentativa:', err.message);
    });
    throw e;
  }
}

async function processarPendentes(limite = 50) {
  const agora = Date.now();
  const rows = (await db.query(`SELECT t.pedido_id
    FROM tentativas_cobranca t JOIN pedidos p ON p.id=t.pedido_id
    WHERE t.proxima_tentativa<=$1
      AND (t.estado IN ('pendente','cancelamento_pendente')
        OR (t.estado='processando' AND COALESCE(t.lease_ate,0)<=$1))
      AND ((p.status='pendente' AND p.expira_em>$1)
        OR (p.status IN ('cancelando','cancelado','expirado') AND t.tentativas>0))
    ORDER BY t.proxima_tentativa,t.criado_em LIMIT $2`, [agora,limite])).rows;
  for (const row of rows) {
    await gerarParaPedido(row.pedido_id).catch(e => {
      console.error(`[cobranca] falha ao recuperar pedido ${String(row.pedido_id).slice(0, 8)}:`, e.message);
    });
  }
}

module.exports = { gerarParaPedido, processarPendentes };