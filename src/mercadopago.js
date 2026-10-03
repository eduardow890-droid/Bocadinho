const crypto = require('crypto');
const cfg = require('./config');

const API = 'https://api.mercadopago.com';

async function chamar(metodo, caminho, corpo, chaveIdempotencia) {
  const r = await fetch(API + caminho, {
    method: metodo,
    headers: {
      Authorization: `Bearer ${cfg.mpToken}`,
      'Content-Type': 'application/json',
      ...(chaveIdempotencia ? { 'X-Idempotency-Key': chaveIdempotencia } : {})
    },
    body: corpo ? JSON.stringify(corpo) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(`Mercado Pago respondeu ${r.status}`);
    e.httpStatus = r.status;
    e.detalhe = json;
    throw e;
  }
  return json;
}

/** Cria uma order Pix pelo fluxo de sandbox da Orders API. */
async function criarPix({ pedido, cliente }) {
  // No sandbox do Pix, APRO é o valor oficial que faz a order ser aprovada
  // automaticamente. Em produção, usamos os dados reais do comprador.
  const teste = !cfg.producao;
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
    payer: {
      email: teste ? 'test_user_br@testuser.com' : cliente.email,
      first_name: teste ? 'APRO' : cliente.nome.split(' ')[0]
    },
    transactions: { payments: [pagamento] },
  }, pedido.id); // idempotência: mesma chave = mesma cobrança, mesmo se repetir a chamada

  const p = o.transactions?.payments?.[0];
  const t = p?.payment_method;
  if (!t?.qr_code) throw new Error('Resposta do Mercado Pago sem código Pix');
  return {
    mpId: p.id,
    mpOrderId: o.id,
    status: p.status || o.status || 'action_required',
    valorCentavos: pedido.total_centavos,
    qr: t.qr_code,
    // No sandbox, qr_code_base64 pode vir vazio; o copia-e-cola continua válido.
    qrBase64: t.qr_code_base64 || ''
  };
}

const consultarOrder = id => chamar('GET', `/v1/orders/${encodeURIComponent(id)}`);
// Orders API cancela por POST /cancel e exige chave de idempotência.
const cancelarOrder = id => chamar(
  'POST',
  `/v1/orders/${encodeURIComponent(id)}/cancel`,
  undefined,
  crypto.randomUUID()
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

  // O Mercado Pago envia ts como Unix epoch em segundos. Rejeita assinaturas
  // antigas ou com relógio muito fora de sincronia para reduzir replay.
  if (!/^\d+$/.test(partes.ts)) return false;
  const timestampMs = Number(partes.ts) * 1000;
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

module.exports = { criarPix, consultarOrder, cancelarOrder, consultar, cancelar, assinaturaValida };
