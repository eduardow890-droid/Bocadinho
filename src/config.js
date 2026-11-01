require('dotenv').config();

function exigir(nome) {
  const valor = process.env[nome];
  if (!valor) {
    console.error(`Variável ${nome} ausente no .env`);
    process.exit(1);
  }
  return valor;
}

module.exports = {
  porta: Number(process.env.PORT || 3000),
  producao: process.env.NODE_ENV === 'production',
  baseUrl: exigir('BASE_URL').replace(/\/$/, ''),
  mpToken: exigir('MP_ACCESS_TOKEN'),
  mpPublicKey: process.env.MP_PUBLIC_KEY || '',
  // O Orders API aceita até 13 caracteres no nome exibido no extrato.
  mpStatementDescriptor: (process.env.MP_STATEMENT_DESCRIPTOR || 'BOCADINHO').trim().slice(0, 13),
  mpSegredo: exigir('MP_WEBHOOK_SECRET'),
  adminToken: exigir('ADMIN_TOKEN'),
  pagamentoSimulado: process.env.PAGAMENTO_SIMULADO === 'true' && process.env.NODE_ENV !== 'production',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  // o Mercado Pago exige um prazo mínimo para o Pix; confira a documentação
  pixExpiraMin: Math.max(30, Number(process.env.PIX_EXPIRA_MIN || 30)),
  databaseUrl: process.env.DATABASE_URL || '',
  limitePedidoCentavos: 500000, // R$ 5.000 por pedido
  // Fidelidade: a cada FIDELIDADE_META pedidos pagos, o cliente cadastrado ganha 1 brinde no pedido seguinte.
  fidelidadeMeta: Math.max(2, Number(process.env.FIDELIDADE_META || 10)),
  fidelidadeProdutoId: process.env.FIDELIDADE_PRODUTO_ID || 'c1',
  sessaoDias: 30
};
