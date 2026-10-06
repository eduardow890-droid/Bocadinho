const crypto = require('crypto');
const db = require('./db');
const cfg = require('./config');

class ErroNegocio extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

async function criarPedido(d, expiraMin) {
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
  await db.withTransaction(async client => {
    await client.query(`INSERT INTO pedidos
      (id,nome,email,telefone,tipo,regiao,cidade,rua,numero,complemento,endereco,obs,total_centavos,status,criado_em,expira_em)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pendente',$14,$15)`,
      [id,d.nome,d.email,d.telefone,d.tipo,d.regiao,d.tipo === 'entrega' ? d.cidade : '',d.tipo === 'entrega' ? d.rua : '',d.tipo === 'entrega' ? d.numero : '',d.tipo === 'entrega' ? d.complemento : '',endereco,d.obs,total,agora,expira]);
    for (const it of itens) {
      await client.query(`INSERT INTO pedido_itens (pedido_id,produto_id,nome,qtd,preco_unit_centavos) VALUES ($1,$2,$3,$4,$5)`,
        [id,it.produto_id,it.nome,it.qtd,it.preco_unit_centavos]);
    }
  });
  return { id, total_centavos: total, expira_em: expira, itens };
}

async function registrarPagamento(pedidoId, c) {
  await db.query(`INSERT INTO pagamentos (pedido_id,mp_payment_id,mp_order_id,status,valor_centavos,qr_code,qr_base64,criado_em)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [pedidoId,String(c.mpId),c.mpOrderId ? String(c.mpOrderId) : null,c.status,c.valorCentavos,c.qr,c.qrBase64,Date.now()]);
}

async function obterPedido(id) { const r = await db.query('SELECT * FROM pedidos WHERE id=$1', [id]); return r.rows[0]; }
async function obterPagamento(pedidoId) { const r = await db.query('SELECT * FROM pagamentos WHERE pedido_id=$1', [pedidoId]); return r.rows[0]; }

async function visaoPublica(pedido) {
  const out = { id: pedido.id, status: pedido.status, total_centavos: pedido.total_centavos, restante_ms: Math.max(0, Number(pedido.expira_em) - Date.now()) };
  if (pedido.status === 'pendente') {
    const pg = await obterPagamento(pedido.id);
    if (pg) out.pix = { copiaECola: pg.qr_code, qrBase64: pg.qr_base64 };
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

module.exports = { ErroNegocio, criarPedido, registrarPagamento, obterPedido, obterPagamento, visaoPublica, marcarPago, mudarStatus };
