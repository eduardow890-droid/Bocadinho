const crypto = require('crypto');

const FORMATO_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const RETENCAO_ACESSO_MS = 90 * 24 * 60 * 60 * 1000;
const banco = () => require('./db');

function tokenValido(token) {
  return typeof token === 'string' && FORMATO_TOKEN.test(token);
}

function hashToken(token) {
  if (!tokenValido(token)) return null;
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function autorizar(pedidoId, token) {
  const db = banco();
  const registro = (await db.query(
    'SELECT token_hash,expira_em,revogado_em FROM acesso_pedido WHERE pedido_id=$1',
    [pedidoId]
  )).rows[0];

  // Compatibilidade limitada a 90 dias para pedidos anteriores à migração.
  if (!registro) {
    if (typeof token !== 'string' || token !== pedidoId) return false;
    const pedidoLegado = (await db.query('SELECT criado_em FROM pedidos WHERE id=$1', [pedidoId])).rows[0];
    return Boolean(pedidoLegado && Date.now() < expiracaoToken(Number(pedidoLegado.criado_em)));
  }
  if (registro.revogado_em || Number(registro.expira_em) <= Date.now()) return false;

  const hash = hashToken(token);
  if (!hash) return false;
  const a = Buffer.from(registro.token_hash, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function buscarPorToken(token) {
  const hash = hashToken(token);
  if (!hash) return null;
  const result = await banco().query(`
    SELECT p.* FROM acesso_pedido a JOIN pedidos p ON p.id=a.pedido_id
    WHERE a.token_hash=$1 AND a.revogado_em IS NULL AND a.expira_em>$2`,
  [hash, Date.now()]);
  return result.rows[0] || null;
}

async function revogar(pedidoId) {
  const resultado = await banco().query(`UPDATE acesso_pedido SET revogado_em=$1
    WHERE pedido_id=$2 AND revogado_em IS NULL`, [Date.now(),pedidoId]);
  return resultado.rowCount === 1;
}

function expiracaoToken(criadoEm) {
  return criadoEm + RETENCAO_ACESSO_MS;
}

module.exports = { tokenValido, hashToken, autorizar, buscarPorToken, revogar, expiracaoToken, RETENCAO_ACESSO_MS };