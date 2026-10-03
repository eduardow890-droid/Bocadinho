const { z } = require('zod');

const limpar = s => s.replace(/\s+/g, ' ').trim();
const texto = (min, max, msg) =>
  z.string({ required_error: msg, invalid_type_error: msg })
    .transform(limpar)
    .pipe(z.string().min(min, msg).max(max, msg));

const criarPedidoSchema = z.object({
  nome: texto(2, 80, 'Informe seu nome (2 a 80 caracteres).'),

  email: z.string({ required_error: 'Informe seu e-mail.' })
    .trim().toLowerCase().max(120, 'E-mail muito longo.')
    .email('E-mail inválido.'),

  // aceita (21) 98592-9831, 21985929831, +55 21 98592-9831...
  telefone: z.string({ required_error: 'Informe seu telefone.' })
    .transform(s => s.replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, ''))
    .pipe(z.string().regex(/^[1-9]{2}(?:9\d{8}|[2-5]\d{7})$/, 'Telefone inválido. Use DDD + número.')),

  tipo: z.enum(['entrega', 'retirada'], { errorMap: () => ({ message: 'Escolha entrega ou retirada.' }) }),

  regiao: z.string().default('').transform(limpar).pipe(z.string().max(80, 'Bairro muito longo.')),

  cidade: z.string().default('').transform(limpar).pipe(z.string().max(80, 'Cidade muito longa.')),
  rua: z.string().default('').transform(limpar).pipe(z.string().max(120, 'Rua muito longa.')),
  numero: z.string().default('').transform(limpar).pipe(z.string().max(20, 'Número inválido.')),
  complemento: z.string().default('').transform(limpar).pipe(z.string().max(100, 'Complemento muito longo.')),

  endereco: z.string().default('').transform(limpar)
    .pipe(z.string().max(200, 'Endereço muito longo.')),

  obs: z.string().default('').transform(limpar)
    .pipe(z.string().max(300, 'Observação muito longa (máx. 300 caracteres).')),

  itens: z.array(z.object({
    id: z.string().regex(/^[a-z0-9_-]{1,20}$/i, 'Produto inválido.'),
    qtd: z.number({ invalid_type_error: 'Quantidade inválida.' }).int('Quantidade inválida.')
      .min(1, 'Quantidade mínima é 1.').max(99, 'Quantidade máxima é 99.')
  }).strict()).min(1, 'Escolha pelo menos um produto.').max(20, 'Itens demais no pedido.')
}).strict().superRefine((d, ctx) => {
  if (d.tipo === 'entrega') {
    if (d.rua.length < 3) ctx.addIssue({ code: 'custom', path: ['rua'], message: 'Informe a rua.' });
    if (!d.numero.length) ctx.addIssue({ code: 'custom', path: ['numero'], message: 'Informe o número.' });
    if (d.regiao.length < 2) ctx.addIssue({ code: 'custom', path: ['regiao'], message: 'Informe o bairro.' });
    if (d.cidade.length < 2) ctx.addIssue({ code: 'custom', path: ['cidade'], message: 'Informe a cidade.' });
  }
  const ids = d.itens.map(i => i.id);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: 'custom', path: ['itens'], message: 'Produto repetido no pedido.' });
  }
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function formatarErros(error) {
  const campos = {};
  for (const i of error.issues) {
    const chave = i.path[0] ?? 'geral';
    if (!campos[chave]) campos[chave] = i.message;
  }
  return { erro: Object.values(campos)[0], campos };
}

module.exports = { criarPedidoSchema, formatarErros, UUID };
