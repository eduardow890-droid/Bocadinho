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
  let colunaMobileAtiva = 'novos';
  const colunasRecolhidas = new Set(['finalizados']);
  const detalhesAbertos = new Set();
  let pedidosNovosNaoVistos = new Set();

  const COLUNAS = [
    { id: 'novos', titulo: 'Novos', statuses: ['pago'], icone: '🛍️', vazio: 'Aqui ficarão os novos pedidos pagos.', destaque: true },
    { id: 'preparo', titulo: 'Em preparo', statuses: ['em_preparo'], icone: '🍪', vazio: 'Aqui ficarão os doces em preparo.' },
    { id: 'rota', titulo: 'Pronto / A caminho', statuses: ['enviado'], icone: '🚚', vazio: 'Aqui ficarão os pedidos prontos para sair.' },
    { id: 'finalizados', titulo: 'Finalizados', statuses: ['concluido'], icone: '✓', vazio: 'Aqui ficarão os pedidos entregues e finalizados.' },
    { id: 'atencao', titulo: 'Atenção', statuses: ['pendente', 'revisar', 'estornado'], icone: '⚠️', vazio: 'Nenhum pedido precisa de atenção.' }
  ];

  const dinheiro = centavos => (Number(centavos || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const dataHora = ms => new Date(ms).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  const textoStatus = status => STATUS_LABELS[status] || status;
  const tempoDecorrido = ms => {
    const minutos = Math.max(0, Math.floor((Date.now() - Number(ms || Date.now())) / 60000));
    if (minutos < 1) return 'agora';
    if (minutos < 60) return `há ${minutos} min`;
    const horas = Math.floor(minutos / 60);
    if (horas < 24) return `há ${horas} h`;
    return `há ${Math.floor(horas / 24)} d`;
  };
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

  window.AdminApi = { requisicao: (...a) => requisicao(...a), dinheiro, dataHora, textoStatus };

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

  function tipoPedido(pedido) {
    return pedido.tipo === 'entrega' ? { texto: 'Entrega', icone: '🚲', classe: 'delivery' } : { texto: 'Retirada', icone: '🛍️', classe: 'pickup' };
  }

  function capturaEstadoQuadro() {
    document.querySelectorAll('.kanban-column').forEach(coluna => {
      const id = coluna.dataset.column;
      if (coluna.classList.contains('is-collapsed')) colunasRecolhidas.add(id);
      else colunasRecolhidas.delete(id);
    });
    detalhesAbertos.clear();
    document.querySelectorAll('.order-details[data-pedido-id]').forEach(details => { if (details.open) detalhesAbertos.add(details.dataset.pedidoId); });
  }

  function criarCard(pedido) {
    const tipo = tipoPedido(pedido);
    const naoVisto = pedidosNovosNaoVistos.has(pedido.id);
    const card = el('article', undefined, `order-card${['revisar', 'estornado', 'pendente'].includes(pedido.status) ? ' urgent' : ''}${naoVisto ? ' is-unseen' : ''}`);
    card.dataset.pedidoId = pedido.id;
    const head = el('div', undefined, 'order-head');
    const titleBox = el('div');
    titleBox.append(el('h2', `Pedido #${pedido.id.slice(0, 8)}`, 'order-code'));
    titleBox.append(el('p', pedido.nome || 'Cliente não informado', 'order-customer'));
    titleBox.append(el('p', `${dataHora(pedido.criado_em)} · ${tempoDecorrido(pedido.criado_em)}`, 'order-meta'));
    const badge = el('span', textoStatus(pedido.status), `badge ${pedido.status}`);
    head.append(titleBox, badge);
    card.append(head);

    const selo = el('span', `${tipo.icone} ${tipo.texto}`, `order-type ${tipo.classe}`);
    card.append(selo);
    const itens = el('ul', undefined, 'order-items');
    (pedido.itens || []).slice(0, 2).forEach(item => {
      const linha = el('li');
      linha.append(el('span', `${item.qtd}x ${item.nome}`), el('strong', dinheiro(item.qtd * item.preco_unit_centavos)));
      itens.append(linha);
    });
    const extras = (pedido.itens || []).slice(2);
    if (extras.length) {
      const mais = el('div', undefined, 'extra-items');
      mais.hidden = true;
      extras.forEach(item => {
        const linha = el('div', undefined, 'extra-item');
        linha.append(el('span', `${item.qtd}x ${item.nome}`), el('strong', dinheiro(item.qtd * item.preco_unit_centavos)));
        mais.append(linha);
      });
      const verMais = el('button', `Ver mais ${extras.length} item${extras.length > 1 ? 's' : ''}`, 'items-more-toggle');
      verMais.type = 'button';
      verMais.addEventListener('click', () => {
        mais.hidden = !mais.hidden;
        verMais.textContent = mais.hidden ? `Ver mais ${extras.length} item${extras.length > 1 ? 's' : ''}` : 'Ver menos';
      });
      card.append(itens, mais, verMais);
    } else card.append(itens);
    card.append(el('p', `Total: ${dinheiro(pedido.total_centavos)}`, 'order-total'));

    if (pedido.obs) card.append(el('p', `Observação: ${pedido.obs}`, 'order-note'));
    if (pedido.status === 'pendente') {
      const pagamentoRecusado = pedido.metodo_pagamento && ['credit_card', 'debit_card'].includes(pedido.metodo_pagamento)
        && pedido.status_pagamento === 'rejected';
      const statusPagamentoTexto = {
        pending: 'pendente', in_process: 'em análise', processing: 'em processamento',
        action_required: 'aguardando ação', rejected: 'recusado', approved: 'aprovado'
      }[pedido.status_pagamento] || pedido.status_pagamento;
      const detalhePagamento = statusPagamentoTexto
        ? ` Status do pagamento: ${statusPagamentoTexto}.`
        : '';
      const aviso = pagamentoRecusado
        ? `Atenção: o Mercado Pago recusou a tentativa de cartão. O pedido continua sem confirmação; não inicie o preparo.${detalhePagamento}`
        : `Atenção: o pagamento ainda não foi confirmado. Aguarde a atualização ou confira no Mercado Pago; não inicie o preparo.${detalhePagamento}`;
      card.append(el('p', aviso, 'warning'));
    }
    if (pedido.status === 'revisar') card.append(el('p', 'Atenção: pagamento fora das condições esperadas ou recebido após expiração. Não avance sem conferência manual.', 'warning'));
    if (pedido.status === 'estornado') card.append(el('p', 'Atenção: este pagamento foi estornado. Não avance o pedido.', 'warning'));

    const details = el('details', undefined, 'order-details');
    details.dataset.pedidoId = pedido.id;
    details.open = detalhesAbertos.has(pedido.id);
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
    const revogar = el('button', 'Revogar acesso', 'button secondary');
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

  function dataDoPedido(pedido) {
    const data = new Date(Number(pedido.criado_em));
    return new Date(data.getFullYear(), data.getMonth(), data.getDate()).getTime();
  }

  function passaFiltros(pedido) {
    const busca = $('search').value.trim().toLocaleLowerCase('pt-BR');
    const tipo = $('type-filter').value;
    const periodo = $('period-filter').value;
    const status = $('status-filter').value;
    const textoBusca = [pedido.nome, pedido.telefone, pedido.id, pedido.id?.slice(0, 8)].join(' ').toLocaleLowerCase('pt-BR');
    if (busca && !textoBusca.includes(busca)) return false;
    if (tipo && pedido.tipo !== tipo) return false;
    if (status && pedido.status !== status) return false;
    if (periodo) {
      const hoje = new Date();
      const hojeInicio = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate()).getTime();
      const dia = dataDoPedido(pedido);
      if (periodo === 'hoje' && dia !== hojeInicio) return false;
      if (periodo === 'ontem' && dia !== hojeInicio - 86400000) return false;
      if (periodo === '7dias' && (dia < hojeInicio - 6 * 86400000 || dia > hojeInicio)) return false;
    }
    return true;
  }

  function criarColuna(coluna, pedidosDaColuna) {
    const section = el('section', undefined, `kanban-column${coluna.destaque ? ' is-highlighted' : ''}${colunasRecolhidas.has(coluna.id) ? ' is-collapsed' : ''}`);
    section.dataset.column = coluna.id;
    const header = el('header', undefined, 'kanban-column-header');
    const titulo = el('div', undefined, 'kanban-column-title');
    titulo.append(el('span', coluna.icone, 'kanban-icon'), el('h2', coluna.titulo));
    const contador = el('span', String(pedidosDaColuna.length), 'column-count');
    titulo.append(contador);
    const toggle = el('button', section.classList.contains('is-collapsed') ? '▸' : '▾', 'kanban-column-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', String(!section.classList.contains('is-collapsed')));
    toggle.setAttribute('aria-label', `Recolher coluna ${coluna.titulo}`);
    toggle.addEventListener('click', () => {
      const recolhida = section.classList.toggle('is-collapsed');
      colunasRecolhidas[recolhida ? 'add' : 'delete'](coluna.id);
      toggle.textContent = recolhida ? '▸' : '▾';
      toggle.setAttribute('aria-expanded', String(!recolhida));
    });
    header.append(titulo, toggle);
    section.append(header);
    const body = el('div', undefined, 'kanban-column-body');
    if (!pedidosDaColuna.length) {
      const vazio = el('div', undefined, 'kanban-empty');
      vazio.append(el('span', coluna.icone, 'kanban-empty-icon'), el('p', coluna.vazio));
      body.append(vazio);
    } else pedidosDaColuna.forEach(pedido => body.append(criarCard(pedido)));
    section.append(body);
    return section;
  }

  function renderAbas(colunas) {
    const tabs = $('kanban-tabs');
    tabs.replaceChildren();
    colunas.forEach(coluna => {
      const botao = el('button', undefined, `kanban-tab${coluna.id === colunaMobileAtiva ? ' is-active' : ''}`);
      botao.type = 'button';
      botao.dataset.column = coluna.id;
      botao.setAttribute('aria-selected', String(coluna.id === colunaMobileAtiva));
      botao.append(el('span', coluna.titulo), el('strong', String(coluna.pedidos.length)));
      botao.addEventListener('click', () => {
        colunaMobileAtiva = coluna.id;
        renderPedidos();
      });
      tabs.append(botao);
    });
  }

  function renderPedidos() {
    capturaEstadoQuadro();
    const lista = $('orders');
    lista.dataset.activeColumn = colunaMobileAtiva;
    lista.replaceChildren();
    const colunas = COLUNAS.map(coluna => ({ ...coluna, pedidos: pedidos.filter(pedido => coluna.statuses.includes(pedido.status) && passaFiltros(pedido)) }));
    renderAbas(colunas);
    colunas.forEach(coluna => lista.append(criarColuna(coluna, coluna.pedidos)));
    pedidosNovosNaoVistos.clear();
  }

  async function carregar() {
    if (!token) return;
    const lista = $('orders');
    lista.setAttribute('aria-busy', 'true');
    try {
      const [resumo, novaLista] = await Promise.all([
        requisicao('/api/admin/resumo'),
        requisicao('/api/admin/pedidos')
      ]);
      const novosPagos = novaLista.filter(p => p.status === 'pago' && !pedidosPagosConhecidos.has(p.id));
      if (!primeiraCarga && novosPagos.length) {
        $('notice').textContent = `${novosPagos.length} novo${novosPagos.length > 1 ? 's' : ''} pedido${novosPagos.length > 1 ? 's' : ''} pago${novosPagos.length > 1 ? 's' : ''}.`;
        $('notice').hidden = false;
        if (somAtivo) tocarAviso();
      }
      if (!primeiraCarga) novosPagos.forEach(pedido => pedidosNovosNaoVistos.add(pedido.id));
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
    const pergunta = status === 'concluido'
      ? 'Finalizar este pedido? Esta ação confirma que ele foi entregue ou retirado.'
      : `Confirmar mudança para “${textoStatus(status)}”?`;
    if (!window.confirm(pergunta)) return;
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
  $('status-filter').addEventListener('change', renderPedidos);
  $('type-filter').addEventListener('change', renderPedidos);
  $('period-filter').addEventListener('change', renderPedidos);
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
