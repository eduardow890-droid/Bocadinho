const test = require('node:test');
const assert = require('node:assert/strict');

process.env.BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
process.env.MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || 'test-token';
process.env.MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET || 'test-secret';
process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test-admin-token';

const { falhaFinalCartao } = require('../src/mercadopago');

const pedidoId = 'cfde3b7f-067d-4d3b-91bd-1cea7b31c306';
const respostaFalha = {
  httpStatus: 402,
  detalhe: {
    data: {
      id: 'ORDTST01M6CGKCHV87ABT9HBMQ8VYEF3',
      external_reference: pedidoId,
      status: 'failed',
      transactions: { payments: [{ id: '123456789', status: 'rejected' }] }
    }
  }
};

test('reconhece Order de cartão recusada associada ao pedido local', () => {
  assert.equal(falhaFinalCartao(respostaFalha, pedidoId), respostaFalha.detalhe.data);
});

test('não associa falha de cartão de outro pedido', () => {
  assert.equal(falhaFinalCartao(respostaFalha, 'outro-pedido'), null);
});

test('não converte erros que não sejam Order recusada HTTP 402', () => {
  assert.equal(falhaFinalCartao({ ...respostaFalha, httpStatus: 500 }, pedidoId), null);
  assert.equal(falhaFinalCartao({
    ...respostaFalha,
    detalhe: { data: { ...respostaFalha.detalhe.data, status: 'processing' } }
  }, pedidoId), null);
  assert.equal(falhaFinalCartao({
    ...respostaFalha,
    detalhe: { data: { ...respostaFalha.detalhe.data, transactions: { payments: [] } } }
  }, pedidoId), null);
});
