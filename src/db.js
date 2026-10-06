const { Pool } = require('pg');
const cfg = require('./config');
const produtos = require('./produtos');

if (!cfg.databaseUrl) throw new Error('DATABASE_URL ausente. Configure a conexão PostgreSQL do Supabase no .env.');

const databaseUrl = new URL(cfg.databaseUrl);
const usarTls = cfg.producao || process.env.DB_SSL !== 'false';
if (usarTls) {
  // sslmode=require criptografa, mas não valida o certificado/hostname do banco.
  // Força a validação completa, mesmo que a URL do provedor use require.
  databaseUrl.searchParams.set('sslmode', 'verify-full');
  const caPath = process.env.DB_SSL_CA?.trim();
  if (cfg.producao && !caPath) {
    throw new Error('DB_SSL_CA ausente. Configure o certificado raiz do PostgreSQL para validar a conexão em produção.');
  }
  if (caPath) databaseUrl.searchParams.set('sslrootcert', caPath);
} else {
  databaseUrl.searchParams.set('sslmode', 'disable');
}

const pool = new Pool({
  connectionString: databaseUrl.toString(),
  max: Number(process.env.DB_POOL_MAX || 5),
  idleTimeoutMillis: 30000
});

const query = (text, params = []) => pool.query(text, params);

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function init() {
  await query(`
    CREATE TABLE IF NOT EXISTS produtos (
      id TEXT PRIMARY KEY, nome TEXT NOT NULL, descricao TEXT NOT NULL DEFAULT '',
      preco_centavos INTEGER NOT NULL CHECK (preco_centavos > 0), ativo BOOLEAN NOT NULL DEFAULT TRUE,
      imagem_url TEXT, imagem_path TEXT, esgotado BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE TABLE IF NOT EXISTS pedidos (
      id UUID PRIMARY KEY, nome TEXT NOT NULL, email TEXT NOT NULL, telefone TEXT NOT NULL,
      tipo TEXT NOT NULL CHECK (tipo IN ('entrega','retirada')), regiao TEXT NOT NULL,
      cidade TEXT NOT NULL DEFAULT '', rua TEXT NOT NULL DEFAULT '', numero TEXT NOT NULL DEFAULT '',
      complemento TEXT NOT NULL DEFAULT '', endereco TEXT NOT NULL DEFAULT '', obs TEXT NOT NULL DEFAULT '',
      total_centavos INTEGER NOT NULL CHECK (total_centavos > 0), status TEXT NOT NULL DEFAULT 'pendente',
      criado_em BIGINT NOT NULL, expira_em BIGINT NOT NULL, pago_em BIGINT
    );
    CREATE TABLE IF NOT EXISTS pedido_itens (
      id BIGSERIAL PRIMARY KEY, pedido_id UUID NOT NULL REFERENCES pedidos(id), produto_id TEXT NOT NULL,
      nome TEXT NOT NULL, qtd INTEGER NOT NULL CHECK (qtd BETWEEN 1 AND 99), preco_unit_centavos INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pagamentos (
      id BIGSERIAL PRIMARY KEY, pedido_id UUID NOT NULL REFERENCES pedidos(id), mp_payment_id TEXT NOT NULL UNIQUE,
      mp_order_id TEXT, status TEXT NOT NULL, valor_centavos INTEGER NOT NULL, qr_code TEXT, qr_base64 TEXT, criado_em BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS eventos_webhook (
      id BIGSERIAL PRIMARY KEY, request_id TEXT, tipo TEXT, referencia TEXT, criado_em BIGINT NOT NULL
    );
    ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cidade TEXT NOT NULL DEFAULT '';
    ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS rua TEXT NOT NULL DEFAULT '';
    ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS numero TEXT NOT NULL DEFAULT '';
    ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS complemento TEXT NOT NULL DEFAULT '';
    ALTER TABLE pagamentos ADD COLUMN IF NOT EXISTS mp_order_id TEXT;
    ALTER TABLE produtos ADD COLUMN IF NOT EXISTS imagem_url TEXT;
    ALTER TABLE produtos ADD COLUMN IF NOT EXISTS imagem_path TEXT;
    ALTER TABLE produtos ADD COLUMN IF NOT EXISTS esgotado BOOLEAN NOT NULL DEFAULT FALSE;
    CREATE INDEX IF NOT EXISTS idx_pedidos_status ON pedidos(status, expira_em);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pagamentos_mp_order_id ON pagamentos(mp_order_id) WHERE mp_order_id IS NOT NULL;
    DELETE FROM eventos_webhook a USING eventos_webhook b
      WHERE a.request_id=b.request_id AND a.request_id IS NOT NULL AND a.id>b.id;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_eventos_webhook_request_id ON eventos_webhook(request_id);
  `);
  for (const p of produtos) {
    await query(`INSERT INTO produtos (id,nome,descricao,preco_centavos,ativo) VALUES ($1,$2,$3,$4,TRUE)
      ON CONFLICT (id) DO NOTHING`, [p.id, p.nome, p.descricao, p.preco_centavos]);
  }
}

async function close() { await pool.end(); }

module.exports = { query, withTransaction, init, close };
