/* Bocadinho — melhorias de interface (carregar DEPOIS de app.js). Não altera a lógica do pedido. */
(()=>{
	const $=id=>document.getElementById(id);
	const reduzir=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	const nav=document.querySelector('.site-nav');
	const hero=document.querySelector('.hero');

	/* menu fica marrom depois da hero */
	if(nav&&hero){
		const aoRolar=()=>nav.classList.toggle('is-stuck',window.scrollY>hero.offsetHeight*.6);
		window.addEventListener('scroll',aoRolar,{passive:true});
		aoRolar();
	}

	/* link "Monte seu pedido" mostra quantos itens já foram escolhidos */
	const link=nav&&nav.querySelector('a[href="#pedido"]');
	const contador=$('cart-summary-count');
	if(link&&contador){
		const atualizar=()=>{
			const n=parseInt(contador.textContent,10)||0;
			link.textContent=n?'Meu pedido ('+n+')':'Monte seu pedido';
		};
		new MutationObserver(atualizar).observe(contador,{childList:true,characterData:true,subtree:true});
		atualizar();
	}

	/* ao trocar de etapa, volta ao topo do checkout (importante no celular) */
	const progresso=$('checkout-progress');
	if(progresso){
		let etapaAtual=progresso.querySelector('[aria-current]')?.dataset.checkoutProgress;
		new MutationObserver(()=>{
			const nova=progresso.querySelector('[aria-current]')?.dataset.checkoutProgress;
			if(!nova||nova===etapaAtual)return;
			etapaAtual=nova;
			const topo=progresso.getBoundingClientRect().top+window.scrollY;
			const margem=(nav?.getBoundingClientRect().height||72)+12;
			window.scrollTo({top:Math.max(0,topo-margem),behavior:reduzir?'auto':'smooth'});
		}).observe(progresso,{attributes:true,subtree:true,attributeFilter:['aria-current']});
	}
})();
