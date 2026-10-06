const crypto = require('crypto');
const db = require('./db');
const cfg = require('./config');
const acessoPedido = require('./acesso-pedido');

class ErroNegocio extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

async function criarPedido(d, expiraMin, tokenAcesso) {
  const tokenHash = acessoPedido.hashToken(tokenAcesso);
  if (!tokenHash) throw new ErroNegocio('Não foi possível proteger o acompanhamento do pedido. Recarregue a página e tente novamente.');

  const existente = (await db.query(`
    SELECT p.* FROM acesso_pedido a JOIN pedidos p ON p.id=a.pedido_id
    WHERE a.token_hash=$1 AND a.revogado_em IS NULL AND a.expira_em>$2`,
  [tokenHash, Date.now()])).rows[0];
  if (existente) return { ...existente, reutilizado: true };

  const pend = await db.query(`SELECT COUNT(*)::int AS n FROM pedidos WHERE status='pendente' AND (telefone=$1 OR email=$2)`, [d.telefone, d.email]);
  if (pend.rows[0].n >= 3) throw new ErroNegocio('Você já tem pedidos aguardando pagamento. Conclua ou aguarde expirar.', 429);

  const ids = d.itens.map(i => i.id);
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
  const lista = await db.query(`SELECT id,nome,preco_centavos FROM produtos WHERE ativo=TRUE AND esgotado=FALSE AND id IN (${placeholders})`, ids);
  const catalogo = new Map(lista.rows.map(p => [p.id, p]));
  let total = 0;
  const itens = d.itens.map(i => {
    const p = catalogo.get(i.id);
    if (!p) throw new ErroNegocio('Um dos produtos não está mais disponível.');
    total += p.preco_centavos * i.qtd;
    return { produto_id: p.id, nome: p.nome, qtd: i.qtd, preco_unit_centavos: p.preco_centavos };
  });
  if (total <= 0 || total > cfg.limitePedidoCentavos) throw new ErroNegocio('Valor do pedido inválido.');

  const id = crypto.randomUUID();
  const agora = Date.now();
  const expira = agora + expiraMin * 60000;
  const endereco = d.tipo === 'entrega' ? [d.rua, d.numero, d.complemento].filter(Boolean).join(', ') : '';
  try {
    await db.withTransaction(async client => {
    await client.query(`INSERT INTO pedidos
      (id,nome,email,telefone,tipo,regiao,cidade,rua,numero,complemento,endereco,obs,total_centavos,status,criado_em,expira_em)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pendente',$14,$15)`,
      [id,d.nome,d.email,d.telefone,d.tipo,d.regiao,d.tipo === 'entrega' ? d.cidade : '',d.tipo === 'entrega' ? d.rua : '',d.tipo === 'entrega' ? d.numero : '',d.tipo === 'entrega' ? d.complemento : '',endereco,d.obs,total,agora,expira]);
    await client.query(`INSERT INTO acesso_pedido (pedido_id,token_hash,expira_em,criado_em)
      VALUES ($1,$2,$3,$4)`, [id,tokenHash,acessoPedido.expiracaoToken(agora),agora]);
    await client.query(`INSERT INTO tentativas_cobranca
      (pedido_id,chave_idempotencia,estado,tentativas,proxima_tentativa,criado_em,atualizado_em)
      VALUES ($1,$2,'pendente',0,$3,$3,$3)`, [id,id,agora]);
    for (const it of itens) {
      await client.query(`INSERT INTO pedido_itens (pedido_id,produto_id,nome,qtd,preco_unit_centavos) VALUES ($1,$2,$3,$4,$5)`,
        [id,it.produto_id,it.nome,it.qtd,it.preco_unit_centavos]);
    }
    });
  } catch (e) {
    // Requisições repetidas com o mesmo token de checkout recuperam o pedido
    // que venceu a corrida para inserir a credencial única.
    if (e.code === '23505') {
      const repetido = (await db.query(`
        SELECT p.* FROM acesso_pedido a JOIN pedidos p ON p.id=a.pedido_id
        WHERE a.token_hash=$1 AND a.revogado_em IS NULL AND a.expira_em>$2`,
      [tokenHash,Date.now()])).rows[0];
      if (repetido) return { ...repetido, reutilizado: true };
    }
    throw e;
  }
  return { id, total_centavos: total, expira_em: expira, itens, reutilizado: false };
}

async function obterPedido(id) { const r = await db.query('SELECT * FROM pedidos WHERE id=$1', [id]); return r.rows[0]; }
async function obterPagamento(pedidoId) { const r = await db.query('SELECT * FROM pagamentos WHERE pedido_id=$1', [pedidoId]); return r.rows[0]; }

async function visaoPublica(pedido) {
  const out = { id: pedido.id, status: pedido.status, total_centavos: pedido.total_centavos, restante_ms: Math.max(0, Number(pedido.expira_em) - Date.now()) };
  if (pedido.status === 'pendente') {
    const pg = await obterPagamento(pedido.id);
    if (pg) out.pix = { copiaECola: pg.qr_code, qrBase64: pg.qr_base64 };
    else out.pix_em_processamento = true;
  }
  return out;
}

async function marcarPago(pedidoId) {
  const r = await db.query(`UPDATE pedidos SET status='pago', pago_em=$1 WHERE id=$2 AND status='pendente'`, [Date.now(), pedidoId]);
  return r.rowCount === 1;
}

async function mudarStatus(pedidoId, de, para) {
  const params = [para, pedidoId, ...de];
  const placeholders = de.map((_, i) => `$${i + 3}`).join(',');
  const r = await db.query(`UPDATE pedidos SET status=$1 WHERE id=$2 AND status IN (${placeholders})`, params);
  return r.rowCount === 1;
}

module.exports = { ErroNegocio, criarPedido, obterPedido, obterPagamento, visaoPublica, marcarPago, mudarStatus };
