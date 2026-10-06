# Relatório de segurança e persistência — Bocadinho

Data da revisão: 06/10/2026

## Resumo

O sistema possui controles importantes para um MVP de pedidos com Pix, mas esta revisão encontrou riscos financeiros e operacionais que devem ser tratados antes de considerar o fluxo resiliente para operação pública. A prioridade é garantir recuperação de cobranças quando houver falha ao gravar o pagamento local, confirmar a configuração do proxy no Render, rotacionar credenciais expostas e definir backup/retensão.

Classificação geral do código: **médio-alto até a correção do fluxo de criação/reconciliação da cobrança**. A configuração real de produção não foi verificada.

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
| Exposição de dados públicos | ✅ Parcial | Alto | Resposta pública reduzida; pedidos novos exigem token aleatório separado, com hash no banco. Pedidos legados mantêm UUID por até 90 dias. |
| Proteção contra pagamento tardio | ✅ Implementado | Alto | Pagamento após expiração/cancelamento vai para `revisar`. |
| Persistência do banco no Supabase | ⚠️ Pendente | Crítico | O código usa PostgreSQL; falta confirmar configuração real, acesso, backup e restauração no ambiente de produção. |
| Backup e restauração | ⚠️ Pendente | Crítico | Ainda é necessário automatizar backup e testar a restauração. |
| Permissões de segredos e banco | ⚠️ Verificar | Alto | Proteger `.env` local e restringir acesso às variáveis e ao banco gerenciado no Render/Supabase. |
| Dependências auditadas | ✅ Verificado (produção) | Médio | `npm audit --omit=dev` encontrou 0 vulnerabilidades conhecidas; repetir periodicamente. |
| Minimização de logs | ✅ Parcial | Médio | Removidos dados pessoais e respostas detalhadas do Mercado Pago dos logs da aplicação; revisar logs e retenção no provedor. |
| CSRF do painel | ✅ Parcial | Médio | O token em header reduz CSRF tradicional; manter admin fora de acesso público e usar HTTPS. |
| Autorização de acompanhamento | ✅ Implementado com compatibilidade legada | Alto | Token de 256 bits separado do UUID, hash no banco, validade de 90 dias e revogação administrativa; pedidos antigos usam UUID temporariamente. |

## Persistência do usuário e dos pedidos

- O código usa PostgreSQL por meio de `DATABASE_URL`; a configuração documentada usa Supabase.
- Em produção, a conexão força `sslmode=verify-full` e exige `DB_SSL_CA`; `DB_SSL=false` só desativa TLS fora de produção.
- Produtos, itens, pagamentos, status e eventos de webhook são persistidos no banco.
- O navegador guarda ID e token de acompanhamento em `localStorage`, para retomar o pedido no mesmo navegador após fechar e reabrir a página.
- O `localStorage` é apagado quando o pedido chega a um estado final.
- O token autoriza consulta do Pix pendente e tentativa de cancelamento; em dispositivo compartilhado, outra pessoa com acesso ao navegador pode retomar esse acesso. O proprietário pode revogá-lo no painel.
- Por até 90 dias, pedidos anteriores à migração continuam aceitando o UUID como credencial.
- O banco não deve ficar em armazenamento temporário do provedor de hospedagem.


## Vulnerabilidades e riscos que ainda precisam de tratamento

### Alto

1. **Perda de dados sem backup:** falha do disco ou do provedor pode apagar pedidos. Configurar cópia automática, retenção e teste de restauração.
2. **Admin exposto na internet:** além do token, configure `ADMIN_ALLOWED_IPS` no Render e valide a restrição de IP na implantação. A allowlist do Express depende do IP informado pelo proxy.
3. **Segredos de teste expostos:** tokens que tenham sido compartilhados em terminal, editor, captura ou conversa devem ser revogados e substituídos antes do deploy.
4. **Credencial bearer no navegador:** quem obtiver o token do `localStorage` pode consultar ou tentar cancelar o pedido. Revogá-lo pelo admin se o dispositivo for compartilhado/perdido; remover a compatibilidade por UUID após a janela legada de 90 dias.

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
- `server.js` confia em três saltos de proxy (`trust proxy = 3`). A regra de IP do admin depende de a topologia e os cabeçalhos do Render corresponderem exatamente a essa configuração. Validar em produção, tentar acesso de IP permitido e não permitido e confirmar que `/api/webhook` continua acessível.
- A restrição por `ADMIN_ALLOWED_IPS` está no código, mas não é possível confirmar neste repositório se a variável foi configurada no Render.
- O projeto declara `node >=18`; o operador deve fixar uma versão LTS de Node.js ainda suportada na implantação.

## Auditoria técnica estática — atualização 06/10/2026

Escopo: leitura do código atual, revisão de dependências e metadados Git. Não houve pentest, teste contra Render/Supabase/Mercado Pago de produção nem leitura dos valores do `.env`.

### Achados priorizados e estado das correções

1. **Alto — mitigado no código; aguarda teste integrado.** A tabela `tentativas_cobranca` agora é gravada na mesma transação do pedido antes de chamar o Mercado Pago. A chamada usa chave idempotente persistida; falhas são reagendadas com backoff e lease, e o job tenta recuperar o vínculo. Pedidos legados pendentes sem linha de pagamento recebem tentativa de migração usando o UUID já usado como chave. Ainda é necessário comprovar no sandbox as falhas entre a resposta externa e a persistência, reinício do processo e resposta HTTP 202. Evidência: `src/db.js`, `src/cobrancas.js`, `src/rotas/pedidos.js`, `src/jobs.js`.
2. **Médio — mitigado para novos pedidos; janela legada limitada a 90 dias.** Novas rotas públicas exigem token aleatório de 256 bits, armazenado apenas como hash, distinto do UUID e enviado em `x-order-access-token`. O token expira em 90 dias e pode ser revogado pelo admin. Pedidos anteriores, sem hash, aceitam o UUID apenas durante 90 dias da criação. O token no navegador é bearer credential e fica no `localStorage`; proteger contra XSS e validar a remoção/revogação. Evidência: `src/acesso-pedido.js`, `src/rotas/pedidos.js`, `src/rotas/admin.js`, `public/app.js`.
3. **Médio, condicionado à infraestrutura — `trust proxy = 3` é uma suposição fixa.** Se os caminhos de rede tiverem quantidade diferente de saltos ou houver caminhos alternativos, `req.ip` pode identificar um proxy ou confiar em valor encaminhado indevidamente, afetando a allowlist de admin e rate limits por IP. Confirmar topologia e cabeçalhos reais do Render; preferir confiar em sub-redes/entrada conhecida se o provedor documentar os endereços, em vez de confiar apenas numa quantidade fixa. Evidência: `server.js`.
4. **Médio — webhook ainda depende da reconciliação.** O evento é persistido e recebe HTTP 200 antes de `processarPagamento` terminar. Em caso de falha, a mesma entrega é deduplicada e reconhecida; a recuperação depende dos jobs periódicos. O outbox agora recupera a criação/vínculo da cobrança, mas não é uma fila de tentativas de processamento de webhook; continua recomendável adicionar estados/retry próprios e paginação. Evidência: `src/rotas/webhook.js`, `src/jobs.js`.
5. **Médio — o limite de pedidos pendentes por contato admite corrida.** A contagem por telefone/e-mail ocorre antes da transação de criação; requisições paralelas podem todas observar valor abaixo do limite. Tornar a verificação serializável/atômica ou aplicar bloqueio por contato. Evidência: `src/pedidos.js`.
6. **Médio, condicionado à configuração — URL arbitrária/HTTP para Storage recebe a chave service-role.** O código permite `http://` e qualquer host em `SUPABASE_URL` e envia a chave administrativa nos cabeçalhos. Uma configuração incorreta pode transmitir a chave a terceiro sem TLS. Exigir HTTPS e validar o host esperado do projeto Supabase. Evidência: `src/storage.js`.
7. **Médio — dados de alergias/saúde podem ser enviados em campo livre.** O checkout sugere que alergias sejam informadas; essa informação pode ser dado pessoal sensível. A política reconhece que falta uma hipótese legal específica implementada. Definir a base legal, minimizar o dado e obter consentimento específico e destacado se essa for a hipótese adotada, antes da coleta. Evidência: `public/index.html`, `public/privacidade.html`.
8. **Médio — retenção indefinida de dados de pedidos e eventos.** Não há exclusão automática nem política de retenção executável no código. Definir prazo por categoria, descarte/anonimização e retenção de backups. Evidência: `src/db.js`, `public/privacidade.html`.
9. **Baixo — uploads públicos mantêm os bytes e metadados originais.** A aplicação valida MIME e assinaturas iniciais, mas não decodifica/regrava imagem para remover EXIF; fotos podem revelar metadados como localização. Reprocessar imagens e remover metadados antes de torná-las públicas. Evidência: `src/storage.js`.
10. **Resolvido no código — respostas públicas com Pix usam `Cache-Control: no-store`.** Confirmar o cabeçalho na implantação publicada. Evidência: `src/rotas/pedidos.js`.
11. **Baixo — `.env` local com permissão `664`.** O arquivo não está versionado e `.gitignore` o exclui, mas o grupo local também pode lê-lo. Restringir as permissões do arquivo a `600` e controlar membros do grupo.
12. **Baixo — relatório/checklist requer atualização contínua.** A inicialização desativa o produto legado `t1`; ele não deve ser reativado pelo painel caso a descontinuação seja permanente. Remover o registro do catálogo mantendo snapshots em `pedido_itens`, ou proteger esse ID de reativação.

### Controles verificados e limites

- `.env` não aparece como arquivo rastreado pelo Git e os arquivos comuns de chave/certificado pesquisados não apareceram como rastreados. Isso não verifica refs remotas ou segredos em histórico externo. **Credenciais de produção anteriormente expostas na conversa devem ser rotacionadas.**
- `npm audit` reportou **0 vulnerabilidades conhecidas** na árvore de dependências auditada nesta execução.
- `node --check` passou para todos os arquivos JavaScript de `src/`, `public/`, `scripts/` e `server.js`.
- `npm test` executou 5 testes unitários de formato/hash/prazo do token e backoff; não substituem testes integrados de banco/pagamento/webhook.
- A implantação real, `ADMIN_ALLOWED_IPS`, CA/TLS do Supabase, bucket, HTTPS e política de backup não podem ser comprovados pelo clone local.

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
