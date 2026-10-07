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
  mpSegredo: exigir('MP_WEBHOOK_SECRET'),
  adminToken: exigir('ADMIN_TOKEN'),
  pagamentoSimulado: process.env.PAGAMENTO_SIMULADO === 'true' && process.env.NODE_ENV !== 'production',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  // o Mercado Pago exige um prazo mínimo para o Pix; confira a documentação
  pixExpiraMin: Math.max(30, Number(process.env.PIX_EXPIRA_MIN || 30)),
  databaseUrl: process.env.DATABASE_URL || '',
  limitePedidoCentavos: 500000 // R$ 5.000 por pedido
};
