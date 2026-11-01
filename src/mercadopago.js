const crypto = require('crypto');
const cfg = require('./config');

const API = 'https://api.mercadopago.com';

function chaveCancelamento(orderId) {
  const bytes = crypto.createHash('sha256').update(`bocadinho:cancelar:${orderId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

async function chamar(metodo, caminho, corpo, chaveIdempotencia, cabecalhos = {}) {
  const r = await fetch(API + caminho, {
    method: metodo,
    headers: {
      Authorization: `Bearer ${cfg.mpToken}`,
      'Content-Type': 'application/json',
      ...(chaveIdempotencia ? { 'X-Idempotency-Key': chaveIdempotencia } : {}),
      ...cabecalhos
    },
    body: corpo ? JSON.stringify(corpo) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    const resumo = json?.errors?.map(x => x.code || x.type).filter(Boolean).join(', ')
      || json?.error || '';
    const e = new Error(`Mercado Pago respondeu ${r.status}${resumo ? ` (${String(resumo).slice(0, 180)})` : ''}`);
    e.httpStatus = r.status;
    e.detalhe = {
      errors: Array.isArray(json?.errors) ? json.errors.map(x => ({
        code: x.code,
        type: x.type
      })) : undefined,
      data: json?.data ? {
        id: json.data.id,
        external_reference: json.data.external_reference,
        status: json.data.status,
        status_detail: json.data.status_detail,
        transactions: {
          payments: (json.data.transactions?.payments || []).map(p => ({
            id: p.id,
            status: p.status,
            status_detail: p.status_detail,
            amount: p.amount,
            payment_method: p.payment_method
          }))
        }
      } : undefined
    };
    throw e;
  }
  return json;
}

function itensDaOrder(itens = []) {
  return itens.map(item => ({
    title: item.nome,
    category_id: 'food',
    quantity: Number(item.qtd),
    unit_price: (Number(item.preco_unit_centavos) / 100).toFixed(2)
  }));
}

function dadosDoPagador(cliente, identificacao) {
  const partes = String(cliente.nome || '').trim().split(/\s+/).filter(Boolean);
  const primeiro = partes.shift() || 'Cliente';
  const pagador = {
    email: cliente.email,
    first_name: primeiro,
    ...(partes.length ? { last_name: partes.join(' ') } : {}),
    ...(identificacao ? { identification: identificacao } : {})
  };
  return {
    pagador,
    informacoesAdicionais: cliente.criadoEm ? {
      'payer.registration_date': new Date(Number(cliente.criadoEm)).toISOString()
    } : undefined
  };
}

function falhaFinalCartao(erro, pedidoId) {
  const order = erro?.detalhe?.data;
  const pagamento = order?.transactions?.payments?.[0];
  if (erro?.httpStatus !== 402 || order?.status !== 'failed' ||
      String(order.external_reference || '') !== String(pedidoId) ||
      !order.id || !pagamento?.id) return null;
  return order;
}

/** Cria uma order Pix pelo fluxo de sandbox da Orders API. */
async function criarPix({ pedido, cliente, itens, deviceId, chaveIdempotencia = pedido.id }) {
  // No sandbox do Pix, APRO é o valor oficial que faz a order ser aprovada
  // automaticamente. Em produção, usamos os dados reais do comprador.
  const teste = !cfg.producao;
  const dadosPagador = dadosDoPagador(cliente);
  const pagamento = {
    amount: (pedido.total_centavos / 100).toFixed(2),
    payment_method: { id: 'pix', type: 'bank_transfer' }
  };
  if (!teste) pagamento.expiration_time = `PT${Math.max(30, Math.ceil((pedido.expira_em - Date.now()) / 60000))}M`;

  const o = await chamar('POST', '/v1/orders', {
    type: 'online',
    processing_mode: 'automatic',
    total_amount: (pedido.total_centavos / 100).toFixed(2),
    external_reference: pedido.id,
    config: { statement_descriptor: cfg.mpStatementDescriptor },
    payer: teste ? { ...dadosPagador.pagador, email: 'test_user_br@testuser.com', first_name: 'APRO' } : dadosPagador.pagador,
    ...(dadosPagador.informacoesAdicionais ? { additional_info: dadosPagador.informacoesAdicionais } : {}),
    items: itensDaOrder(itens),
    transactions: { payments: [pagamento] },
  }, chaveIdempotencia, deviceId ? { 'X-meli-session-id': deviceId } : {}); // chave persistida antes da chamada; toda repetição recupera a mesma cobrança

  const p = o.transactions?.payments?.[0] || o.transaction?.payments?.[0];
  const t = p?.payment_method || {};
  const qr = t.qr_code || p?.qr_code || o.qr_code;
  const qrBase64 = t.qr_code_base64 || p?.qr_code_base64 || o.qr_code_base64 || '';
  if (!qr) {
    const e = new Error('Resposta do Mercado Pago sem código Pix');
    e.detalhe = { order_status: o.status, order_status_detail: o.status_detail, payment_status: p?.status, payment_status_detail: p?.status_detail };
    throw e;
  }
  return {
    mpId: p.id,
    mpOrderId: o.id,
    status: p.status || o.status || 'action_required',
    valorCentavos: pedido.total_centavos,
    qr,
    // No sandbox, qr_code_base64 pode vir vazio; o copia-e-cola continua válido.
    qrBase64
  };
}

/** Cria e processa uma order de cartão com o token gerado pelo MercadoPago.js. */
async function criarCartao({ pedido, cliente, itens, dados, deviceId, chaveIdempotencia }) {
  const tipo = dados.payment_type_id === 'debit_card' ? 'debit_card' : 'credit_card';
  const amount = (pedido.total_centavos / 100).toFixed(2);
  const dadosPagador = dadosDoPagador(cliente, dados.payer?.identification);
  try {
    return await chamar('POST', '/v1/orders', {
      type: 'online',
      processing_mode: 'automatic',
      total_amount: amount,
      external_reference: pedido.id,
      config: { statement_descriptor: cfg.mpStatementDescriptor },
      payer: dadosPagador.pagador,
      ...(dadosPagador.informacoesAdicionais ? { additional_info: dadosPagador.informacoesAdicionais } : {}),
      items: itensDaOrder(itens),
      transactions: {
        payments: [{
          amount,
          payment_method: {
            id: dados.payment_method_id,
            type: tipo,
            token: dados.token,
            installments: Number(dados.installments) || 1
          }
        }]
      }
    }, chaveIdempotencia, deviceId ? { 'X-meli-session-id': deviceId } : {});
  } catch (e) {
    const falha = falhaFinalCartao(e, pedido.id);
    if (falha) return falha;
    throw e;
  }
}

const consultarOrder = id => chamar('GET', `/v1/orders/${encodeURIComponent(id)}`);
// Orders API cancela por POST /cancel e exige chave de idempotência.
const cancelarOrder = id => chamar(
  'POST',
  `/v1/orders/${encodeURIComponent(id)}/cancel`,
  undefined,
  chaveCancelamento(id)
);
const consultar = id => chamar('GET', `/v1/payments/${encodeURIComponent(id)}`);
const cancelar = id => chamar('PUT', `/v1/payments/${encodeURIComponent(id)}`, { status: 'cancelled' });

/**
 * Valida o header x-signature do webhook (HMAC-SHA256).
 * Modelo assinado: id:<data.id>;request-id:<x-request-id>;ts:<ts>;
 */
function assinaturaValida(req) {
  const header = req.get('x-signature');
  const requestId = req.get('x-request-id');
  if (!header || !requestId) return false;

  const partes = {};
  header.split(',').forEach(par => {
    const i = par.indexOf('=');
    if (i > 0) partes[par.slice(0, i).trim()] = par.slice(i + 1).trim();
  });
  if (!partes.ts || !partes.v1) return false;

  // O Mercado Pago documenta ts em milissegundos (ex.: 1742505638683).
  // Aceitamos segundos também para manter compatibilidade com entregas antigas.
  if (!/^\d+$/.test(partes.ts)) return false;
  const timestamp = Number(partes.ts);
  const timestampMs = timestamp >= 1e12 ? timestamp : timestamp * 1000;
  if (!Number.isSafeInteger(timestampMs) || Math.abs(Date.now() - timestampMs) > 5 * 60 * 1000) return false;

  let dataId = req.query['data.id'] ?? req.body?.data?.id;
  if (dataId === undefined || dataId === null) return false;
  dataId = String(dataId);
  if (/^[a-z0-9]+$/i.test(dataId)) dataId = dataId.toLowerCase();

  const manifesto = `id:${dataId};request-id:${requestId};ts:${partes.ts};`;
  const esperado = crypto.createHmac('sha256', cfg.mpSegredo).update(manifesto).digest('hex');
  const a = Buffer.from(esperado);
  const b = Buffer.from(partes.v1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { criarPix, criarCartao, consultarOrder, cancelarOrder, consultar, cancelar, assinaturaValida, falhaFinalCartao };
