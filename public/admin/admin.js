(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const PAID_STATUSES = new Set(['pago', 'em_preparo', 'enviado', 'concluido']);
  const STATUS_LABELS = {
    pendente: 'Pendente', pago: 'Pago', em_preparo: 'Em preparo', enviado: 'Enviado',
    concluido: 'Concluído', expirado: 'Expirado', cancelado: 'Cancelado',
    estornado: 'Estornado', revisar: 'Revisar'
  };
  let token = null;
  let pedidos = [];
  let primeiraCarga = true;
  let pedidosPagosConhecidos = new Set();
  let somAtivo = false;
  let intervalo = null;
  let produtos = [];

  const dinheiro = centavos => (Number(centavos || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const dataHora = ms => new Date(ms).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  const textoStatus = status => STATUS_LABELS[status] || status;
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };

  function mostrarMensagem(texto, erro = false) {
    const node = $('connection-message');
    node.textContent = texto;
    node.className = `message${erro ? ' error' : ''}`;
    node.hidden = !texto;
  }

  async function requisicao(caminho, opcoes = {}) {
    const headers = new Headers(opcoes.headers || {});
    headers.set('x-admin-token', token);
    if (opcoes.body && !(opcoes.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const resposta = await fetch(caminho, { ...opcoes, headers });
    if (resposta.status === 401) throw Object.assign(new Error('Token inválido ou sessão expirada.'), { status: 401 });
    if (resposta.status === 429) throw Object.assign(new Error('Muitas tentativas. Aguarde um minuto.'), { status: 429 });
    const dados = await resposta.json().catch(() => ({}));
    if (!resposta.ok) throw Object.assign(new Error(dados.erro || 'Não foi possível concluir a operação.'), { status: resposta.status });
    return dados;
  }

  function atualizarResumo(resumo) {
    const contagens = resumo.por_status || {};
    ['pago', 'em_preparo', 'enviado', 'pendente', 'revisar'].forEach(status => {
      $(`count-${status}`).textContent = String(contagens[status] || 0);
    });
    $('paid-today').textContent = dinheiro(resumo.pagos_hoje?.total_centavos);
  }

  function renderProdutos() {
    const lista = $('product-list');
    lista.replaceChildren();
    $('products-loading').hidden = true;
    if (!produtos.length) {
      lista.append(el('p', 'Nenhum produto cadastrado.', 'empty'));
      return;
    }
    produtos.forEach(produto => {
      const card = el('article', undefined, `product-card${produto.ativo ? '' : ' is-inactive'}`);
      if (produto.imagem_url) {
        const imagem = el('img', undefined, 'product-thumb');
        imagem.src = produto.imagem_url;
        imagem.alt = produto.nome;
        imagem.loading = 'lazy';
        card.append(imagem);
      } else card.append(el('div', '🍪', 'product-thumb product-thumb-empty'));
      const info = el('div', undefined, 'product-info');
      info.append(el('h3', produto.nome));
      if (produto.descricao) info.append(el('p', produto.descricao));
      info.append(el('strong', dinheiro(produto.preco_centavos)));
      info.append(el('span', !produto.ativo ? 'Oculto no cardápio' : produto.esgotado ? 'Esgotado' : 'Disponível no cardápio', `product-state${produto.esgotado ? ' is-sold-out' : ''}`));
      const actions = el('div', undefined, 'product-actions');
      const editar = el('button', 'Editar', 'button secondary');
      editar.type = 'button';
      editar.addEventListener('click', () => editarProduto(produto));
      const alternar = el('button', produto.ativo ? 'Desativar' : 'Ativar', 'button secondary');
      alternar.type = 'button';
      alternar.addEventListener('click', () => alternarProduto(produto, alternar));
      actions.append(editar, alternar);
      card.append(info, actions);
      lista.append(card);
    });
  }

  async function carregarProdutosAdmin() {
    $('products-loading').hidden = false;
    try {
      produtos = await requisicao('/api/admin/produtos');
      renderProdutos();
    } catch (erro) {
      $('products-loading').hidden = true;
      $('product-list').replaceChildren(el('p', erro.message || 'Não foi possível carregar os produtos.', 'message error'));
      if (erro.status === 401) sair();
    }
  }

  function limparFormularioProduto() {
    $('product-form').reset();
    $('product-id').value = '';
    $('product-image').required = true;
    $('product-image-help').textContent = 'Selecione uma imagem para o novo produto. Ao editar, deixe em branco para manter a foto atual.';
    $('save-product-button').textContent = 'Salvar doce';
    $('product-message').hidden = true;
    $('product-form').hidden = true;
  }

  function editarProduto(produto) {
    $('product-form').hidden = false;
    $('product-id').value = produto.id;
    $('product-name').value = produto.nome;
    $('product-description').value = produto.descricao || '';
    $('product-price').value = (produto.preco_centavos / 100).toFixed(2);
    $('product-sold-out').checked = Boolean(produto.esgotado);
    $('product-image').value = '';
    $('product-image').required = false;
    $('product-image-help').textContent = produto.imagem_url ? 'Foto atual mantida. Selecione outra somente se quiser substituí-la.' : 'Este produto ainda não tem foto; selecione uma imagem para adicioná-la.';
    $('save-product-button').textContent = 'Salvar alterações';
    $('product-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function alternarProduto(produto, botao) {
    const ativo = !produto.ativo;
    if (!window.confirm(`${ativo ? 'Ativar' : 'Desativar'} “${produto.nome}” no cardápio?`)) return;
    botao.disabled = true;
    try {
      await requisicao(`/api/admin/produtos/${encodeURIComponent(produto.id)}/ativo`, {
        method: 'PATCH', body: JSON.stringify({ ativo })
      });
      await carregarProdutosAdmin();
    } catch (erro) {
      mostrarMensagem(erro.message, true);
      botao.disabled = false;
    }
  }

  function criarWhatsapp(pedido) {
    const telefone = String(pedido.telefone || '').replace(/\D/g, '').replace(/^55/, '');
    if (!telefone) return null;
    const codigo = pedido.id.slice(0, 8);
    const mensagem = `Olá, ${pedido.nome}! Seu pedido Bocadinho #${codigo} foi recebido.`;
    const link = el('a', 'Falar com cliente', 'button whatsapp');
    link.href = `https://wa.me/55${telefone}?text=${encodeURIComponent(mensagem)}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
  }

  function criarCard(pedido) {
    const card = el('article', undefined, `order-card${['revisar', 'estornado'].includes(pedido.status) ? ' urgent' : ''}`);
    const head = el('div', undefined, 'order-head');
    const titleBox = el('div');
    titleBox.append(el('h2', `Pedido #${pedido.id.slice(0, 8)}`, 'order-code'));
    titleBox.append(el('p', `${pedido.nome} · ${dataHora(pedido.criado_em)} · ${pedido.tipo === 'entrega' ? 'Entrega' : 'Retirada'} · ${pedido.regiao}`, 'order-meta'));
    const badge = el('span', textoStatus(pedido.status), `badge ${pedido.status}`);
    head.append(titleBox, badge);
    card.append(head);

    const itens = el('ul', undefined, 'order-items');
    (pedido.itens || []).forEach(item => {
      const linha = el('li');
      linha.append(el('span', `${item.qtd}x ${item.nome}`), el('strong', dinheiro(item.qtd * item.preco_unit_centavos)));
      itens.append(linha);
    });
    card.append(itens, el('p', `Total: ${dinheiro(pedido.total_centavos)}`, 'order-total'));

    if (pedido.obs) card.append(el('p', `Observação: ${pedido.obs}`, 'order-note'));
    if (pedido.status === 'revisar') card.append(el('p', 'Atenção: pagamento fora das condições esperadas ou recebido após expiração. Não avance sem conferência manual.', 'warning'));
    if (pedido.status === 'estornado') card.append(el('p', 'Atenção: este pagamento foi estornado. Não avance o pedido.', 'warning'));

    const details = el('details', undefined, 'order-details');
    details.append(el('summary', 'Ver endereço e contato'));
    const grid = el('div', undefined, 'details-grid');
    grid.append(el('div', undefined));
    grid.lastChild.append(el('strong', 'Telefone: '), el('span', pedido.telefone));
    grid.append(el('div', undefined));
    grid.lastChild.append(el('strong', 'E-mail: '), el('span', pedido.email));
    grid.append(el('div', undefined));
    const endereco = pedido.tipo === 'entrega'
      ? [pedido.rua && `${pedido.rua}, ${pedido.numero || 's/n'}`, pedido.complemento, pedido.regiao, pedido.cidade].filter(Boolean).join(' — ')
      : 'Retirada no local';
    grid.lastChild.append(el('strong', 'Endereço: '), el('span', endereco));
    details.append(grid);
    card.append(details);

    const actions = el('div', undefined, 'order-actions');
    const whatsapp = criarWhatsapp(pedido);
    if (whatsapp) actions.append(whatsapp);
    const revogar = el('button', 'Revogar acesso do cliente', 'button secondary');
    revogar.type = 'button';
    revogar.addEventListener('click', () => revogarAcesso(pedido.id, revogar));
    actions.append(revogar);
    const proximos = { pago: ['em_preparo', 'Iniciar preparo'], em_preparo: ['enviado', 'Marcar enviado'], enviado: ['concluido', 'Concluir'] };
    if (proximos[pedido.status]) {
      const [novoStatus, texto] = proximos[pedido.status];
      const botao = el('button', texto, 'button action');
      botao.type = 'button';
      botao.addEventListener('click', () => mudarStatus(pedido.id, novoStatus, botao));
      actions.append(botao);
    }
    if (actions.childNodes.length) card.append(actions);
    return card;
  }

  function renderPedidos() {
    const lista = $('orders');
    lista.replaceChildren();
    const busca = $('search').value.trim().toLocaleLowerCase('pt-BR');
    const filtrados = pedidos.filter(pedido => {
      const nome = String(pedido.nome || '').toLocaleLowerCase('pt-BR');
      const telefone = String(pedido.telefone || '').toLocaleLowerCase('pt-BR');
      return !busca || nome.includes(busca) || telefone.includes(busca);
    });
    if (!filtrados.length) {
      lista.append(el('p', 'Nenhum pedido encontrado para este filtro.', 'empty'));
      return;
    }
    filtrados.forEach(pedido => lista.append(criarCard(pedido)));
  }

  async function carregar() {
    if (!token) return;
    const lista = $('orders');
    lista.setAttribute('aria-busy', 'true');
    try {
      const status = $('status-filter').value;
      const query = status ? `?status=${encodeURIComponent(status)}` : '';
      const [resumo, novaLista] = await Promise.all([
        requisicao('/api/admin/resumo'),
        requisicao(`/api/admin/pedidos${query}`)
      ]);
      const novosPagos = novaLista.filter(p => p.status === 'pago' && !pedidosPagosConhecidos.has(p.id));
      if (!primeiraCarga && novosPagos.length) {
        $('notice').textContent = `${novosPagos.length} novo${novosPagos.length > 1 ? 's' : ''} pedido${novosPagos.length > 1 ? 's' : ''} pago${novosPagos.length > 1 ? 's' : ''}.`;
        $('notice').hidden = false;
        if (somAtivo) tocarAviso();
      }
      pedidosPagosConhecidos = new Set(novaLista.filter(p => PAID_STATUSES.has(p.status)).map(p => p.id));
      pedidos = novaLista;
      atualizarResumo(resumo);
      renderPedidos();
      mostrarMensagem('');
      primeiraCarga = false;
    } catch (erro) {
      mostrarMensagem(erro.message || 'Falha de conexão.', true);
      if (erro.status === 401) sair();
    } finally {
      lista.setAttribute('aria-busy', 'false');
    }
  }

  async function mudarStatus(id, status, botao) {
    if (!window.confirm(`Confirmar mudança para “${textoStatus(status)}”?`)) return;
    botao.disabled = true;
    try {
      await requisicao(`/api/admin/pedidos/${encodeURIComponent(id)}/status`, {
        method: 'PATCH', body: JSON.stringify({ status })
      });
      await carregar();
    } catch (erro) {
      mostrarMensagem(erro.message, true);
      botao.disabled = false;
    }
  }

  async function revogarAcesso(id, botao) {
    if (!window.confirm('Revogar o token de acompanhamento deste pedido? O cliente deixará de consultar ou cancelar o pedido neste navegador.')) return;
    botao.disabled = true;
    try {
      await requisicao(`/api/admin/pedidos/${encodeURIComponent(id)}/revogar-acesso`, { method: 'POST' });
      mostrarMensagem('Acesso de acompanhamento revogado.');
    } catch (erro) {
      mostrarMensagem(erro.message || 'Não foi possível revogar o acesso.', true);
      botao.disabled = false;
    }
  }

  function tocarAviso() {
    try {
      const contexto = new (window.AudioContext || window.webkitAudioContext)();
      const oscilador = contexto.createOscillator();
      const ganho = contexto.createGain();
      oscilador.frequency.value = 880;
      ganho.gain.setValueAtTime(.08, contexto.currentTime);
      ganho.gain.exponentialRampToValueAtTime(.001, contexto.currentTime + .25);
      oscilador.connect(ganho).connect(contexto.destination);
      oscilador.start();
      oscilador.stop(contexto.currentTime + .25);
    } catch (_) { /* áudio é opcional */ }
  }

  function sair() {
    token = null;
    try { sessionStorage.removeItem('bocadinho_admin_token'); } catch (_) { /* indisponível */ }
    $('app-view').hidden = true;
    $('login-view').hidden = false;
    $('token').value = '';
    if (intervalo) clearInterval(intervalo);
  }

  async function entrar(valor) {
    token = valor.trim();
    if (!token) throw new Error('Informe o token administrativo.');
    const resposta = await requisicao('/api/admin/pedidos?status=pago');
    if (!Array.isArray(resposta)) throw new Error('Resposta inválida do servidor.');
    try { sessionStorage.setItem('bocadinho_admin_token', token); } catch (_) { /* opcional */ }
    $('login-view').hidden = true;
    $('app-view').hidden = false;
    primeiraCarga = true;
    pedidosPagosConhecidos = new Set();
    await carregar();
    await carregarProdutosAdmin();
    if (intervalo) clearInterval(intervalo);
    intervalo = setInterval(() => { if (!document.hidden) carregar(); }, 15000);
  }

  $('login-form').addEventListener('submit', async evento => {
    evento.preventDefault();
    const erro = $('login-error');
    erro.hidden = true;
    try { await entrar($('token').value); }
    catch (e) { token = null; erro.textContent = e.status === 401 ? 'Token inválido.' : e.message; erro.hidden = false; }
  });
  $('logout-button').addEventListener('click', sair);
  $('refresh-button').addEventListener('click', carregar);
  $('status-filter').addEventListener('change', carregar);
  $('search').addEventListener('input', renderPedidos);
  $('sound-button').addEventListener('click', () => {
    somAtivo = !somAtivo;
    $('sound-button').textContent = somAtivo ? 'Desativar som' : 'Ativar som';
    $('sound-button').setAttribute('aria-pressed', String(somAtivo));
    if (somAtivo) tocarAviso();
  });

  $('new-product-button').addEventListener('click', () => {
    limparFormularioProduto();
    $('product-form').hidden = false;
    $('product-image').required = true;
    $('product-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('cancel-product-button').addEventListener('click', limparFormularioProduto);
  $('product-form').addEventListener('submit', async evento => {
    evento.preventDefault();
    const botao = $('save-product-button');
    const id = $('product-id').value;
    const preco = Number($('product-price').value);
    if (!Number.isFinite(preco) || preco < 0.01) {
      $('product-message').textContent = 'Informe um preço válido.';
      $('product-message').className = 'message error';
      $('product-message').hidden = false;
      return;
    }
    const dados = new FormData();
    dados.set('nome', $('product-name').value.trim());
    dados.set('descricao', $('product-description').value.trim());
    dados.set('preco_centavos', String(Math.round(preco * 100)));
    dados.set('esgotado', String($('product-sold-out').checked));
    if ($('product-image').files[0]) dados.set('imagem', $('product-image').files[0]);
    botao.disabled = true;
    $('product-message').hidden = true;
    try {
      await requisicao(id ? `/api/admin/produtos/${encodeURIComponent(id)}` : '/api/admin/produtos', {
        method: id ? 'PATCH' : 'POST', body: dados
      });
      limparFormularioProduto();
      mostrarMensagem('Produto salvo no cardápio.');
      await carregarProdutosAdmin();
    } catch (erro) {
      $('product-message').textContent = erro.message || 'Não foi possível salvar o produto.';
      $('product-message').className = 'message error';
      $('product-message').hidden = false;
      if (erro.status === 401) sair();
    } finally {
      botao.disabled = false;
    }
  });

  try {
    const salvo = sessionStorage.getItem('bocadinho_admin_token');
    if (salvo) entrar(salvo).catch(() => { sessionStorage.removeItem('bocadinho_admin_token'); });
  } catch (_) { /* sessão opcional */ }
})();
