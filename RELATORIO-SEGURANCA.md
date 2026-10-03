# Relatório de segurança e persistência — Bocadinho

Data da revisão: 03/10/2026

## Resumo

O sistema possui uma base de segurança adequada para um MVP de pedidos com Pix, mas ainda não deve ser considerado pronto para uma operação pública sem backup, HTTPS, restrição do painel administrativo e rotação dos segredos usados nos testes.

Classificação geral atual: **médio**.

Não foi feito um pentest externo nem uma auditoria de infraestrutura. Os níveis abaixo são uma avaliação do código presente no repositório.

## Status exibido ao cliente

O site consulta o pedido periodicamente e agora mostra as etapas:

`Aguardando pagamento → Pagamento confirmado → Em preparo → Enviado → Concluído`

Também são exibidos os estados finais ou de exceção: cancelado, Pix expirado, estornado e pedido em análise. O cliente só recebe uma visão pública com ID, status, total e Pix enquanto o pedido está pendente; dados pessoais e itens ficam fora dessa resposta.

O checkout solicita endereço separado para entrega (rua, número, complemento, bairro e cidade), confirma o resumo antes de gerar o Pix e permite retirada sem preencher endereço.

## Checklist de segurança

| Controle | Estado | Nível | Observação |
|---|---|---:|---|
| Segredos fora do código | ✅ Implementado | Alto | Tokens são lidos do `.env`, que não deve ser versionado. |
| HTTPS em produção | ⚠️ Pendente | Crítico | Obrigatório para o site, painel e webhook. |
| Helmet e CSP | ✅ Implementado | Alto | Configurado no Express. Validar a política após publicar. |
| Limite do corpo JSON | ✅ Implementado | Médio | Limite atual de 20 KB. |
| Rate limit da API | ✅ Implementado | Médio | Protege criação, consulta, cancelamento e admin; o limite em memória reinicia ao reiniciar o processo. |
| Validação no servidor | ✅ Implementado | Alto | Zod, limites de campos, itens e quantidades. |
| Recalculo de preços | ✅ Implementado | Crítico | O preço não é confiado ao navegador. |
| Conferência do pagamento | ✅ Endurecido | Crítico | Exige ID exato da Order/pagamento, referência externa, valor e método Pix; testar no sandbox antes da produção. |
| Assinatura do webhook | ✅ Endurecido | Crítico | HMAC em tempo constante, janela de 5 minutos e deduplicação persistente por request-id. |
| Idempotência | ✅ Implementado | Alto | Criação e confirmação evitam duplicidade. |
| Autorização do admin | ✅ Implementado | Alto | Token em header, comparação em tempo constante e rate limit. |
| Proteção adicional do admin | ⚠️ Parcial | Alto | O código exige IP em `ADMIN_ALLOWED_IPS` em produção; ainda é necessário configurar e testar a lista e confirmar a cadeia de proxy no Render. |
| Exposição de dados públicos | ✅ Parcial | Alto | UUID não sequencial e resposta pública reduzida; o UUID deve ser tratado como segredo de acompanhamento. |
| Proteção contra pagamento tardio | ✅ Implementado | Alto | Pagamento após expiração/cancelamento vai para `revisar`. |
| Persistência do banco no Supabase | ⚠️ Pendente | Crítico | O código usa PostgreSQL; falta confirmar configuração real, acesso, backup e restauração no ambiente de produção. |
| Backup e restauração | ⚠️ Pendente | Crítico | Ainda é necessário automatizar backup e testar a restauração. |
| Permissões de segredos e banco | ⚠️ Verificar | Alto | Proteger `.env` local e restringir acesso às variáveis e ao banco gerenciado no Render/Supabase. |
| Dependências auditadas | ✅ Verificado (produção) | Médio | `npm audit --omit=dev` encontrou 0 vulnerabilidades conhecidas; repetir periodicamente. |
| Minimização de logs | ✅ Parcial | Médio | Removidos dados pessoais e respostas detalhadas do Mercado Pago dos logs da aplicação; revisar logs e retenção no provedor. |
| CSRF do painel | ✅ Parcial | Médio | O token em header reduz CSRF tradicional; manter admin fora de acesso público e usar HTTPS. |
| Autenticação de clientes | ⚠️ Não implementada | Médio | O acompanhamento atual usa o UUID do pedido; para dados mais sensíveis, adicionar token separado ou login. |

## Persistência do usuário e dos pedidos

- O código usa PostgreSQL por meio de `DATABASE_URL`; a configuração documentada usa Supabase.
- Em produção, a conexão força `sslmode=verify-full` e exige `DB_SSL_CA`; `DB_SSL=false` só desativa TLS fora de produção.
- Produtos, itens, pagamentos, status e eventos de webhook são persistidos no banco.
- O navegador guarda temporariamente apenas o ID do pedido em `sessionStorage`, para retomar o acompanhamento durante a sessão.
- O `sessionStorage` é apagado quando o pedido chega a um estado final.
- Se o navegador, sessão ou dispositivo forem trocados, o cliente perde o acesso rápido ao acompanhamento. Isso não apaga o pedido do banco.
- O banco não deve ficar em armazenamento temporário do provedor de hospedagem.


## Vulnerabilidades e riscos que ainda precisam de tratamento

### Alto

1. **Perda de dados sem backup:** falha do disco ou do provedor pode apagar pedidos. Configurar cópia automática, retenção e teste de restauração.
2. **Admin exposto na internet:** além do token, configure `ADMIN_ALLOWED_IPS` no Render e valide a restrição de IP na implantação. A allowlist do Express depende do IP informado pelo proxy.
3. **Segredos de teste expostos:** tokens que tenham sido compartilhados em terminal, editor, captura ou conversa devem ser revogados e substituídos antes do deploy.
4. **UUID como credencial de pedido:** quem obtiver o UUID pode consultar o status e os dados Pix enquanto pendentes e tentar cancelar o pedido. A resposta não inclui dados pessoais, mas um token de acompanhamento separado e aleatório seria mais robusto.

### Médio

1. **Rate limit em memória:** em múltiplas instâncias ou após reinício, o limite não é compartilhado. Usar Redis ou rate limit no proxy quando houver escala.
2. **Notificações externas:** não há canal externo configurado; a notificação atual apenas escreve nos logs da aplicação.
3. **Dependências e runtime:** manter dependências atualizadas e fixar o deploy numa versão Node.js LTS ainda suportada; o projeto declara `>=18`.

### Baixo

1. **Privacidade operacional:** definir prazo de retenção para nome, telefone, e-mail e endereço.
2. **Observabilidade:** configurar alertas para falhas de webhook, pedidos em `revisar`, erros do Mercado Pago e falta de espaço em disco.

## Auditoria técnica estática — 03/10/2026

Escopo: revisão estática do código e da configuração versionada, sem pentest externo, acesso ao ambiente Render/Supabase, banco de produção ou arquivo `.env`. As correções listadas abaixo foram aplicadas no código, mas ainda aguardam testes integrados.

### Correções aplicadas e validação pendente

1. **TLS, logs, pagamento e webhook endurecidos — validação integrada pendente.** O código agora exige a CA configurada por `DB_SSL_CA` e valida o hostname do banco em produção, minimiza logs, exige vínculo exato entre pedido/Order/pagamento e aplica janela de 5 minutos mais deduplicação por request-id. Configurar o Secret File no Render, confirmar a conexão com a URL real do Supabase e testar os fluxos no sandbox do Mercado Pago antes da produção. Webhooks duplicados são reconhecidos pelo `request-id`; eventos persistidos antes de falha de processamento dependem da reconciliação de pedidos pendentes.

### Dependências, testes e limites da revisão

- `npm audit --omit=dev`: **0 vulnerabilidades conhecidas** reportadas para as dependências de produção no momento da revisão.
- `node --check` passou nos arquivos JavaScript do servidor, rotas e frontend.
- As alterações desta auditoria passaram pela verificação sintática, mas não por testes integrados de banco ou Mercado Pago.
- `package.json` não define suíte de testes. Não foram executados testes integrados de pagamento, webhook ou banco, nem testes dinâmicos de segurança.
- `server.js` confia em um salto de proxy (`trust proxy = 1`). A regra de IP do admin depende de a topologia e os cabeçalhos do Render corresponderem a essa configuração. Validar em produção, tentar acesso de IP permitido e não permitido e confirmar que `/api/webhook` continua acessível.
- A restrição por `ADMIN_ALLOWED_IPS` está no código, mas não é possível confirmar neste repositório se a variável foi configurada no Render.
- O projeto declara `node >=18`; o operador deve fixar uma versão LTS de Node.js ainda suportada na implantação.

## Checklist antes do deploy

- [ ] Rotacionar `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET` e `ADMIN_TOKEN`.
- [ ] Configurar domínio e HTTPS válido.
- [ ] Configurar `BASE_URL` com HTTPS.
- [ ] Configurar o serviço Render para usar Node.js LTS mantido (22 ou superior), conforme indicado no README.
- [ ] Configurar webhook do Mercado Pago e testar assinatura.
- [ ] Configurar `DATABASE_URL` do Supabase no Render.
- [ ] Baixar a CA raiz do Supabase, carregá-la no Render como Secret File e configurar `DB_SSL_CA`.
- [ ] Confirmar conexão PostgreSQL com `sslmode=verify-full` usando a URL real do Supabase.
- [ ] Validar criação das tabelas, pedido, webhook e painel administrativo no PostgreSQL.
- [ ] Testar no sandbox pagamento aprovado, recusado/pendente, valor/método/referência divergentes, assinatura inválida/expirada e webhook duplicado.
- [ ] Migrar dados existentes do antigo `bocadinho.db`, se houver pedidos que precisem ser preservados.
- [ ] Automatizar backup criptografado e testar restauração.
- [ ] Restringir `/admin` e `/api/admin` no proxy, IP ou VPN.
- [ ] Testar acesso administrativo a partir de IP permitido e não permitido, e confirmar que o webhook público continua funcionando.
- [ ] Restringir acesso aos segredos e ao banco; proteger o `.env` local com permissões adequadas.
- [x] Executar `npm audit --omit=dev` (0 vulnerabilidades conhecidas no momento da auditoria).
- [ ] Fazer teste real de baixo valor: criar, pagar, receber webhook, acompanhar status, avançar no admin e conferir cancelamento pendente.
- [ ] Configurar notificações da loja.
- [ ] Completar e revisar a política em `public/privacidade.html`: identificação legal do controlador, base legal para dados de alergias e prazos de retenção.
