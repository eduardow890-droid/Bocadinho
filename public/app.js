/* Front da Bocadinho: catálogo e preços vêm do servidor (/api/produtos).
   O site envia só ids e quantidades; o servidor recalcula o total e gera o Pix. */
let PRODUTOS=[];
const $=id=>document.getElementById(id),v=id=>$(id).value.trim(),q={};
const brl=centavos=>(centavos/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const box=$('items');
const reduzirMovimento=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const quantidadesAnteriores={};
const CHAVE='bocadinho_pedido';
const CHAVE_CARRINHO='bocadinho_carrinho',CHAVE_RASCUNHO='bocadinho_rascunho';
const CAMPOS_RASCUNHO=['nome','telefone','email','rua','numero','complemento','regiao','cidade','obs'];
const PRAZO_RASCUNHO_MS=7*24*60*60*1000;
let totalExibido=0,frameTotal=0,pedidoAtual=null,timerPoll=0,timerRelogio=0,cardBrick=null,mpPublicKey='';
let emailCartaoAtual='';
let retryingCard=false;
let checkoutEtapa=1;

function tokenAleatorio(){
	const bytes=new Uint8Array(32);
	window.crypto.getRandomValues(bytes);
	let binario='';
	bytes.forEach(byte=>{binario+=String.fromCharCode(byte)});
	return btoa(binario).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

function lerPedidoSalvo(){
	try{
		const salvo=localStorage.getItem(CHAVE);
		if(!salvo)return null;
		try{
			const dados=JSON.parse(salvo);
			if(dados&&typeof dados==='object'&&typeof dados.token==='string')return dados;
		}catch(_){/* formato antigo: somente o UUID do pedido */}
		return {id:salvo,token:salvo,legado:true};
	}catch(_){return null}
}

function salvarPedido(dados){
	try{localStorage.setItem(CHAVE,JSON.stringify(dados))}catch(_){/* retomada opcional */}
}

const STATUS_PEDIDO={
	pendente:{titulo:'Aguardando pagamento',detalhe:'Escaneie o QR Code ou use o Pix copia e cola.',etapa:0},
	pago:{titulo:'Pagamento confirmado',detalhe:'Recebemos seu pedido. A loja vai iniciar o preparo.',etapa:1},
	em_preparo:{titulo:'Pedido em preparo',detalhe:'Seu pedido está sendo preparado com carinho.',etapa:2},
	enviado:{titulo:'Pedido enviado',detalhe:'Seu pedido saiu para entrega ou está pronto para retirada.',etapa:3},
	concluido:{titulo:'Pedido concluído',detalhe:'Obrigado por comprar com a Bocadinho!',etapa:4},
	cancelado:{titulo:'Pedido cancelado',detalhe:'Este pedido não será processado.',etapa:-1},
	expirado:{titulo:'Pix expirado',detalhe:'O prazo para pagamento terminou. Faça um novo pedido.',etapa:-1},
	estornado:{titulo:'Pagamento estornado',detalhe:'O pagamento foi estornado. Entre em contato com a loja se precisar de ajuda.',etapa:-1},
	revisar:{titulo:'Pedido em análise',detalhe:'A loja precisa verificar este pagamento. Entre em contato pelo WhatsApp.',etapa:-1}
};
const STATUS_FINAIS=new Set(['concluido','cancelado','expirado','estornado','revisar']);
const STATUS_PAGAMENTO_EM_ANALISE=new Set(['pending','in_process','processing','action_required']);
const METODOS_CARTAO=new Set(['credit_card','debit_card']);
const STATUS_PAGAMENTO_RECUSADO=new Set(['failed','rejected']);

/* ---------- permanência: carrinho e rascunho do checkout (somente neste aparelho) ---------- */
function salvarCarrinho(){
	try{
		const itens={};
		PRODUTOS.forEach(p=>{if(q[p.id]>0)itens[p.id]=q[p.id]});
		if(Object.keys(itens).length)localStorage.setItem(CHAVE_CARRINHO,JSON.stringify({v:1,itens}));
		else localStorage.removeItem(CHAVE_CARRINHO);
	}catch(_){/* armazenamento indisponível */}
	window.dispatchEvent(new Event('bocadinho:carrinho'));
}
function restaurarCarrinho(){
	try{
		const dados=JSON.parse(localStorage.getItem(CHAVE_CARRINHO));
		if(!dados||dados.v!==1||typeof dados.itens!=='object')return;
		PRODUTOS.forEach(p=>{const n=Number(dados.itens[p.id]);if(Number.isInteger(n)&&n>=1&&!p.esgotado)q[p.id]=Math.min(99,n)});
	}catch(_){}
}
function salvarRascunho(){
	try{
		const d={v:1,t:Date.now(),tipo:entrega()?'entrega':'retirada',etapa:checkoutEtapa};
		CAMPOS_RASCUNHO.forEach(c=>{d[c]=$(c).value});
		localStorage.setItem(CHAVE_RASCUNHO,JSON.stringify(d));
	}catch(_){}
}
function restaurarRascunho(){
	try{
		const d=JSON.parse(localStorage.getItem(CHAVE_RASCUNHO));
		if(!d||d.v!==1||Date.now()-d.t>PRAZO_RASCUNHO_MS)return;
		CAMPOS_RASCUNHO.forEach(c=>{if(typeof d[c]==='string'&&d[c])$(c).value=d[c].slice(0,300)});
		const r=document.querySelector('input[name=tipo][value="'+(d.tipo==='retirada'?'retirada':'entrega')+'"]');
		if(r)r.checked=true;
		if(d.etapa>=2&&sel().length)irParaEtapa(2);
	}catch(_){}
}
function limparPersistencia(){
	try{localStorage.removeItem(CHAVE_CARRINHO);localStorage.removeItem(CHAVE_RASCUNHO)}catch(_){}
	window.dispatchEvent(new Event('bocadinho:carrinho'));
}

function reiniciarAnimacao(elemento,classe){
	elemento.classList.remove(classe);
	void elemento.offsetWidth;
	elemento.classList.add(classe);
}

/* ---------- catálogo ---------- */
async function carregarProdutos(){
	const r=await fetch('/api/produtos');
	if(!r.ok)throw new Error('produtos');
	PRODUTOS=await r.json();
}

function montarProdutos(){
	box.innerHTML='';
	PRODUTOS.forEach(p=>{
		q[p.id]=0;
		quantidadesAnteriores[p.id]=0;
		const d=document.createElement('div');
		d.className='item'+(p.esgotado?' is-sold-out':'');
		d.innerHTML=(p.imagem_url?'<img class="product-image" src="'+esc(p.imagem_url)+'" alt="Foto de '+esc(p.nome)+'" loading="lazy" decoding="async">':'<div class="product-image product-image-placeholder" aria-hidden="true">🍪</div>')+'<div class="item-copy"><b>'+esc(p.nome)+'</b><small>'+esc(p.descricao||'Doce artesanal feito pela Bocadinho.')+'</small><div class="pr">'+brl(p.preco_centavos)+'</div>'+(p.esgotado?'<strong class="sold-out-label">Esgotado</strong>':'')+'</div><div class="qty"><button type="button" data-id="'+esc(p.id)+'" data-d="-1" aria-label="Diminuir '+esc(p.nome)+'"'+(p.esgotado?' disabled':'')+'>−</button><span id="q_'+esc(p.id)+'" aria-live="polite">0</span><button type="button" data-id="'+esc(p.id)+'" data-d="1" aria-label="Adicionar '+esc(p.nome)+'"'+(p.esgotado?' disabled':'')+'>+</button></div>';
		box.appendChild(d);
	});
	$('cart-summary').open=window.matchMedia('(min-width: 701px)').matches;
}

box.addEventListener('click',e=>{
	const b=e.target.closest('button');
	if(!b)return;
	const id=b.dataset.id;
	const produto=PRODUTOS.find(p=>p.id===id);
	if(!produto||produto.esgotado)return;
	const quantidadeAnterior=q[id];
	q[id]=Math.max(0,Math.min(99,q[id]+Number(b.dataset.d)));
	if(quantidadeAnterior===0&&q[id]===1)reiniciarAnimacao(b.closest('.item'),'is-highlighted');
	box.classList.remove('is-invalid');
	render();
});

const entrega=()=>document.querySelector('input[name=tipo]:checked').value==='entrega';
const sel=()=>PRODUTOS.filter(p=>q[p.id]>0);
const total=()=>sel().reduce((s,p)=>s+q[p.id]*p.preco_centavos,0); // centavos (estimativa; o servidor recalcula)

function animarTotal(destino){
	const valor=$('total-valor');
	if(!valor)return;
	cancelAnimationFrame(frameTotal);
	if(reduzirMovimento){
		totalExibido=destino;
		valor.textContent=brl(destino);
		return;
	}
	const inicio=performance.now(),origem=totalExibido;
	function atualizar(agora){
		const progresso=Math.min((agora-inicio)/400,1);
		const suavizado=1-Math.pow(1-progresso,3);
		totalExibido=origem+(destino-origem)*suavizado;
		valor.textContent=brl(Math.round(totalExibido));
		if(progresso<1)frameTotal=requestAnimationFrame(atualizar);
		else totalExibido=destino;
	}
	frameTotal=requestAnimationFrame(atualizar);
}

function render(){
	PRODUTOS.forEach(p=>{
		const quantidade=$('q_'+p.id);
		if(!quantidade)return;
		quantidade.textContent=q[p.id];
		const mais=box.querySelector('button[data-id="'+CSS.escape(p.id)+'"][data-d="1"]');
		if(mais)mais.disabled=Boolean(p.esgotado)||q[p.id]>=99;
		const menos=box.querySelector('button[data-id="'+CSS.escape(p.id)+'"][data-d="-1"]');
		if(menos)menos.disabled=Boolean(p.esgotado)||q[p.id]===0;
		if(q[p.id]!==quantidadesAnteriores[p.id]&&!reduzirMovimento)reiniciarAnimacao(quantidade,'is-bumping');
		quantidadesAnteriores[p.id]=q[p.id];
	});
	const s=sel(),destino=total();
	$('resumo').replaceChildren();
	if(s.length){
		s.forEach(p=>{const linha=document.createElement('div');linha.className='r';const nome=document.createElement('span');nome.textContent=q[p.id]+'x '+p.nome;const subtotal=document.createElement('span');subtotal.textContent=brl(q[p.id]*p.preco_centavos);linha.append(nome,subtotal);$('resumo').append(linha)});
		const totalLinha=document.createElement('div');totalLinha.className='tot';const rotulo=document.createElement('span');rotulo.textContent='Total dos produtos';const valor=document.createElement('span');valor.id='total-valor';valor.textContent=brl(Math.round(totalExibido));totalLinha.append(rotulo,valor);$('resumo').append(totalLinha);
		const nota=document.createElement('small');nota.textContent=entrega()?'Entrega pelo Uber Envios paga separadamente; valor e prazo combinados pelo WhatsApp.':'Retirada no local, sem taxa de entrega.';$('resumo').append(nota);
	}else $('resumo').append(document.createTextNode('Nenhum item selecionado ainda.'));
	$('cart-summary-count').textContent=s.reduce((n,p)=>n+q[p.id],0)+' '+(s.reduce((n,p)=>n+q[p.id],0)===1?'item':'itens');
	$('cart-summary-total').textContent=brl(destino);
	$('endwrap').hidden=!entrega();
	$('delivery-note').hidden=!entrega();
	$('review-delivery-note').hidden=!entrega();
	if(s.length)animarTotal(destino);
	else{cancelAnimationFrame(frameTotal);totalExibido=0;}
	if(PRODUTOS.length)salvarCarrinho();
}

/* ---------- validação (só UX; o servidor valida tudo de novo) ---------- */
const telefoneLimpo=()=>v('telefone').replace(/\D/g,'').replace(/^55(?=\d{10,11}$)/,'');
const telefoneOk=()=>/^[1-9]{2}(9\d{8}|[2-5]\d{7})$/.test(telefoneLimpo());
const emailOk=()=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v('email'));

function validarProdutos(){
	if(!sel().length)return{msg:'Escolha pelo menos um produto.',campo:box};
	return null;
}

function validarDados(){
	if(v('nome').length<2)return{msg:'Informe seu nome (pelo menos 2 caracteres).',campo:$('nome')};
	if(!telefoneOk())return{msg:'Informe um telefone válido com DDD.',campo:$('telefone')};
	if(!emailOk())return{msg:'Informe um e-mail válido.',campo:$('email')};
	if(entrega()&&v('rua').length<3)return{msg:'Informe a rua da entrega.',campo:$('rua')};
	if(entrega()&&!v('numero').length)return{msg:'Informe o número do endereço.',campo:$('numero')};
	if(entrega()&&v('regiao').length<2)return{msg:'Informe o bairro.',campo:$('regiao')};
	if(entrega()&&v('cidade').length<2)return{msg:'Informe a cidade.',campo:$('cidade')};
	return null;
}

function renderRevisao(){
	const area=$('order-review');
	area.replaceChildren();
	const lista=document.createElement('ul');lista.className='review-items';
	sel().forEach(p=>{const linha=document.createElement('li');const nome=document.createElement('span');nome.textContent=q[p.id]+' × '+p.nome;const preco=document.createElement('strong');preco.textContent=brl(q[p.id]*p.preco_centavos);linha.append(nome,preco);lista.append(linha)});
	area.append(lista);
	const totalBox=document.createElement('p');totalBox.className='review-total';totalBox.textContent='Total dos produtos: '+brl(total());area.append(totalBox);
	const contato=document.createElement('section');contato.className='review-details';
	const contatoTitulo=document.createElement('h4');contatoTitulo.textContent='Contato';contato.append(contatoTitulo);
	[["Nome",v('nome')],["WhatsApp",v('telefone')],["E-mail",v('email')]].forEach(([rotulo,valor])=>{const p=document.createElement('p');p.textContent=rotulo+': '+valor;contato.append(p)});
	const receber=document.createElement('section');receber.className='review-details';
	const receberTitulo=document.createElement('h4');receberTitulo.textContent=entrega()?'Endereço de entrega':'Retirada';receber.append(receberTitulo);
	if(entrega()){
		const linhasEndereco=[`${v('rua')}, ${v('numero')}`,v('complemento'),`${v('regiao')} — ${v('cidade')}`].filter(Boolean);
		linhasEndereco.forEach(texto=>{const p=document.createElement('p');p.textContent=texto;receber.append(p)});
	}else{const p=document.createElement('p');p.textContent='A loja enviará as instruções de retirada após a confirmação.';receber.append(p)}
	if(v('obs')){const obs=document.createElement('section');obs.className='review-details';const h=document.createElement('h4');h.textContent='Observação';const p=document.createElement('p');p.textContent=v('obs');obs.append(h,p);area.append(obs)}
	area.append(contato,receber);
	if(window.Conta)window.Conta.anotarRevisao(area);
}

function irParaEtapa(etapa){
	checkoutEtapa=etapa;
	document.querySelectorAll('.checkout-step').forEach((painel,i)=>{painel.hidden=i+1!==etapa;panelState(painel,i+1===etapa)});
	document.querySelectorAll('[data-checkout-progress]').forEach(item=>{
		const numero=Number(item.dataset.checkoutProgress);
		item.classList.toggle('is-current',numero===etapa);
		item.classList.toggle('is-complete',numero<etapa);
		if(numero===etapa)item.setAttribute('aria-current','step');else item.removeAttribute('aria-current');
	});
	if(etapa===3)renderRevisao();
	salvarRascunho();
	const titulo=$(`checkout-title-${etapa}`);
	if(titulo){titulo.setAttribute('tabindex','-1');titulo.focus({preventScroll:true})}
}

function panelState(painel,ativo){
	painel.classList.toggle('is-current',ativo);
	painel.setAttribute('aria-hidden',String(!ativo));
}

function limparValidacao(){
	document.querySelectorAll('.form .is-invalid').forEach(campo=>{
		campo.classList.remove('is-invalid','is-shaking');
		campo.removeAttribute('aria-invalid');
	});
	box.classList.remove('is-invalid','is-shaking');
}

function marcar(campo){
	if(campo===box){
		box.classList.add('is-invalid');
		const b=box.querySelector('button');
		if(b)b.focus();
	}else{
		campo.classList.add('is-invalid');
		campo.setAttribute('aria-invalid','true');
		campo.focus();
	}
	reiniciarAnimacao(campo,'is-shaking');
}

function definirTipoEntrega(){
	const entregaAtiva=entrega();
	$('endwrap').hidden=!entregaAtiva;
	$('delivery-note').hidden=!entregaAtiva;
	$('retirada-ajuda').hidden=entregaAtiva;
	['rua','numero','regiao','cidade'].forEach(id=>{$(id).required=entregaAtiva});
	render();
}

/* ---------- envio do pedido ---------- */
async function enviarPedido(){
	const btn=$('enviar');
	btn.disabled=true;
	const metodoPagamento=document.querySelector('input[name="metodo-pagamento"]:checked')?.value||'pix';
	btn.textContent=metodoPagamento==='cartao'?'Preparando cartão...':'Gerando Pix...';
	let acesso=lerPedidoSalvo();
	if(!acesso||acesso.id||acesso.legado)acesso={id:null,token:tokenAleatorio()};
	salvarPedido(acesso);
	try{
		const r=await fetch('/api/pedidos',{
			method:'POST',
			headers:{'Content-Type':'application/json','x-order-access-token':acesso.token},
			body:JSON.stringify({
				metodoPagamento,
				nome:v('nome'),email:v('email'),telefone:v('telefone'),
				tipo:entrega()?'entrega':'retirada',regiao:v('regiao'),cidade:v('cidade'),
				rua:v('rua'),numero:v('numero'),complemento:v('complemento'),
				endereco:entrega()?[v('rua'),v('numero'),v('complemento')].filter(Boolean).join(', '):'',obs:v('obs'),
				itens:sel().map(p=>({id:p.id,qtd:q[p.id]}))
			})
		});
		const d=await r.json().catch(()=>({}));
		if(!r.ok){
			$('erro').textContent=d.erro||'Não foi possível criar o pedido.';
			const chave=d.campos&&Object.keys(d.campos)[0];
			if(chave==='itens'){irParaEtapa(1);marcar(box)}
			else if(chave&&$(chave)){irParaEtapa(2);$('data-error').textContent=d.campos[chave];marcar($(chave))}
			return;
		}
		acesso.id=d.id;
		salvarPedido(acesso);
		if(metodoPagamento==='cartao')mostrarCartao(d,acesso.token);
		else mostrarPix(d,acesso.token);
	}catch(e){
		$('erro').textContent='Sem conexão. Seus dados de retomada foram preservados; tente novamente sem recarregar ou fechar a página.';
	}finally{
		btn.disabled=false;
		btn.textContent='Confirmar e pagar';
	}
}

$('continue-to-data').addEventListener('click',()=>{
	limparValidacao();
	const falha=validarProdutos();
	$('products-error').textContent=falha?falha.msg:'';
	if(falha){marcar(falha.campo);return}
	$('data-error').textContent='';
	irParaEtapa(2);
});
$('back-to-products').addEventListener('click',()=>irParaEtapa(1));
$('back-to-data').addEventListener('click',()=>irParaEtapa(2));
$('continue-to-review').addEventListener('click',()=>{
	limparValidacao();
	const falha=validarDados();
	$('data-error').textContent=falha?falha.msg:'';
	if(falha){marcar(falha.campo);return}
	$('erro').textContent='';
	irParaEtapa(3);
});
$('enviar').addEventListener('click',()=>{
	const falha=validarProdutos()||validarDados();
	if(falha){
		$('erro').textContent=falha.msg;
		irParaEtapa(falha.campo===box?1:2);
		marcar(falha.campo);
		return;
	}
	$('erro').textContent='';
	enviarPedido();
});

document.querySelector('#dados .form').addEventListener('input',e=>{
	if(e.target.id==='pix-code')return;
	$('erro').textContent='';
	limparValidacao();
	render();
	salvarRascunho();
});

document.querySelectorAll('input[name=tipo]').forEach(opcao=>opcao.addEventListener('change',()=>{
	$('erro').textContent='';
	$('data-error').textContent='';
	definirTipoEntrega();
}));

async function inicializarCartao(d,tokenAcesso){
	if(!window.MercadoPago)throw new Error('SDK do Mercado Pago não carregou.');
	if(!mpPublicKey)throw new Error('A chave pública do Mercado Pago não está configurada.');
	if(cardBrick?.unmount)await cardBrick.unmount();
	$('cardPaymentBrick_container').replaceChildren();
	const mp=new MercadoPago(mpPublicKey,{locale:'pt-BR'});
	const bricks=mp.bricks();
	cardBrick=await bricks.create('cardPayment','cardPaymentBrick_container',{
		initialization:{amount:d.total_centavos/100,payer:{email:$('email').value.trim()||emailCartaoAtual}},
		callbacks:{
			onReady:()=>{
				$('cartao-tentar-novamente').hidden=true;
			},
				onSubmit:async(formData,additionalData)=>{
					// Algumas versões do Brick não devolvem payer.email quando ele
					// não foi informado na inicialização; o backend usa o e-mail do pedido.
					const payer={...(formData.payer||{}),email:$('email').value.trim()};
					const deviceId=window.MP_DEVICE_SESSION_ID||'';
				const r=await fetch('/api/pedidos/'+encodeURIComponent(d.id)+'/cartao',{
						method:'POST',headers:{'Content-Type':'application/json','x-order-access-token':tokenAcesso,...(deviceId?{'x-meli-session-id':deviceId}:{})},
					body:JSON.stringify({...formData,payer,payment_type_id:additionalData?.paymentTypeId||'credit_card'})
				});
				const resposta=await r.json().catch(()=>({}));
				if(!r.ok)throw new Error(resposta.erro||'Não foi possível processar o cartão.');
				retryingCard=false;
				mostrarStatusPagamento(resposta,tokenAcesso);
			},
			onError:erro=>{
				console.error('[cartao-brick]',erro);
				retryingCard=false;
				$('cartao-erro').textContent='Não foi possível carregar ou continuar o formulário de cartão. Tente recarregá-lo ou fale com a loja pelo WhatsApp.';
				$('cartao-tentar-novamente').textContent='Recarregar formulário';
				$('cartao-tentar-novamente').hidden=false;
				$('cartao-tentar-novamente').disabled=false;
			}
		}
	});
}

function mostrarCartao(d,tokenAcesso){
	pedidoAtual={id:d.id,token:tokenAcesso||lerPedidoSalvo()?.token,fim:Date.now()+d.restante_ms,total_centavos:d.total_centavos};
	emailCartaoAtual=$('email').value.trim();
	$('dados').hidden=true;$('cart-summary').hidden=true;$('checkout-progress').hidden=true;
	$('pix').hidden=true;$('cartao-pagamento').hidden=false;
	$('cartao-erro').textContent='';
	$('cartao-tentar-novamente').hidden=true;
	$('pix-status').textContent='Aguardando pagamento';
	$('pix-status-detail').textContent='Preencha os dados do cartão abaixo.';
	inicializarCartao(d,tokenAcesso).catch(e=>{
		console.error('[cartao-brick]',e);
		$('cartao-erro').textContent='Não foi possível carregar o formulário de cartão. Confirme as credenciais públicas do Mercado Pago e tente novamente.';
		$('cartao-tentar-novamente').textContent='Recarregar formulário';
		$('cartao-tentar-novamente').hidden=false;
	});
	$('cartao-pagamento').scrollIntoView({behavior:reduzirMovimento?'auto':'smooth',block:'center'});
}

function mostrarStatusPagamento(d,tokenAcesso){
	pedidoAtual={id:d.id,token:tokenAcesso||lerPedidoSalvo()?.token,fim:Date.now()+d.restante_ms,total_centavos:d.total_centavos};
	$('cartao-tentar-novamente').hidden=true;
	if(d.status==='pendente'&&METODOS_CARTAO.has(d.metodo_pagamento)&&STATUS_PAGAMENTO_RECUSADO.has(d.status_pagamento)){
		exibirRecusaCartao();
		iniciarPolling();
		$('cartao-pagamento').scrollIntoView({behavior:reduzirMovimento?'auto':'smooth',block:'center'});
		return;
	}
	$('cartao-pagamento').hidden=true;
	$('pix').hidden=false;
	mostrarPix(d,tokenAcesso);
}

function exibirRecusaCartao(){
	$('dados').hidden=true;
	$('cart-summary').hidden=true;
	$('checkout-progress').hidden=true;
	$('pix').hidden=true;
	$('cartao-pagamento').hidden=false;
	if(!retryingCard){
		$('cartao-erro').textContent='O Mercado Pago não aprovou esta tentativa. Confira os dados ou tente outro cartão. O pedido ainda não foi confirmado. Se o problema continuar, fale com a loja pelo WhatsApp.';
		$('cartao-tentar-novamente').textContent='Tentar outro cartão';
		$('cartao-tentar-novamente').hidden=false;
		$('cartao-tentar-novamente').disabled=false;
	}
}

async function tentarNovamenteCartao(){
	if(!pedidoAtual||!pedidoAtual.total_centavos)return;
	const botao=$('cartao-tentar-novamente');
	botao.disabled=true;
	botao.hidden=true;
	retryingCard=true;
	$('cartao-erro').textContent='';
	try{
		await inicializarCartao(pedidoAtual,pedidoAtual.token);
		$('cartao-pagamento').scrollIntoView({behavior:reduzirMovimento?'auto':'smooth',block:'center'});
	}catch(e){
		retryingCard=false;
		console.error('[cartao-brick]',e);
		$('cartao-erro').textContent='Não foi possível recarregar o formulário de cartão. Tente novamente ou fale com a loja pelo WhatsApp.';
		botao.textContent='Recarregar formulário';
		botao.hidden=false;
		botao.disabled=false;
	}
}

/* ---------- painel do Pix ---------- */
function exibirDadosPix(d){
	const disponivel=Boolean(d.pix);
	const qr=$('pix-qr');
	if(disponivel&&d.pix.qrBase64){
		qr.src='data:image/png;base64,'+d.pix.qrBase64;
		qr.hidden=false;
	}else{
		qr.removeAttribute('src');
		qr.hidden=true;
	}
	$('pix-code-label').hidden=!disponivel;
	$('pix-code').hidden=!disponivel;
	$('pix-copiar').hidden=!disponivel;
	$('pix-code').value=disponivel?(d.pix.copiaECola||''):'';
	$('pix-total').textContent=brl(d.total_centavos);
	if(d.status==='pendente'&&!disponivel){
		$('pix-status').textContent='Preparando seu Pix';
		$('pix-status-detail').textContent='Estamos finalizando a cobrança. Esta tela será atualizada automaticamente; não faça outro pedido.';
	}
}

function mostrarPix(d,tokenAcesso){
	pedidoAtual={id:d.id,token:tokenAcesso||lerPedidoSalvo()?.token,fim:Date.now()+d.restante_ms,total_centavos:d.total_centavos};
	if(d.status==='pendente'&&METODOS_CARTAO.has(d.metodo_pagamento)&&STATUS_PAGAMENTO_RECUSADO.has(d.status_pagamento)){
		exibirRecusaCartao();
		iniciarPolling();
		$('cartao-pagamento').scrollIntoView({behavior:reduzirMovimento?'auto':'smooth',block:'center'});
		return;
	}
	$('dados').hidden=true;
	$('cart-summary').hidden=true;
	$('checkout-progress').hidden=true;
	$('pix').hidden=false;
	$('pix-corpo').hidden=false;
	const pagamentoCartao=METODOS_CARTAO.has(d.metodo_pagamento);
	$('pix-titulo').textContent=pagamentoCartao||d.status!=='pendente'?'Acompanhe seu pedido':'Pague com Pix';
	$('pix-novo').hidden=true;
	exibirDadosPix(d);
	atualizarStatus(d.status);
	if(d.status==='pendente'&&pagamentoCartao){
		const aguardandoAnalise=STATUS_PAGAMENTO_EM_ANALISE.has(d.status_pagamento);
		$('pix-status').textContent=aguardandoAnalise?'Pagamento em análise':'Aguardando confirmação do pagamento';
		$('pix-status-detail').textContent='O Mercado Pago ainda não confirmou este pagamento. O pedido só será confirmado após a aprovação; não faça outra cobrança. Esta tela será atualizada automaticamente.';
		$('pix-corpo').hidden=true;
	}else if(d.status==='pendente'&&!d.pix){
		$('pix-status').textContent='Preparando seu Pix';
		$('pix-status-detail').textContent='Estamos finalizando a cobrança. Esta tela será atualizada automaticamente; não faça outro pedido.';
	}
	$('pix-cancelar').hidden=d.status!=='pendente'||pagamentoCartao;
	$('pix-cancelar').disabled=false;
	if(d.status==='pendente'&&!pagamentoCartao)iniciarRelogio();
	else $('pix-corpo').hidden=true;
	iniciarPolling();
	$('pix').scrollIntoView({behavior:reduzirMovimento?'auto':'smooth',block:'center'});
}

function iniciarRelogio(){
	clearInterval(timerRelogio);
	const atualizar=()=>{
		if(!pedidoAtual){clearInterval(timerRelogio);return;}
		const s=Math.max(0,Math.floor((pedidoAtual.fim-Date.now())/1000));
		$('pix-tempo').textContent='Este Pix expira em '+String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');
	};
	atualizar();
	timerRelogio=setInterval(atualizar,1000);
}

function iniciarPolling(){
	clearInterval(timerPoll);
	consultarStatus();
	timerPoll=setInterval(async()=>{
		consultarStatus();
	},4000);
}

async function consultarStatus(){
	if(!pedidoAtual)return;
	try{
		const r=await fetch('/api/pedidos/'+encodeURIComponent(pedidoAtual.id),{
			cache:'no-store',headers:{'x-order-access-token':pedidoAtual.token||''}
		});
		if(r.status===404){
			clearInterval(timerPoll);clearInterval(timerRelogio);
			try{localStorage.removeItem(CHAVE)}catch(_){}
			$('pix-corpo').hidden=true;
			$('pix-cancelar').hidden=true;
			$('pix-status').textContent='Acompanhamento indisponível';
			$('pix-status-detail').textContent='Este acesso foi revogado ou o pedido não está mais disponível. Fale com a loja pelo WhatsApp.';
			return;
		}
		if(!r.ok)return;
		const d=await r.json();
		atualizarStatus(d.status);
		if(d.status!=='pendente'&&window.Conta)window.Conta.atualizar();
		if(d.status==='pendente'){
			if(METODOS_CARTAO.has(d.metodo_pagamento)&&STATUS_PAGAMENTO_RECUSADO.has(d.status_pagamento)){
				exibirRecusaCartao();
			}else if(METODOS_CARTAO.has(d.metodo_pagamento)){
				$('cartao-tentar-novamente').hidden=true;
				$('pix').hidden=false;
				$('cartao-pagamento').hidden=true;
				$('pix-titulo').textContent='Acompanhe seu pedido';
				const aguardandoAnalise=STATUS_PAGAMENTO_EM_ANALISE.has(d.status_pagamento);
				$('pix-status').textContent=aguardandoAnalise?'Pagamento em análise':'Aguardando confirmação do pagamento';
				$('pix-status-detail').textContent='O Mercado Pago ainda não confirmou este pagamento. O pedido só será confirmado após a aprovação; não faça outra cobrança. Esta tela será atualizada automaticamente.';
				$('pix-corpo').hidden=true;
			}else if(d.pix){
				$('cartao-tentar-novamente').hidden=true;
				$('pix').hidden=false;
				$('cartao-pagamento').hidden=true;
				$('pix-titulo').textContent='Pague com Pix';
				exibirDadosPix(d);
				$('pix-status').textContent='Aguardando pagamento';
				$('pix-status-detail').textContent='Escaneie o QR Code ou use o Pix copia e cola.';
			}else{
				$('cartao-tentar-novamente').hidden=true;
				$('pix').hidden=false;
				$('cartao-pagamento').hidden=true;
				$('cartao-tentar-novamente').hidden=true;
				$('pix-status').textContent='Preparando seu Pix';
				$('pix-status-detail').textContent='Estamos finalizando a cobrança. Esta tela será atualizada automaticamente; não faça outro pedido.';
			}
			return;
		}
		$('cartao-pagamento').hidden=true;
		$('pix').hidden=false;
		$('pix-titulo').textContent='Acompanhe seu pedido';
		$('pix-corpo').hidden=true;
		$('pix-cancelar').hidden=true;
		clearInterval(timerRelogio);
		if(STATUS_FINAIS.has(d.status)){
			clearInterval(timerPoll);
			try{localStorage.removeItem(CHAVE)}catch(e){}
			$('pix-novo').hidden=false;
		}
	}catch(e){/* tenta de novo no próximo ciclo */}
}

function atualizarStatus(status){
	if(status!=='pendente')limparPersistencia();
	const info=STATUS_PEDIDO[status]||{titulo:'Status do pedido',detalhe:'A loja está atualizando seu pedido.',etapa:-1};
	$('pix-status').textContent=info.titulo;
	$('pix-status-detail').textContent=info.detalhe;
	$('pix-status-box').dataset.status=status;
	document.querySelectorAll('#pix-etapas li').forEach((li,i)=>{
		li.classList.toggle('concluida',info.etapa>i);
		li.classList.toggle('atual',info.etapa===i+1);
	});
}

async function cancelarPedido(){
	if(!pedidoAtual||!window.confirm('Cancelar este pedido e este Pix?'))return;
	const btn=$('pix-cancelar');
	btn.disabled=true;
	try{
		const r=await fetch('/api/pedidos/'+encodeURIComponent(pedidoAtual.id)+'/cancelar',{
			method:'POST',headers:{'x-order-access-token':pedidoAtual.token||''}
		});
		const d=await r.json().catch(()=>({}));
		if(!r.ok)throw new Error(d.erro||'Não foi possível cancelar o pedido.');
		atualizarStatus('cancelado');
		$('pix-corpo').hidden=true;
		$('pix-cancelar').hidden=true;
		$('pix-novo').hidden=false;
		clearInterval(timerPoll);
		clearInterval(timerRelogio);
		try{localStorage.removeItem(CHAVE)}catch(e){}
	}catch(e){
		$('pix-status').textContent=e.message;
		btn.disabled=false;
	}
}

$('pix-copiar').addEventListener('click',async()=>{
	const campo=$('pix-code'),btn=$('pix-copiar');
	try{await navigator.clipboard.writeText(campo.value)}
	catch(e){campo.select();document.execCommand('copy')}
	btn.textContent='Código copiado!';
	setTimeout(()=>{btn.textContent='Copiar código Pix'},2000);
});

$('cartao-tentar-novamente').addEventListener('click',tentarNovamenteCartao);
$('pix-cancelar').addEventListener('click',cancelarPedido);

$('pix-novo').addEventListener('click',()=>{
	PRODUTOS.forEach(p=>{q[p.id]=0});
	totalExibido=0;
	pedidoAtual=null;
	clearInterval(timerPoll);
	clearInterval(timerRelogio);
	$('pix').hidden=true;
	$('dados').hidden=false;
	$('cart-summary').hidden=false;
	$('checkout-progress').hidden=false;
	irParaEtapa(1);
	render();
	$('pedido').scrollIntoView({behavior:reduzirMovimento?'auto':'smooth'});
});

fetch('/api/config').then(r=>r.json()).then(d=>{mpPublicKey=d.mpPublicKey||''}).catch(()=>{});

async function retomarPedido(){
	const salvo=lerPedidoSalvo();
	if(!salvo)return;
	try{
		const url=salvo.id
			?'/api/pedidos/'+encodeURIComponent(salvo.id)
			:'/api/pedidos/retomar';
		const r=await fetch(url,{cache:'no-store',headers:{'x-order-access-token':salvo.token||''}});
		if(!r.ok){
			if(r.status===404)try{localStorage.removeItem(CHAVE)}catch(_){}
			return;
		}
		const d=await r.json();
		salvarPedido({id:d.id,token:salvo.token});
		if(!STATUS_FINAIS.has(d.status))mostrarPix(d,salvo.token);
		else try{localStorage.removeItem(CHAVE)}catch(_){}
	}catch(e){}
}

/* ---------- animações de revelação (mantidas) ---------- */
function prepararRevelacoes(){
	const alvos=new Set(document.querySelectorAll('section:not(.hero),#cardapio .card,.como .c,section img:not(#pix-qr)'));
	box.querySelectorAll('.item').forEach(item=>alvos.add(item));
	if(reduzirMovimento||!('IntersectionObserver' in window))return;
	const observador=new IntersectionObserver((entradas,observer)=>{
		entradas.forEach(entrada=>{
			if(!entrada.isIntersecting)return;
			entrada.target.classList.add('is-visible');
			observer.unobserve(entrada.target);
		});
	},{threshold:.12});
	alvos.forEach(elemento=>{
		elemento.classList.add('reveal');
		if(elemento.matches('#cardapio .card,.como .c')){
			const irmaos=[...elemento.parentElement.children].filter(irmao=>irmao.matches('#cardapio .card,.como .c'));
			elemento.style.setProperty('--reveal-delay',(irmaos.indexOf(elemento)*120)+'ms');
		}
		observador.observe(elemento);
	});
	document.documentElement.classList.add('motion-ready');
}

/* ---------- início ---------- */
async function iniciar(){
	$('ano').textContent=new Date().getFullYear();
	try{localStorage.removeItem('bocadinho')}catch(e){}
	try{
		await carregarProdutos();
		montarProdutos();
		restaurarCarrinho();
		restaurarRascunho();
		definirTipoEntrega();
	}catch(e){
		box.innerHTML='<p class="erro">Não foi possível carregar o cardápio agora. Recarregue a página.</p>';
		$('enviar').disabled=true;
	}
	render();
	prepararRevelacoes();
	retomarPedido();
}
iniciar();
