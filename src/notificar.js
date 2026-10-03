/** Chamado UMA vez quando um pedido é confirmado como pago. */
async function notificarLoja(pedido) {
  console.log(`[notificacao] pedido ${pedido.id.slice(0, 8)} confirmado como pago.`);
  // TODO: enviar e-mail (nodemailer), Telegram, ou outro canal que você preferir.
}

module.exports = { notificarLoja };
