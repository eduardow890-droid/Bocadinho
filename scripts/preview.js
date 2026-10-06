// Prévia visual isolada: não carrega .env, banco de dados ou Mercado Pago.
const path = require('path');
const express = require('express');

const app = express();
const pedidos = new Map();
const pedidosPorToken = new Map();
const produtos = [
  {
    id: 'c1',
    nome: 'Cookie tradicional',
    descricao: 'Com gotas de chocolate, douradinho por fora e macio por dentro.',
    preco_centavos: 1200,
    imagem_url: '/assets/photo-4.jpg',
    esgotado: false
  },
  {
    id: 'c2',
    nome: 'Cookie com cobertura de chocolate',
    descricao: 'Cookie artesanal com fios de chocolate por cima.',
    preco_centavos: 1400,
    imagem_url: '/assets/photo-2.jpg',
    esgotado: false
  }
];

app.use(express.json({ limit: '20kb' }));

app.get('/api/produtos', (req, res) => res.json(produtos));

app.post('/api/pedidos', (req, res) => {
  const token = req.get('x-order-access-token');
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    return res.status(400).json({ erro: 'Token de acompanhamento inválido.' });
  }
  const pedidoExistente = pedidosPorToken.get(token);
  if (pedidoExistente) return res.status(200).json(pedidoExistente);
  const itens = Array.isArray(req.body?.itens) ? req.body.itens : [];
  const total = itens.reduce((soma, item) => {
    const produto = produtos.find(p => p.id === item.id && !p.esgotado);
    return soma + (produto ? produto.preco_centavos * Number(item.qtd || 0) : 0);
  }, 0);
  if (!total) return res.status(400).json({ erro: 'Selecione um produto para continuar.' });

  const pedido = {
    id: `preview-${Date.now()}`,
    status: 'pendente',
    total_centavos: total,
    restante_ms: 30 * 60 * 1000,
    pix: { copiaECola: 'DEMONSTRACAO-NAO-PAGAVEL', qrBase64: '' }
  };
  pedidos.set(pedido.id, pedido);
  pedidosPorToken.set(token, pedido);
  res.status(201).json(pedido);
});

app.get('/api/pedidos/retomar', (req, res) => {
  const pedido = pedidosPorToken.get(req.get('x-order-access-token'));
  if (!pedido) return res.status(404).json({ erro: 'Pedido de demonstração não encontrado.' });
  res.json(pedido);
});

app.get('/api/pedidos/:id', (req, res) => {
  const pedido = pedidos.get(req.params.id);
  if (!pedido || pedidosPorToken.get(req.get('x-order-access-token')) !== pedido) return res.status(404).json({ erro: 'Pedido de demonstração não encontrado.' });
  res.json(pedido);
});

app.post('/api/pedidos/:id/cancelar', (req, res) => {
  const pedido = pedidos.get(req.params.id);
  if (!pedido || pedidosPorToken.get(req.get('x-order-access-token')) !== pedido) return res.status(404).json({ erro: 'Pedido de demonstração não encontrado.' });
  pedido.status = 'cancelado';
  res.json({ ok: true, status: pedido.status });
});

app.use('/brand-assets', express.static(path.join(__dirname, '..', 'assets'), { index: false }));
app.use(express.static(path.join(__dirname, '..', 'public')));

function iniciar(porta) {
  const servidor = app.listen(porta, '127.0.0.1');
  servidor.once('listening', () => {
    const portaAtiva = servidor.address().port;
    console.log(`Prévia visual em http://127.0.0.1:${portaAtiva}`);
    console.log('Usa produtos fictícios; não acessa banco e não gera cobrança real.');
  });
  servidor.once('error', erro => {
    if (erro.code === 'EADDRINUSE' && porta < 4190) {
      console.warn(`Porta ${porta} ocupada; tentando ${porta + 1}...`);
      iniciar(porta + 1);
      return;
    }
    console.error('Não foi possível iniciar a prévia:', erro.message);
    process.exitCode = 1;
  });
}

iniciar(Number(process.env.PREVIEW_PORT || 4174));