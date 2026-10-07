-- Bocadinho: proteção das tabelas públicas do schema public.
--
-- O navegador NÃO usa o Supabase Data API. Toda leitura/escrita passa pelo
-- backend Express, que usa DATABASE_URL e a chave service_role somente para
-- o Storage. Por isso, não há políticas para anon/authenticated: sem uma
-- política, esses papéis não conseguem ler nem alterar dados diretamente.
-- A conexão do backend é feita pelo proprietário/role de serviço do banco e
-- continua funcionando com RLS habilitado.

ALTER TABLE public.produtos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pedidos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pedido_itens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pagamentos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.eventos_webhook ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tentativas_cobranca ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.acesso_pedido ENABLE ROW LEVEL SECURITY;

-- Corrige também os dois avisos de foreign key sem índice mostrados pelo
-- Database Advisor. Isso ajuda joins, exclusões e consultas por pedido.
CREATE INDEX IF NOT EXISTS idx_pagamentos_pedido_id
  ON public.pagamentos (pedido_id);
CREATE INDEX IF NOT EXISTS idx_pedido_itens_pedido_id
  ON public.pedido_itens (pedido_id);

-- Não crie políticas públicas nessas tabelas. O RLS sem policies é deny-all
-- para anon/authenticated, protegendo dados pessoais, endereços e pagamentos.

-- Storage:
-- 1. Crie um bucket PUBLIC chamado "produtos" para permitir a leitura das
--    imagens pelo cardápio através de /storage/v1/object/public/.
-- 2. Não crie policy de INSERT/UPDATE/DELETE para anon/authenticated.
--    O backend envia e remove objetos usando SUPABASE_SERVICE_ROLE_KEY.
-- 3. Se o bucket for PRIVATE, será necessário alterar storage.js para gerar
--    URLs assinadas; não use o SQL abaixo nesse cenário.
