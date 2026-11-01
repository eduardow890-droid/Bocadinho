# Manual de produção — Bocadinho

Este manual registra as decisões mínimas para publicar e operar a aplicação Bocadinho.

## Responsável

- Controlador: Wagner Eduardo de Oliveira Henrique — Bocadinho.
- CNPJ: 69.680.847/0001-60.
- Endereço: Rio de Janeiro/RJ, Senador Camará, Rua B, nº 7, casa 3.
- Canal de privacidade e incidentes: bocadinhocookie@gmail.com.
- WhatsApp operacional: (21) 98592-9831.

## Produção inicial

- Domínio: `https://bocadinho.onrender.com`.
- Plataforma: Render.
- Banco: PostgreSQL/Supabase.
- Node.js: versão LTS mantida, preferencialmente 22 ou superior.
- Reembolso: procedimento manual no painel do Mercado Pago.
- Telegram: somente avisos operacionais de novos pedidos; não inserir dados pessoais desnecessários nas mensagens.

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
- Reter logs operacionais por até 90 dias, salvo investigação ou obrigação legal.
- Atender solicitações de titulares pelo e-mail de privacidade.
- Registrar protocolo, identidade confirmada, solicitação, decisão e data de resposta.
- Não colocar tokens, dados de cartão, endereços completos ou dados de saúde em logs ou mensagens do Telegram.

## Backup e restauração

Estado atual:

- Backup automático: não disponível no plano gratuito informado.
- Backup manual externo: não implementado por enquanto.
- Restauração de teste: não realizada.
- RTO/RPO de 24 horas: metas desejadas, ainda não validadas.

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

Não liberar pagamentos reais antes de concluir os testes de aprovação, recusa, Pix, Webhook, cancelamento, acesso administrativo e proteção de dados. A recuperação por backup permanece uma limitação conhecida e não pode ser considerada testada ou garantida enquanto não houver cópia independente e restauração validada.
