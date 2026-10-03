const router = require('express').Router();
const db = require('../db');
const mp = require('../mercadopago');
const { processarPagamento } = require('../pagamentos');

router.post('/mercadopago', async (req, res, next) => {
  // 1) autenticidade: só o Mercado Pago conhece o segredo
  if (!mp.assinaturaValida(req)) return res.sendStatus(401);

  const tipo = req.body?.type || req.query.type || req.query.topic;
  const id = req.query['data.id'] ?? req.body?.data?.id;

  try {
    // Persiste antes do 200 para que falhas de banco acionem a retentativa do MP.
    const evento = await db.query(`
      INSERT INTO eventos_webhook (request_id,tipo,referencia,criado_em)
      VALUES ($1,$2,$3,$4) ON CONFLICT (request_id) DO NOTHING RETURNING id`,
    [req.get('x-request-id'), String(tipo || ''), String(id || ''), Date.now()]);

    // Uma entrega repetida já foi registrada e processada (ou será reconciliada pelo job).
    if (!evento.rowCount) return res.sendStatus(200);
    res.sendStatus(200);

    if (['payment', 'order', 'orders', 'merchant_order'].includes(tipo) && id) {
      // 3) nunca confia no corpo: consulta a order diretamente na API do MP
      processarPagamento(String(id)).catch(e => console.error('[webhook] falha ao processar evento:', e.message));
    }
  } catch (e) {
    next(e);
  }
});

module.exports = router;
