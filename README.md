# Bocadinho: pedidos com Pix (confirmação automática)

Backend Node/Express + PostgreSQL integrado ao **Mercado Pago (Pix e cartão)**, com o site da Bocadinho adaptado.
O pagamento usa a **Orders API**, que permite validar o fluxo de Pix no ambiente de testes.

## Estrutura

```
bocadinho-pagamentos/
├─ server.js                 # app Express (helmet, rotas, estáticos, erros)
├─ .env.example              # variáveis de ambiente (copie para .env)
├─ src/
│  ├─ config.js              # lê e exige as variáveis do .env
│  ├─ produtos.js            # ÚNICA fonte de preços (em centavos)
│  ├─ db.js                  # tabelas PostgreSQL + sincroniza catálogo
│  ├─ validacao.js           # schema Zod dos dados do pedido
│  ├─ pedidos.js             # cria pedido, recalcula total, transições de status
│  ├─ mercadopago.js         # criar Pix, consultar, cancelar, validar assinatura
│  ├─ pagamentos.js          # regras de confirmação (idempotente)
│  ├─ notificar.js           # aviso à loja quando um pedido é pago
│  ├─ jobs.js                # reconciliação + expiração a cada minuto
│  └─ rotas/
│     ├─ pedidos.js          # GET /api/produtos, POST /api/pedidos, GET /api/pedidos/:id
│     ├─ webhook.js          # POST /api/webhook/mercadopago
│     └─ admin.js            # GET/PATCH /api/admin/... (token)
├─ supabase/
│  └─ rls.sql                # RLS e índices recomendados para o Supabase
├─ assets/                   # ícones, manifests e imagens de marca
└─ public/                   # site (index.html, style.css, app.js) + assets/
```

**Coloque suas fotos em `public/assets/`** (photo-1.jpg ... photo-7.jpg), como no site original.

## Conta do cliente e cartão fidelidade

- `POST /api/conta/cadastro`, `POST /api/conta/login`, `POST /api/conta/logout`, `GET /api/conta` (dados, cartão e últimos pedidos).
- Senha com scrypt (salt aleatório); sessão em cookie `HttpOnly` + `SameSite=Lax` (+ `Secure` em produção), guardada como hash em `sessoes_cliente` (30 dias).
- Pedidos feitos **logado** ficam ligados ao cliente (`pedidos.cliente_id`). Pedido sem login continua funcionando, mas não soma carimbo.
- Regra (`src/fidelidade.js`): cada pedido **pago** (`pago`, `em_preparo`, `enviado`, `concluido`) vale 1 carimbo; a cada `FIDELIDADE_META` (padrão 10) o cliente ganha 1 cookie grátis, adicionado automaticamente ao **próximo** pedido como item de preço R$ 0,00 (`FIDELIDADE_PRODUTO_ID`, padrão `c1`). O total cobrado no Pix não muda.
- O saldo é calculado a partir dos pedidos (sem contador separado): estorno tira o carimbo; pedido com brinde que expira ou é cancelado devolve o brinde. O saldo é conferido dentro da transação com trava na linha do cliente, evitando uso duplo.
- Rode `supabase/rls.sql` de novo para habilitar RLS nas tabelas `clientes` e `sessoes_cliente`.

## Páginas do site e painel de clientes

- `/` (início), `/cardapio.html` (cardápio, checkout e Pix) e `/conta.html` (login, cadastro, cartão fidelidade). O servidor também aceita `/cardapio` e `/conta`.
- `comum.js` (menu, sidebar "Minha conta", contador do carrinho, aviso de pedido em andamento) carrega em todas as páginas; `app.js` só no cardápio; `conta.js` só na conta.
- Persistência no navegador: `bocadinho_carrinho` (ids e quantidades), `bocadinho_rascunho` (dados do checkout, 7 dias) e `bocadinho_pedido` (id e token de acompanhamento). O token de acompanhamento fica no `localStorage` deste aparelho até o pedido terminar; o servidor armazena somente o hash por até 90 dias. Senhas não são armazenadas no navegador.
- Admin: aba "Clientes cadastrados" (`/admin`) com `GET /api/admin/clientes/resumo`, `GET /api/admin/clientes?busca=&pagina=&limite=` e `GET /api/admin/clientes/:id/pedidos`. Mostra total, novos (7/30 dias), pedidos, carimbos e dados de contato; nunca retorna senha.

## Fluxo

1. O site busca o cardápio em `/api/produtos` e envia só **ids e quantidades**.
2. O servidor valida os dados (Zod), **recalcula o total com os preços do banco**, grava o pedido como `pendente` e cria o Pix no Mercado Pago.
3. O site mostra o QR, o copia-e-cola e um contador de expiração, e consulta o status a cada 4 s.
4. O Mercado Pago chama o webhook. O servidor valida a **assinatura**, consulta o pagamento direto na API, confere **valor, método e pedido**, e marca como `pago` (uma única vez).
5. O job de reconciliação (a cada minuto) confere pendentes no Mercado Pago caso um webhook se perca e expira os vencidos.

Status: `pendente → pago → em_preparo → enviado → concluido` (mais `expirado`, `cancelado`, `estornado`, `revisar`).

No cartão, a aprovação confirma o pedido; estados pendentes/em processamento mostram ao cliente que o Mercado Pago ainda está analisando e não liberam o preparo. Uma recusa permite tentar outro cartão, enquanto o pedido continua em "Atenção" no admin até ser confirmado, cancelado ou expirar. No Pix, a tela informa separadamente quando o código ainda está sendo gerado.

## Como rodar (teste)

1. Node 18+ instalado localmente. Em produção, prefira Node 22 LTS ou superior. Na pasta: `npm install`
2. `cp .env.example .env` e preencha:
   - `MP_ACCESS_TOKEN`: em Mercado Pago > Suas integrações > sua aplicação (comece pelas credenciais de **teste**).
   - `MP_PUBLIC_KEY`: chave pública da mesma aplicação/ambiente, usada pelo formulário de cartão no navegador.
   - `MP_STATEMENT_DESCRIPTOR`: nome opcional exibido no extrato do cartão; o padrão é `BOCADINHO`.
   - `ADMIN_TOKEN`: gere algo longo e aleatório.
3. Configure o PostgreSQL do Supabase em `DATABASE_URL` e exponha o servidor com HTTPS para o webhook, por exemplo `ngrok http 3000`, colocando a URL em `BASE_URL`.
4. No painel do Mercado Pago > Webhooks: informe `BASE_URL/api/webhook/mercadopago`, marque o evento **Order (Mercado Pago)**, copie a **chave secreta** para `MP_WEBHOOK_SECRET`.
5. `npm start` e abra `http://localhost:3000`.
6. Faça um pedido de teste. Em `NODE_ENV=development`, o backend usa o cenário oficial `APRO` do sandbox e o pagamento é aprovado automaticamente; confira no terminal o aviso "PEDIDO PAGO".

### Teste simulado local

Se o Mercado Pago não liberar o sandbox da sua conta, ative `PAGAMENTO_SIMULADO=true` no `.env` e reinicie o servidor. Faça um pedido pelo site e, com o ID retornado/salvo no pedido, confirme-o usando:

```
curl -X POST -H "x-admin-token: SEU_TOKEN" \
  http://localhost:3000/api/admin/pedidos/ID_DO_PEDIDO/simular-pagamento
```

Esse modo não chama o Mercado Pago e só funciona fora de produção.

## Admin (simples)

Também existe um painel visual em `http://localhost:3000/admin`. Ele guarda o token apenas na sessão do navegador, lista pedidos, mostra resumo, filtra por status, permite buscar cliente, abrir o WhatsApp e avançar o andamento do pedido.

O painel possui favicon, Apple Touch Icon e manifest próprios, separados da identidade visual do site público.

O painel não é linkado no site público. Em produção, `/admin` e `/api/admin` aceitam apenas os endereços IP definidos na variável `ADMIN_ALLOWED_IPS` (lista de IPs públicos separados por vírgula). Configure essa variável nas Environment Variables do serviço no Render. Se ela estiver vazia, o acesso administrativo será bloqueado em produção. Para usar VPN, informe o IP público de saída da VPN. A proteção por IP é adicional ao `ADMIN_TOKEN`; não bloqueia `/api/webhook`.

```
curl -H "x-admin-token: SEU_TOKEN" "http://localhost:3000/api/admin/pedidos?status=pago"
curl -X PATCH -H "x-admin-token: SEU_TOKEN" -H "Content-Type: application/json" \
     -d '{"status":"em_preparo"}' http://localhost:3000/api/admin/pedidos/<ID>/status
```

Endpoints adicionais protegidos pelo mesmo token:

```text
GET /api/admin/pedidos/:id
GET /api/admin/resumo
```

## Validações implementadas

- **Entrada (Zod):** nome, e-mail, telefone BR com DDD, tipo (entrega/retirada), região, endereço obrigatório na entrega, observação até 300, 1 a 20 itens, quantidade 1 a 99, sem itens repetidos, sem campos extras.
- **Preço:** nunca vem do site; total recalculado no servidor, teto de R$ 5.000 por pedido, valores em centavos.
- **Anti-abuso:** rate limit por IP, máximo de 3 pedidos pendentes por telefone/e-mail.
- **Pagamento:** assinatura HMAC do webhook, consulta direta da Order no Mercado Pago, valor e método conferidos, pedido, `mp_order_id` e `mp_payment_id` precisam bater, confirmação idempotente, chave de idempotência na criação da cobrança, expiração, pagamento tardio vai para `revisar`, estorno tratado.
- **Segurança:** helmet (CSP), corpo JSON limitado a 20 KB, segredos no `.env`, UUID nos pedidos, escape de HTML no front, erros internos não vazam.

## Antes de ir para produção

- [x] Testar o cancelamento de um pedido Pix pendente pelo botão exibido junto ao QR Code.
- [x] Exibir no site o andamento do pedido: pagamento confirmado, preparo, envio, conclusão e estados de exceção.
- [x] Usar PostgreSQL/Supabase como armazenamento persistente do banco.
- [ ] Configurar backup automático do projeto Supabase e testar a restauração.
- [ ] Trocar para as credenciais **de produção** e usar HTTPS de verdade (Render, Railway, VPS + domínio).
- [ ] Fazer um Pix real de baixo valor e confirmar o ciclo completo (criar, pagar, webhook, status).
- [x] Implementar o canal opcional de notificação em `src/notificar.js`.
- [ ] Configurar `TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID` no ambiente de produção.
- [ ] Aplicar `supabase/rls.sql` no SQL Editor do Supabase.
- [x] Atualizar a [política de privacidade](public/privacidade.html) com a identificação legal informada, canal de privacidade, retenção operacional de logs e orientação para não enviar alergias pelo checkout.
- [ ] Definir com o contador os documentos fiscais e os prazos legais de retenção de pedidos e pagamentos.
- Confirme na documentação do Mercado Pago as taxas, o prazo mínimo de expiração do Pix e os requisitos da conta.

Consulte o [relatório de segurança e persistência](RELATORIO-SEGURANCA.md) antes do deploy.

Consulte também o [manual de produção](MANUAL-PRODUCAO.md), que registra o responsável pelo tratamento, o acesso administrativo por IP e token, os objetivos de recuperação, a retenção operacional e o procedimento inicial de resposta a incidentes.

### Notificação gratuita no Telegram

Crie um bot pelo `@BotFather`, envie `/start` para ele e configure `TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID` no servidor. A integração é opcional: sem essas variáveis, o fluxo permanece igual. Falhas no Telegram são apenas registradas e não interferem na confirmação do pagamento.

A mensagem é enviada quando o pedido muda para `pago`, não apenas quando o formulário é enviado. O token deve ficar somente no `.env` local ou nas variáveis secretas do provedor; nunca publique o `.env` ou o token no Git.

### Banco PostgreSQL no Supabase

O projeto usa PostgreSQL pelo driver `pg`. No Supabase, abra **Project Settings → Database → Connection string → URI**, copie a string e configure no `.env` ou nas variáveis do Render:

```env
DATABASE_URL=postgresql://postgres.PROJECT_REF:SENHA@aws-0-REGIAO.pooler.supabase.com:5432/postgres?sslmode=require
```

Use a opção **Session pooler** no Supabase, não a conexão direta `db.PROJECT_REF.supabase.co`, pois o Render pode não ter conectividade IPv6. Em produção, a aplicação força `sslmode=verify-full` e exige `DB_SSL_CA`, o certificado raiz baixado em **Supabase → Database Settings → SSL Configuration**. No Render, carregue-o em **Environment → Secret Files** como `supabase-prod-ca-2021.crt` e configure `DB_SSL_CA=/etc/secrets/supabase-prod-ca-2021.crt`. O hostname deve ser o host exato da URI do Supabase. Na primeira inicialização, o sistema cria as tabelas e insere os produtos padrão que ainda não existem; não sobrescreve preços ou nomes editados pelo dono. O deploy só inicia se a conexão TLS validada funcionar. A senha da conexão nunca deve ser publicada no GitHub. Configure no Render uma versão LTS do Node.js ainda suportada (22 ou superior).

### Fotos e gerenciamento do catálogo

O painel `/admin` permite adicionar produtos com foto, editar nome/descrição/preço e ativar ou desativar produtos. As imagens ficam no Supabase Storage para persistirem em deploys do Render. Crie no Supabase Storage um bucket público chamado `produtos` e configure no Render `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (somente no servidor) e `SUPABASE_STORAGE_BUCKET=produtos`. A chave de serviço nunca deve ser usada no navegador nem enviada ao Git. São aceitas imagens JPEG, PNG ou WebP de até 5 MB.

O serviço cria automaticamente as colunas de imagem na tabela `produtos`; produtos desativados são ocultados do cardápio público, sem apagar o histórico dos pedidos. Os produtos padrão são inseridos apenas quando ainda não existem, para preservar alterações feitas pelo dono no painel.

### RLS e índices do Supabase

O arquivo `supabase/rls.sql` habilita Row Level Security nas tabelas públicas e cria índices para as chaves estrangeiras de pedidos. Como o navegador não acessa a Data API do Supabase e o backend usa `DATABASE_URL`, o arquivo não cria políticas públicas para `anon` ou `authenticated`. Execute o conteúdo no SQL Editor do projeto Supabase após criar/configurar as tabelas.

### Recuperação do Pix e acesso do cliente

O pedido, a chave idempotente e a tentativa inicial de cobrança são gravados juntos antes da chamada ao Mercado Pago. Se a resposta externa ou a gravação do pagamento falhar, o job retenta com atraso crescente usando a mesma chave, para recuperar a mesma Order sem criar uma cobrança duplicada. A API pode responder HTTP 202 enquanto o Pix está sendo preparado; o checkout acompanha o pedido e mostra o código assim que ficar disponível. Pedidos pendentes anteriores à migração recebem tentativa de recuperação com o UUID já usado como chave idempotente.

O navegador gera um token aleatório antes de enviar o pedido e guarda-o localmente para suportar reenvio idempotente se a resposta se perder. A tabela `acesso_pedido` guarda apenas o hash, com validade de 90 dias. Consulta e cancelamento exigem esse token no header `x-order-access-token`; a loja pode revogá-lo pelo endpoint administrativo `POST /api/admin/pedidos/:id/revogar-acesso`. Para pedidos legados sem token, o UUID continua aceito por até 90 dias da criação.

Execute `npm test` para rodar os testes unitários do formato/hash do token e da política de retry. Testes integrados com PostgreSQL, Mercado Pago sandbox, webhook e Telegram ainda são necessários antes de produção.

## Limitações conhecidas

- **Taxa de entrega:** este projeto cobra só os produtos. O cliente paga o Uber Envios diretamente, da loja até a casa dele; o valor e o prazo são combinados pelo WhatsApp. Para cobrar tudo no Pix, defina taxa fixa por região em `src/pedidos.js`.
- Cartão de crédito e débito usam o Checkout Transparente/Card Payment Brick; teste recusas, aprovações, pendências, parcelas e estornos antes da operação.
- Não há testes integrados automatizados contra PostgreSQL, Mercado Pago ou Telegram; execute um teste completo no sandbox antes de divulgar e um Pix real de baixo valor antes da operação.
# Bocadinho
# BocadinhoV2TestProd
