const crypto = require('crypto');
const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const db = require('../db');
const cfg = require('../config');
const svc = require('../pedidos');
const { notificarLoja } = require('../notificar');
const { UUID } = require('../validacao');

router.use(rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false }));

// Autenticação simples por token (header x-admin-token)
router.use((req, res, next) => {
  const enviado = Buffer.from(String(req.get('x-admin-token') || ''));
  const correto = Buffer.from(cfg.adminToken);
  if (enviado.length !== correto.length || !crypto.timingSafeEqual(enviado, correto)) {
    return res.status(401).json({ erro: 'Não autorizado.' });
  }
  next();
});

// Lista pedidos: /api/admin/pedidos?status=pago
router.get('/pedidos', async (req, res, next) => {
 try {
  const status = String(req.query.status || '');
  const sql = `SELECT * FROM pedidos ${status ? 'WHERE status=$1' : ''} ORDER BY criado_em DESC LIMIT 100`;
  const pedidos = (await db.query(sql, status ? [status] : [])).rows;
  res.json(await Promise.all(pedidos.map(async p => ({ ...p, itens: (await db.query('SELECT nome,qtd,preco_unit_centavos FROM pedido_itens WHERE pedido_id=$1', [p.id])).rows }))));
 } catch (e) { next(e); }
});

router.get('/pedidos/:id', async (req, res, next) => {
 try {
  if (!UUID.test(req.params.id)) return res.status(400).json({ erro: 'Pedido inválido.' });
  const pedido = (await db.query('SELECT * FROM pedidos WHERE id=$1', [req.params.id])).rows[0];
  if (!pedido) return res.status(404).json({ erro: 'Pedido não encontrado.' });
  const itens = (await db.query('SELECT nome,qtd,preco_unit_centavos FROM pedido_itens WHERE pedido_id=$1', [pedido.id])).rows;
  res.json({ ...pedido, itens });
 } catch (e) { next(e); }
});

function inicioDoDiaSaoPaulo() {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const data = Object.fromEntries(partes.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return Date.parse(`${data.year}-${data.month}-${data.day}T00:00:00-03:00`);
}

router.get('/resumo', async (req, res, next) => {
 try {
  const contagens = (await db.query('SELECT status, COUNT(*)::int AS quantidade FROM pedidos GROUP BY status')).rows;
  const inicio = inicioDoDiaSaoPaulo();
  const fim = inicio + 24 * 60 * 60 * 1000;
  const dia = (await db.query(`
    SELECT COUNT(*)::int AS quantidade, COALESCE(SUM(total_centavos),0)::int AS total_centavos
    FROM pedidos WHERE pago_em >= $1 AND pago_em < $2`, [inicio, fim])).rows[0];
  res.json({
    por_status: Object.fromEntries(contagens.map(c => [c.status, c.quantidade])),
    pagos_hoje: { quantidade: dia.quantidade, total_centavos: dia.total_centavos }
  });
 } catch (e) { next(e); }
});

// Avança o andamento: pago → em_preparo → enviado → concluido
const FLUXO = { em_preparo: ['pago'], enviado: ['em_preparo'], concluido: ['enviado', 'em_preparo'] };
router.patch('/pedidos/:id/status', async (req, res, next) => {
 try {
  const novo = req.body?.status;
  if (!UUID.test(req.params.id) || !FLUXO[novo]) return res.status(400).json({ erro: 'Requisição inválida.' });
  const ok = await svc.mudarStatus(req.params.id, FLUXO[novo], novo);
  if (!ok) return res.status(409).json({ erro: 'Transição de status não permitida.' });
  res.json({ ok: true });
 } catch (e) { next(e); }
});

// Confirma um pedido sem cobrar, apenas para testar o fluxo local.
router.post('/pedidos/:id/simular-pagamento', async (req, res, next) => {
 try {
  if (!cfg.pagamentoSimulado) return res.status(404).json({ erro: 'Pagamento simulado desativado.' });
  if (!UUID.test(req.params.id)) return res.status(400).json({ erro: 'Pedido inválido.' });
  const pedido = await svc.obterPedido(req.params.id);
  if (!pedido) return res.status(404).json({ erro: 'Pedido não encontrado.' });
  if (await svc.marcarPago(pedido.id)) {
    await notificarLoja(await svc.obterPedido(pedido.id));
    return res.json({ ok: true, status: 'pago' });
  }
  return res.status(409).json({ erro: 'Pedido não está pendente.', status: pedido.status });
 } catch (e) { next(e); }
});

module.exports = router;
