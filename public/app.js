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
let totalExibido=0,frameTotal=0,pedidoAtual=null,timerPoll=0,timerRelogio=0;

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
		d.className='item';
		d.innerHTML='<div><b>'+esc(p.nome)+'</b><small>'+esc(p.descricao)+'</small><div class="pr">'+brl(p.preco_centavos)+'</div></div><div class="qty"><button type="button" data-id="'+esc(p.id)+'" data-d="-1" aria-label="Diminuir '+esc(p.nome)+'">−</button><span id="q_'+esc(p.id)+'">0</span><button type="button" data-id="'+esc(p.id)+'" data-d="1" aria-label="Aumentar '+esc(p.nome)+'">+</button></div>';
		box.appendChild(d);
	});
}

box.addEventListener('click',e=>{
	const b=e.target.closest('button');
	if(!b)return;
	const id=b.dataset.id;
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
		quantidade.textContent=q[p.id];
		if(q[p.id]!==quantidadesAnteriores[p.id]&&!reduzirMovimento)reiniciarAnimacao(quantidade,'is-bumping');
		quantidadesAnteriores[p.id]=q[p.id];
	});
	const s=sel(),destino=total();
	$('resumo').innerHTML=s.length?s.map(p=>'<div class="r"><span>'+q[p.id]+'x '+esc(p.nome)+'</span><span>'+brl(q[p.id]*p.preco_centavos)+'</span></div>').join('')+'<div class="tot"><span>Total dos produtos</span><span id="total-valor">'+brl(Math.round(totalExibido))+'</span></div><small>'+(entrega()?'Uber Envios será pago pelo cliente, da loja até sua casa; valor combinado pelo WhatsApp.':'Retirada sem taxa de entrega.')+'</small>':'Nenhum item selecionado ainda.';
	$('endwrap').style.display=entrega()?'block':'none';
	if(s.length)animarTotal(destino);
	else{cancelAnimationFrame(frameTotal);totalExibido=0;}
}

/* ---------- validação (só UX; o servidor valida tudo de novo) ---------- */
const telefoneLimpo=()=>v('telefone').replace(/\D/g,'').replace(/^55(?=\d{10,11}$)/,'');
const telefoneOk=()=>/^[1-9]{2}(9\d{8}|[2-5]\d{7})$/.test(telefoneLimpo());
const emailOk=()=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v('email'));

function validar(){
	if(!sel().length)return{msg:'Escolha pelo menos um produto.',campo:box};
	if(v('nome').length<2)return{msg:'Informe seu nome.',campo:$('nome')};
	if(!telefoneOk())return{msg:'Informe um telefone válido com DDD.',campo:$('telefone')};
	if(!emailOk())return{msg:'Informe um e-mail válido.',campo:$('email')};
	if(entrega()&&v('rua').length<3)return{msg:'Informe a rua.',campo:$('rua')};
	if(entrega()&&!v('numero').length)return{msg:'Informe o número.',campo:$('numero')};
	if(entrega()&&v('regiao').length<2)return{msg:'Informe o bairro.',campo:$('regiao')};
	if(entrega()&&v('cidade').length<2)return{msg:'Informe a cidade.',campo:$('cidade')};
	return null;
}

function confirmarDadosAntesDoPix(){
	const linhas=sel().map(p=>`${q[p.id]}x ${p.nome} — ${brl(q[p.id]*p.preco_centavos)}`).join('\n');
	const endereco=entrega()
		?`\nEntrega:\n${v('rua')}, ${v('numero')}${v('complemento')?', '+v('complemento'):''}\n${v('regiao')} — ${v('cidade')}`
		:'\nRetirada no local: as instruções serão enviadas após a confirmação.';
	const observacao=v('obs')?`\nObservação: ${v('obs')}`:'';
	return window.confirm(`Confira seu pedido antes de gerar o Pix:\n\n${linhas}\n\nTotal dos produtos: ${brl(total())}${endereco}${observacao}\n\nNa entrega, você pagará o Uber Envios separadamente, da loja até sua casa.\n\nClique em OK para gerar o Pix.`);
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

/* ---------- envio do pedido ---------- */
async function enviarPedido(){
	const btn=$('enviar');
	btn.disabled=true;
	btn.textContent='Gerando Pix...';
	try{
		const r=await fetch('/api/pedidos',{
			method:'POST',
			headers:{'Content-Type':'application/json'},
			body:JSON.stringify({
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
			if(chave==='itens')marcar(box);
			else if(chave&&$(chave))marcar($(chave));
			return;
		}
		try{sessionStorage.setItem(CHAVE,d.id)}catch(e){}
		mostrarPix(d);
	}catch(e){
		$('erro').textContent='Sem conexão. Verifique sua internet e tente de novo.';
	}finally{
		btn.disabled=false;
		btn.textContent='Pagar com Pix';
	}
}

$('enviar').addEventListener('click',()=>{
	limparValidacao();
	const falha=validar();
	$('erro').textContent=falha?falha.msg:'';
	if(falha){marcar(falha.campo);return;}
	if(!confirmarDadosAntesDoPix())return;
	enviarPedido();
});

document.querySelector('.form').addEventListener('input',e=>{
	if(e.target.id==='pix-code')return;
	$('erro').textContent='';
	limparValidacao();
	render();
});

document.querySelectorAll('input[name=tipo]').forEach(opcao=>opcao.addEventListener('change',()=>{
	$('erro').textContent='';
	$('retirada-ajuda').hidden=entrega();
	render();
}));

/* ---------- painel do Pix ---------- */
function mostrarPix(d){
	pedidoAtual={id:d.id,fim:Date.now()+d.restante_ms};
	$('dados').hidden=true;
	$('pix').hidden=false;
	$('pix-corpo').hidden=false;
	$('pix-novo').hidden=true;
	const qr=$('pix-qr');
	if(d.pix?.qrBase64){
		qr.src='data:image/png;base64,'+d.pix.qrBase64;
		qr.hidden=false;
	}else{
		// O sandbox pode não devolver a imagem; o copia-e-cola continua disponível.
		qr.removeAttribute('src');
		qr.hidden=true;
	}
	$('pix-code').value=d.pix?.copiaECola||'';
	$('pix-total').textContent=brl(d.total_centavos);
	atualizarStatus(d.status);
	$('pix-cancelar').hidden=d.status!=='pendente';
	$('pix-cancelar').disabled=false;
	if(d.status==='pendente')iniciarRelogio();
	else $('pix-corpo').hidden=true;
	iniciarPolling();
	$('pix').scrollIntoView({behavior:reduzirMovimento?'auto':'smooth',block:'center'});
}

function iniciarRelogio(){
	clearInterval(timerRelogio);
	const atualizar=()=>{
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
	$('pix-status-detail').textContent='Verificando o pagamento com o Mercado Pago...';
	try{
		const r=await fetch('/api/pedidos/'+encodeURIComponent(pedidoAtual.id),{cache:'no-store'});
		if(!r.ok)return;
		const d=await r.json();
		atualizarStatus(d.status);
		if(d.status==='pendente')return;
		$('pix-corpo').hidden=true;
		$('pix-cancelar').hidden=true;
		clearInterval(timerRelogio);
		if(STATUS_FINAIS.has(d.status)){
			clearInterval(timerPoll);
			try{sessionStorage.removeItem(CHAVE)}catch(e){}
			$('pix-novo').hidden=false;
		}
	}catch(e){/* tenta de novo no próximo ciclo */}
}

function atualizarStatus(status){
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
		const r=await fetch('/api/pedidos/'+encodeURIComponent(pedidoAtual.id)+'/cancelar',{method:'POST'});
		const d=await r.json().catch(()=>({}));
		if(!r.ok)throw new Error(d.erro||'Não foi possível cancelar o pedido.');
		atualizarStatus('cancelado');
		$('pix-corpo').hidden=true;
		$('pix-cancelar').hidden=true;
		$('pix-novo').hidden=false;
		clearInterval(timerPoll);
		try{sessionStorage.removeItem(CHAVE)}catch(e){}
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

$('pix-cancelar').addEventListener('click',cancelarPedido);

$('pix-novo').addEventListener('click',()=>{
	PRODUTOS.forEach(p=>{q[p.id]=0});
	totalExibido=0;
	pedidoAtual=null;
	$('pix').hidden=true;
	$('dados').hidden=false;
	render();
	$('pedido').scrollIntoView({behavior:reduzirMovimento?'auto':'smooth'});
});

async function retomarPedido(){
	let id=null;
	try{id=sessionStorage.getItem(CHAVE)}catch(e){}
	if(!id)return;
	try{
		const r=await fetch('/api/pedidos/'+encodeURIComponent(id));
		if(!r.ok){sessionStorage.removeItem(CHAVE);return;}
		const d=await r.json();
		if(d.status==='pendente'&&d.pix)mostrarPix(d);
		else if(!STATUS_FINAIS.has(d.status))mostrarPix(d);
		else sessionStorage.removeItem(CHAVE);
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
	}catch(e){
		box.innerHTML='<p class="erro">Não foi possível carregar o cardápio agora. Recarregue a página.</p>';
		$('enviar').disabled=true;
	}
	render();
	prepararRevelacoes();
	retomarPedido();
}
iniciar();
