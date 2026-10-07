const cfg = require('./config');

/** Chamado uma vez quando um pedido é confirmado como pago. */
async function notificarLoja(pedido) {
  const codigo = pedido.id.slice(0, 8);
  const base = `[notificacao] pedido ${codigo} confirmado como pago.`;
  if (!cfg.telegramBotToken || !cfg.telegramChatId) return console.log(base);

  const total = (Number(pedido.total_centavos || 0) / 100).toLocaleString('pt-BR', {
    style: 'currency', currency: 'BRL'
  });
  const tipo = pedido.tipo === 'entrega' ? 'Entrega' : 'Retirada';
  const texto = [
    '🍪 Novo pedido pago na Bocadinho!', '',
    `Pedido: #${codigo}`,
    `Cliente: ${pedido.nome || 'não informado'}`,
    `Total: ${total}`,
    `Tipo: ${tipo}`,
    '', 'Acesse o painel administrativo para ver os detalhes.'
  ].join('\n');

  try {
    const resposta = await fetch(`https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.telegramChatId, text: texto }),
      signal: AbortSignal.timeout(8000)
    });
    const corpo = await resposta.json().catch(() => ({}));
    if (!resposta.ok || !corpo.ok) throw new Error(corpo.description || `HTTP ${resposta.status}`);
    console.log(`${base} Telegram enviado.`);
  } catch (e) {
    console.error(`${base} falha no Telegram: ${e.message}`);
  }
}

module.exports = { notificarLoja };
