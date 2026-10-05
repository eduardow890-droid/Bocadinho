const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cfg = require('./src/config');
const db = require('./src/db');
const { iniciarJobs } = require('./src/jobs');

const app = express();
const origemImagensProdutos = (() => {
  try { return new URL(process.env.SUPABASE_URL).origin; }
  catch (_) { return null; }
})();
// Render encaminha a requisição por três saltos; mantenha este número alinhado
// com a cadeia observada em X-Forwarded-For no serviço.
app.set('trust proxy', 3);
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'img-src': ["'self'", 'data:', ...(origemImagensProdutos ? [origemImagensProdutos] : [])],
      // em desenvolvimento (http://localhost) não forçamos https
      'upgrade-insecure-requests': cfg.producao ? [] : null
    }
  }
}));
app.use(express.json({ limit: '20kb' }));

const ipsAdminPermitidos = new Set(
  (process.env.ADMIN_ALLOWED_IPS || '')
    .split(',')
    .map(ip => ip.trim().replace(/^::ffff:/, '').toLowerCase())
    .filter(Boolean)
);

function restringirAdminPorIp(req, res, next) {
  if (!cfg.producao && ipsAdminPermitidos.size === 0) return next();

  const ip = (req.ip || '').replace(/^::ffff:/, '').toLowerCase();
  if (!ipsAdminPermitidos.has(ip)) {
    return res.status(403).type('text/plain').send('Acesso restrito.');
  }
  next();
}

// Endpoint mínimo para monitoramento externo (Render/UptimeRobot).
app.get('/ping', (req, res) => res.json({ status: 'alive' }));

app.use('/api/webhook', require('./src/rotas/webhook'));
app.use(['/admin', '/api/admin'], restringirAdminPorIp);
app.use('/api/admin', require('./src/rotas/admin'));
app.use('/api', require('./src/rotas/pedidos'));

// A página não contém dados sensíveis; os dados continuam protegidos pela API.
app.get(['/admin', '/admin/'], (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
  res.sendFile(path.join(__dirname, 'public', 'admin', 'admin.html'));
});

// Ícones e imagem social ficam fora da pasta pública principal.
app.use('/brand-assets', express.static(path.join(__dirname, 'assets'), {
  maxAge: '1d',
  index: false
}));

app.use(express.static(path.join(__dirname, 'public')));

// 404 para rotas /api desconhecidas
app.use('/api', (req, res) => res.status(404).json({ erro: 'Rota não encontrada.' }));

// tratador de erros: não vaza detalhes internos
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ erro: 'JSON inválido.' });
  console.error('[erro]', err);
  res.status(500).json({ erro: 'Erro interno. Tente novamente.' });
});

async function iniciar() {
  await db.init();
  app.listen(cfg.porta, () => {
    console.log(`Bocadinho no ar: http://localhost:${cfg.porta}`);
    iniciarJobs();
  });
}

iniciar().catch(e => {
  console.error('[banco] falha ao inicializar Supabase:', e.message);
  process.exit(1);
});
