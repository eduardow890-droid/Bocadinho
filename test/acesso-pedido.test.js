const test = require('node:test');
const assert = require('node:assert/strict');
const { tokenValido, hashToken, expiracaoToken, RETENCAO_ACESSO_MS } = require('../src/acesso-pedido');
const { atrasoRetryMs } = require('../src/politica-retry');

test('aceita tokens de acompanhamento base64url com 256 bits', () => {
  const token = Buffer.alloc(32, 7).toString('base64url');
  assert.equal(token.length, 43);
  assert.equal(tokenValido(token), true);
});

test('rejeita token ausente, curto ou com caracteres fora do formato', () => {
  assert.equal(tokenValido(undefined), false);
  assert.equal(tokenValido('abc'), false);
  assert.equal(tokenValido('!'.repeat(43)), false);
});

test('armazena hash estável diferente do segredo original', () => {
  const token = Buffer.alloc(32, 9).toString('base64url');
  const hash = hashToken(token);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.notEqual(hash, token);
  assert.equal(hashToken(token), hash);
  assert.notEqual(hashToken(Buffer.alloc(32, 8).toString('base64url')), hash);
  assert.equal(hashToken('segredo-inválido'), null);
});

test('prazo de acesso tem duração de 90 dias', () => {
  const criadoEm = 1_800_000_000_000;
  assert.equal(expiracaoToken(criadoEm), criadoEm + RETENCAO_ACESSO_MS);
});

test('retries de cobrança usam espera crescente com limite de quinze minutos', () => {
  assert.equal(atrasoRetryMs(1), 30_000);
  assert.equal(atrasoRetryMs(2), 60_000);
  assert.equal(atrasoRetryMs(20), 15 * 60 * 1000);
});