# Bocadinho: pedidos com Pix (confirmação automática)

Backend Node/Express + PostgreSQL integrado ao **Mercado Pago (Pix)**, com o site da Bocadinho adaptado.
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
└─ public/                   # site (index.html, style.css, app.js) + assets/
```

**Coloque suas fotos em `public/assets/`** (photo-1.jpg ... photo-7.jpg), como no site original.

## Fluxo

1. O site busca o cardápio em `/api/produtos` e envia só **ids e quantidades**.
2. O servidor valida os dados (Zod), **recalcula o total com os preços do banco**, grava o pedido como `pendente` e cria o Pix no Mercado Pago.
3. O site mostra o QR, o copia-e-cola e um contador de expiração, e consulta o status a cada 4 s.
4. O Mercado Pago chama o webhook. O servidor valida a **assinatura**, consulta o pagamento direto na API, confere **valor, método e pedido**, e marca como `pago` (uma única vez).
5. O job de reconciliação (a cada minuto) confere pendentes no Mercado Pago caso um webhook se perca e expira os vencidos.

Status: `pendente → pago → em_preparo → enviado → concluido` (mais `expirado`, `cancelado`, `estornado`, `revisar`).

## Como rodar (teste)

1. Node 18+ instalado. Na pasta: `npm install`
2. `cp .env.example .env` e preencha:
   - `MP_ACCESS_TOKEN`: em Mercado Pago > Suas integrações > sua aplicação (comece pelas credenciais de **teste**).
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
- [ ] Usar armazenamento persistente para o banco (`DB_FILE=/var/data/bocadinho.db`) ou migrar para um banco gerenciado.
- Troque para as credenciais **de produção** e use HTTPS de verdade (Render, Railway, VPS + domínio).
- Faça um Pix real de R$ 1 e confirme o ciclo completo (criar, pagar, webhook, status).
- Faça backup do `bocadinho.db` e mantenha `NODE_ENV=production`.
- Implemente o canal em `src/notificar.js` (e-mail, Telegram etc.) para ser avisado dos pagamentos.
- Complete e revise a [política de privacidade](public/privacidade.html), incluindo identificação legal do controlador, tratamento de dados de alergias e prazos de retenção; defina também como emitir nota com seu contador.
- Confirme na documentação do Mercado Pago as taxas, o prazo mínimo de expiração do Pix e os requisitos da conta.

Consulte o [relatório de segurança e persistência](RELATORIO-SEGURANCA.md) antes do deploy.

### Banco PostgreSQL no Supabase

O projeto usa PostgreSQL pelo driver `pg`. No Supabase, abra **Project Settings → Database → Connection string → URI**, copie a string e configure no `.env` ou nas variáveis do Render:

```env
DATABASE_URL=postgresql://postgres.PROJECT_REF:SENHA@aws-0-REGIAO.pooler.supabase.com:5432/postgres?sslmode=require
```

Use a opção **Session pooler** no Supabase, não a conexão direta `db.PROJECT_REF.supabase.co`, pois o Render pode não ter conectividade IPv6. Em produção, a aplicação força `sslmode=verify-full` e exige `DB_SSL_CA`, o certificado raiz baixado em **Supabase → Database Settings → SSL Configuration**. No Render, carregue-o em **Environment → Secret Files** como `supabase-prod-ca-2021.crt` e configure `DB_SSL_CA=/etc/secrets/supabase-prod-ca-2021.crt`. O hostname deve ser o host exato da URI do Supabase. Na primeira inicialização, o sistema cria as tabelas e insere os produtos padrão que ainda não existem; não sobrescreve preços ou nomes editados pelo dono. O deploy só inicia se a conexão TLS validada funcionar. A senha da conexão nunca deve ser publicada no GitHub. Configure no Render uma versão LTS do Node.js ainda suportada (22 ou superior).

### Fotos e gerenciamento do catálogo

O painel `/admin` permite adicionar produtos com foto, editar nome/descrição/preço e ativar ou desativar produtos. As imagens ficam no Supabase Storage para persistirem em deploys do Render. Crie no Supabase Storage um bucket público chamado `produtos` e configure no Render `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (somente no servidor) e `SUPABASE_STORAGE_BUCKET=produtos`. A chave de serviço nunca deve ser usada no navegador nem enviada ao Git. São aceitas imagens JPEG, PNG ou WebP de até 5 MB.

O serviço cria automaticamente as colunas de imagem na tabela `produtos`; produtos desativados são ocultados do cardápio público, sem apagar o histórico dos pedidos. Os produtos padrão são inseridos apenas quando ainda não existem, para preservar alterações feitas pelo dono no painel.

## Limitações conhecidas

- **Taxa de entrega:** este projeto cobra só os produtos. O cliente paga o Uber Envios diretamente, da loja até a casa dele; o valor e o prazo são combinados pelo WhatsApp. Para cobrar tudo no Pix, defina taxa fixa por região em `src/pedidos.js`.
- Cartão não está incluído (só Pix).
- Não foi possível instalar as dependências nem rodar contra o Mercado Pago neste ambiente, então teste tudo no sandbox antes de divulgar.
# Bocadinho
