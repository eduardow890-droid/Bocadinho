const crypto = require('crypto');
const { promisify } = require('util');
const db = require('./db');
const cfg = require('./config');

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'bocadinho_sessao';
const FORMATO_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SESSAO_MS = cfg.sessaoDias * 24 * 60 * 60 * 1000;

async function hashSenha(senha) {
  const sal = crypto.randomBytes(16);
  const chave = await scrypt(senha.normalize('NFKC'), sal, 64);
  return `scrypt$${sal.toString('base64url')}$${chave.toString('base64url')}`;
}

async function conferirSenha(senha, armazenado) {
  const [alg, sal, chave] = String(armazenado || '').split('$');
  if (alg !== 'scrypt' || !sal || !chave) return false;
  const esperado = Buffer.from(chave, 'base64url');
  const obtido = await scrypt(senha.normalize('NFKC'), Buffer.from(sal, 'base64url'), esperado.length);
  return crypto.timingSafeEqual(esperado, obtido);
}

// Hash descartável para igualar o tempo de resposta quando o e-mail não existe.
const hashFalso = hashSenha(crypto.randomBytes(8).toString('hex'));

const hashToken = token => crypto.createHash('sha256').update(token).digest('hex');
const publico = c => ({ id: c.id, nome: c.nome, email: c.email, telefone: c.telefone });

async function criarCliente({ nome, email, telefone, senha }) {
  const id = crypto.randomUUID();
  try {
    await db.query(`INSERT INTO clientes (id,nome,email,telefone,senha_hash,criado_em) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, nome, email, telefone, await hashSenha(senha), Date.now()]);
  } catch (e) {
    if (e.code === '23505') return null; // e-mail já cadastrado
    throw e;
  }
  return { id, nome, email, telefone };
}

async function obterPorId(id) {
  if (!id) return null;
  return (await db.query(
    'SELECT id,nome,email,telefone,criado_em FROM clientes WHERE id=$1', [id]
  )).rows[0] || null;
}

async function autenticar(email, senha) {
  const c = (await db.query('SELECT * FROM clientes WHERE email=$1', [email])).rows[0];
  if (!c) { await conferirSenha(senha, await hashFalso); return null; }
  return (await conferirSenha(senha, c.senha_hash)) ? c : null;
}

async function abrirSessao(res, clienteId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const agora = Date.now();
  await db.query('INSERT INTO sessoes_cliente (token_hash,cliente_id,expira_em,criado_em) VALUES ($1,$2,$3,$4)',
    [hashToken(token), clienteId, agora + SESSAO_MS, agora]);
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: cfg.producao, path: '/', maxAge: SESSAO_MS
  });
}

function lerCookie(req) {
  const bruto = req.headers.cookie || '';
  for (const parte of bruto.split(';')) {
    const i = parte.indexOf('=');
    if (i > 0 && parte.slice(0, i).trim() === COOKIE) return decodeURIComponent(parte.slice(i + 1).trim());
  }
  return null;
}

/** Middleware: preenche req.cliente quando há sessão válida; nunca bloqueia. */
async function carregarCliente(req, res, next) {
  try {
    const token = lerCookie(req);
    if (token && FORMATO_TOKEN.test(token)) {
      const c = (await db.query(`SELECT c.* FROM sessoes_cliente s JOIN clientes c ON c.id=s.cliente_id
        WHERE s.token_hash=$1 AND s.expira_em>$2`, [hashToken(token), Date.now()])).rows[0];
      if (c) req.cliente = c;
    }
    next();
  } catch (e) { next(e); }
}

function exigirCliente(req, res, next) {
  if (!req.cliente) return res.status(401).json({ erro: 'Entre na sua conta para continuar.' });
  next();
}

async function encerrarSessao(req, res) {
  const token = lerCookie(req);
  if (token && FORMATO_TOKEN.test(token)) await db.query('DELETE FROM sessoes_cliente WHERE token_hash=$1', [hashToken(token)]);
  res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'lax', secure: cfg.producao, path: '/' });
}

async function limparSessoesExpiradas() {
  await db.query('DELETE FROM sessoes_cliente WHERE expira_em<$1', [Date.now()]);
}

module.exports = { criarCliente, obterPorId, autenticar, abrirSessao, carregarCliente, exigirCliente, encerrarSessao, limparSessoesExpiradas, publico, hashSenha, conferirSenha };
