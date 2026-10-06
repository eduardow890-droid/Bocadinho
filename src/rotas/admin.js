const crypto = require('crypto');
const multer = require('multer');
const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const db = require('../db');
const cfg = require('../config');
const svc = require('../pedidos');
const { notificarLoja } = require('../notificar');
const { UUID } = require('../validacao');
const storage = require('../storage');
const acessoPedido = require('../acesso-pedido');

const uploadImagem = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 4, parts: 5 },
  fileFilter: (req, file, cb) => {
    if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) return cb(null, true);
    cb(new Error('Envie uma imagem JPEG, PNG ou WebP.'));
  }
});

function receberImagem(req, res, next) {
  uploadImagem.single('imagem')(req, res, erro => {
    if (!erro) return next();
    const status = erro.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    res.status(status).json({ erro: status === 413 ? 'A imagem deve ter no máximo 5 MB.' : erro.message });
  });
}

function dadosProduto(body) {
  const nome = String(body.nome || '').trim();
  const descricao = String(body.descricao || '').trim();
  const preco = Number(body.preco_centavos);
  if (nome.length < 2 || nome.length > 80) throw Object.assign(new Error('O nome deve ter entre 2 e 80 caracteres.'), { status: 400 });
  if (descricao.length > 300) throw Object.assign(new Error('A descrição deve ter no máximo 300 caracteres.'), { status: 400 });
  if (!Number.isSafeInteger(preco) || preco < 1 || preco > 500000) throw Object.assign(new Error('Informe um preço válido de até R$ 5.000,00.'), { status: 400 });
  return { nome, descricao, preco, esgotado: body.esgotado === 'true' };
}

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

router.get('/produtos', async (req, res, next) => {
  try {
    const produtos = (await db.query('SELECT id,nome,descricao,preco_centavos,imagem_url,ativo,esgotado FROM produtos ORDER BY nome')).rows;
    res.json(produtos);
  } catch (e) { next(e); }
});

router.post('/produtos', receberImagem, async (req, res, next) => {
  let imagem;
  try {
    const dados = dadosProduto(req.body);
    if (!req.file) return res.status(400).json({ erro: 'Selecione uma foto do doce.' });
    imagem = await storage.enviarImagem(req.file);
    const id = crypto.randomBytes(8).toString('hex');
    const produto = (await db.query(`INSERT INTO produtos
      (id,nome,descricao,preco_centavos,ativo,imagem_url,imagem_path,esgotado)
      VALUES ($1,$2,$3,$4,TRUE,$5,$6,$7)
      RETURNING id,nome,descricao,preco_centavos,imagem_url,ativo,esgotado`,
      [id,dados.nome,dados.descricao,dados.preco,imagem.url,imagem.caminho,dados.esgotado])).rows[0];
    res.status(201).json(produto);
  } catch (e) {
    if (imagem) await storage.excluirImagem(imagem.caminho).catch(() => {});
    if (e.status) return res.status(e.status).json({ erro: e.message });
    next(e);
  }
});

router.patch('/produtos/:id', receberImagem, async (req, res, next) => {
  let imagemNova;
  try {
    const dados = dadosProduto(req.body);
    const anterior = (await db.query('SELECT id,imagem_path FROM produtos WHERE id=$1', [req.params.id])).rows[0];
    if (!anterior) return res.status(404).json({ erro: 'Produto não encontrado.' });
    if (req.file) imagemNova = await storage.enviarImagem(req.file);
    const imagemUrl = imagemNova?.url || null;
    const imagemPath = imagemNova?.caminho || null;
    const produto = (await db.query(`UPDATE produtos SET nome=$1,descricao=$2,preco_centavos=$3,
      imagem_url=COALESCE($4,imagem_url),imagem_path=COALESCE($5,imagem_path),esgotado=$6
      WHERE id=$7 RETURNING id,nome,descricao,preco_centavos,imagem_url,ativo,esgotado`,
      [dados.nome,dados.descricao,dados.preco,imagemUrl,imagemPath,dados.esgotado,req.params.id])).rows[0];
    if (imagemNova && anterior.imagem_path) {
      await storage.excluirImagem(anterior.imagem_path).catch(() => console.warn('[produtos] não foi possível remover foto substituída.'));
    }
    res.json(produto);
  } catch (e) {
    if (imagemNova) await storage.excluirImagem(imagemNova.caminho).catch(() => {});
    if (e.status) return res.status(e.status).json({ erro: e.message });
    next(e);
  }
});

router.patch('/produtos/:id/ativo', async (req, res, next) => {
  try {
    if (typeof req.body?.ativo !== 'boolean') return res.status(400).json({ erro: 'Informe se o produto está ativo.' });
    const produto = (await db.query('UPDATE produtos SET ativo=$1 WHERE id=$2 RETURNING id,ativo', [req.body.ativo, req.params.id])).rows[0];
    if (!produto) return res.status(404).json({ erro: 'Produto não encontrado.' });
    res.json(produto);
  } catch (e) { next(e); }
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

router.post('/pedidos/:id/revogar-acesso', async (req, res, next) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(400).json({ erro: 'Pedido inválido.' });
    const pedido = await svc.obterPedido(req.params.id);
    if (!pedido) return res.status(404).json({ erro: 'Pedido não encontrado.' });
    const revogado = await acessoPedido.revogar(pedido.id);
    if (!revogado) return res.status(409).json({ erro: 'O pedido não possui acesso ativo para revogar.' });
    res.json({ ok: true });
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
