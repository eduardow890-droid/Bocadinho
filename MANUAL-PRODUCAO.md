# Manual de produção — Bocadinho

Este manual registra as decisões mínimas para publicar e operar a aplicação Bocadinho.

## Responsável

- Controlador: Wagner Eduardo de Oliveira Henrique — Bocadinho.
- Responsável técnico e por tratar solicitações de titulares, incluindo executar exclusões quando cabíveis: Wagner, programador e titular do MEI.
- Administradora operacional: Tallyta Cristina, responsável por pedidos, financeiro e recebimento das reclamações dos clientes. Ela encaminha solicitações de privacidade ao Wagner para análise e tratamento técnico.
- CNPJ: 69.680.847/0001-60.
- Endereço: Rio de Janeiro/RJ, Senador Camará, Rua B, nº 7, casa 3.
- Canal de privacidade e incidentes: bocadinhocookie@gmail.com.
- WhatsApp operacional: (21) 98592-9831.
- Autorização de publicação e ativação de pagamentos reais: Wagner.

## Produção inicial

- Domínio: `https://bocadinho.onrender.com`.
- Plataforma: Render.
- Banco: PostgreSQL/Supabase.
- Node.js: versão LTS mantida, preferencialmente 22 ou superior.
- Reembolso: procedimento manual no painel do Mercado Pago.
- Telegram: somente avisos operacionais de novos pedidos; não inserir dados pessoais desnecessários nas mensagens.
- Situação dos pagamentos: a equipe confirmou que a configuração de produção foi conferida e que o teste controlado de Pix, webhook e cancelamento/reembolso foi concluído.
- Regiões informadas pela equipe: Render Oregon; Supabase us-east-1.
- Política de compra: aprovada pela equipe, publicada em `public/termos.html` e vinculada aos rodapés do site e ao checkout.

## Liberação para clientes — estado informado em 2026-11-01

A equipe confirmou que verificou e considera prontos os itens operacionais da lista de liberação:

- produção está no deploy revisado, com política de privacidade e aviso do checkout atualizados;
- credenciais de produção e segredo do webhook estão configurados no servidor, fora do Git e do frontend;
- o ciclo controlado Pix/webhook foi testado, incluindo confirmação única, estados pendentes/recusados e tratamento de notificações repetidas;
- cancelamento/reembolso do teste foi conferido no Mercado Pago e no pedido;
- checkout, retirada, entrega, valores, mensagens, acompanhamento e uso em celular foram verificados;
- acesso administrativo por IP e token foi testado, incluindo bloqueio de acessos não autorizados;
- Wagner e Tallyta farão o monitoramento diário de pagamentos, webhooks, erros e imagens; Wagner autoriza a pausa da operação.

Esta confirmação registra o estado relatado pela equipe; não é uma verificação independente do deploy, dos painéis dos fornecedores ou das transações. Posteriormente, a equipe informou que os canais de privacidade foram testados e que Wagner recebe e atende os contatos. Wagner e Tallyta farão o monitoramento diário; Wagner autoriza a pausa, mas o critério operacional para interromper pagamentos ainda precisa ser definido. A liberação operacional não elimina os riscos aceitos abaixo: ainda não há backup externo nem restauração testada, RTO/RPO não são garantias, e a retenção de logs do Render Hobby é de 7 dias sem cópia externa.

## Decisões e pendências informadas em 2026-11-01

- Região: a equipe informou Render Oregon e Supabase us-east-1. A política foi atualizada com esses dados informados; confirmar nos painéis se o banco e o Storage estão efetivamente na região indicada.
- Retenção: a equipe pretende manter pedidos e pagamentos por até 2 anos, sujeito a mudança. Não há expurgo automático implementado; o fim do prazo exige definir e executar o descarte ou documentar a retenção por obrigação aplicável.
- Canal de privacidade: e-mail e WhatsApp testados; Wagner recebe e atende solicitações.
- Monitoramento inicial: Wagner e Tallyta conferem diariamente pagamentos, webhooks, erros e imagens. Wagner autoriza a pausa da operação; critério operacional para pausar ainda deve ser definido.
- Revisão das pendências: 2026-12-01.
- Termos de compra: aprovados pela equipe e publicados em `public/termos.html`; links adicionados ao site e ao checkout em 2026-11-01.

## Homologação — estado informado em 2026-11-01

Após o deploy mais recente no Render, a equipe informou que:

- o teste de recusa `CALL` mostrou a mensagem e o botão “Tentar outro cartão”; o formulário reapareceu ao clicar;
- a recusa `OTHE` foi explicada e permitiu nova tentativa;
- o pagamento `CONT` permaneceu pendente/em análise, sem ser marcado como pago nem liberar o preparo;
- o pagamento `APRO` foi confirmado corretamente;
- não apareceram erros nos logs após esses testes;
- o bucket `produtos` foi criado no projeto Supabase configurado no Render e as fotos aparecem;
- o painel administrativo mostra pagamentos pendentes/recusados em “Atenção”.

Esses resultados foram relatados pela equipe e não foram reproduzidos de forma independente nesta revisão. Repetir a homologação após qualquer mudança no fluxo de pagamento ou configuração.

## Objetivos de recuperação

- RTO desejado: 24 horas. Ainda não foi medido por um teste de restauração.
- RPO desejado: 24 horas. Ainda não é atendido nem comprovado.
- Situação atual informada: o projeto usa o plano gratuito do Supabase, sem backup automático disponível no painel, e não há uma rotina manual de backup implementada.
- Risco: se o banco for perdido ou corrompido, os pedidos e demais dados poderão não ser recuperáveis. O histórico de pedidos posterior ao último backup disponível também pode ser perdido.

Até que exista uma cópia independente e uma restauração testada, não tratar RTO/RPO como garantias nem considerar a recuperação de banco como concluída para produção. Quando houver condição de implementar, avaliar exportação periódica do banco para local seguro, separado do Supabase e do Git, e cópia independente das imagens do Storage. Backup do banco não contém os arquivos de imagem.

## Acesso administrativo

O painel `/admin` exige o token administrativo e, em produção, a lista `ADMIN_ALLOWED_IPS`.

Como a conexão da loja não possui IP fixo:

1. descubra o IP público atual da rede administrativa;
2. configure-o no Render em `ADMIN_ALLOWED_IPS`;
3. teste o acesso ao `/admin` e à API administrativa;
4. atualize a variável quando o provedor de internet alterar o IP;
5. mantenha o token fora do Git, do frontend e de mensagens.

Se a troca frequente de IP causar indisponibilidade, usar uma VPN com IP fixo é preferível a remover a restrição de IP.

## Mercado Pago

1. Use credenciais de teste para homologação e credenciais de produção somente após os testes.
2. Configure o Webhook em:
   `https://bocadinho.onrender.com/api/webhook/mercadopago`
3. Selecione o evento Order.
4. Configure a assinatura secreta no Render como `MP_WEBHOOK_SECRET`.
5. Teste assinatura válida, inválida, repetida e recuperação por reconciliação.
6. Reembolsos são feitos manualmente no painel do Mercado Pago e devem ser registrados internamente com pedido, motivo, valor e data.

## Privacidade

- Não solicitar alergias ou dados de saúde no campo de observação.
- Orientar o cliente a entrar em contato pelo WhatsApp do site.
- Retenção de logs no Render Hobby (plano gratuito): 7 dias, conforme a documentação oficial do Render consultada em 2026-11-01. Logs anteriores a esse período deixam de estar disponíveis no painel.
- Prazo desejado para logs operacionais: até 90 dias, salvo investigação ou obrigação legal. O histórico padrão do Render Hobby não atende esse objetivo; seria necessário exportar os logs para um destino externo com retenção adequada.
- Atender solicitações de titulares pelo e-mail de privacidade.
- Registrar protocolo, identidade confirmada, solicitação, decisão e data de resposta.
- Não colocar tokens, dados de cartão, endereços completos ou dados de saúde em logs ou mensagens do Telegram.

## Verificação de retenção — 2026-11-01

Consulta somente de leitura executada no PostgreSQL/Supabase. Os resultados mostram a idade dos registros atualmente existentes, não uma regra de exclusão automática:

- Pedidos: registro mais antigo em `2026-10-29 02:53:47 UTC`.
- Pagamentos: registro mais antigo em `2026-10-31 00:18:30 UTC`.
- Eventos de webhook: registro mais antigo em `2026-11-01 02:24:59 UTC`.
- Tokens de acompanhamento: 0 expirados e 0 revogados; vencimento mais antigo em `2027-01-27 02:53:47 UTC`. A expiração limita o acesso, mas não apaga o registro.
- Sessões de conta: 0 expiradas e 1 válida; vencimento mais antigo em `2026-11-28 02:50:25 UTC`. O sistema executa limpeza de sessões expiradas periodicamente, mas o resultado atual não comprova histórico ou periodicidade de execução.
- Logs do Render Hobby: retenção documentada de 7 dias. Como o serviço é recente, ainda não há histórico local para observar o descarte, mas o limite aplicável do plano é conhecido.
- Backups Supabase: nenhum backup disponível no plano gratuito informado; backup externo e restauração não implementados.

Conclusão: não há evidência suficiente de expurgo automático de pedidos, pagamentos, eventos de webhook ou tokens expirados. A operação informou depois a intenção de reter pedidos e pagamentos por até 2 anos, sujeita a revisão; esse prazo ainda não está automatizado. Não inferir expurgo pelas datas mais antigas encontradas. Implementar/verificar exclusão ou anonimização ao fim do prazo e não apagar registros sem avaliar obrigações legais e exercício regular de direitos.

Decisão operacional informada em 2026-11-01: manter pedidos e pagamentos por até 2 anos, sujeito a mudança. A equipe pretende rever a decisão até 2026-12-01. Isso ainda não configura uma regra automática de descarte.

## Backup e restauração

Estado atual:

- Backup automático: não disponível no plano gratuito informado.
- Backup manual externo: não implementado por enquanto.
- Restauração de teste: não realizada.
- RTO/RPO de 24 horas: metas desejadas, ainda não validadas.
- A equipe informou que compreende e aceita provisoriamente o risco de perda irrecuperável enquanto não houver cópia externa. Essa aceitação não cria capacidade de restauração nem comprova RTO/RPO.

Quando for possível implementar uma rotina, antes de considerar a recuperação pronta:

- definir frequência, responsável, local seguro e retenção dos backups do banco;
- manter cópia separada das imagens do Supabase Storage;
- testar a restauração em ambiente separado, sem sobrescrever o projeto ativo;
- medir o tempo de recuperação e a diferença entre o último backup e os dados recuperados;
- conferir se o serviço, o domínio e as imagens funcionam após a restauração.

## Resposta a incidente

Em caso de acesso indevido, vazamento, perda do banco ou exposição de token:

1. preservar logs e evidências;
2. revogar tokens e rotacionar segredos afetados;
3. bloquear o acesso administrativo se necessário;
4. avaliar quais dados e titulares foram afetados;
5. registrar a análise e as medidas de contenção;
6. avaliar a comunicação à ANPD e aos titulares conforme a LGPD e regulamentação aplicável;
7. informar o controlador pelo canal de privacidade.

## Critério de liberação

Os testes de cartão `CALL`, `OTHE`, `CONT` e `APRO`, funcionamento do bucket/fotos e a visualização de atenção no admin foram relatados como concluídos em homologação. Em 2026-11-01, a equipe também informou ter concluído as verificações de produção e estar pronta para a abertura ampla. A decisão de abrir ao público cabe ao controlador. A operação aceita provisoriamente o risco de não haver backup externo; backup e restauração continuam sem implementação, e RTO/RPO não são garantias. A retenção de logs do Render Hobby é de 7 dias, sem cópia externa. Permanecem pendentes a definição de critérios de pausa, a confirmação das regiões nos painéis e a avaliação de expurgo correspondente ao prazo de retenção de até 2 anos informado pela equipe.
