const crypto = require('crypto');

const TIPOS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp'
};

function configuracao() {
  const base = process.env.SUPABASE_URL?.trim().replace(/\/$/, '');
  const chave = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const bucket = process.env.SUPABASE_STORAGE_BUCKET?.trim() || 'produtos';
  if (!base || !chave) {
    const erro = new Error('Configure SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY para habilitar fotos.');
    erro.status = 503;
    throw erro;
  }
  if (!/^https?:\/\//i.test(base) || !/^[a-z0-9_-]+$/i.test(bucket)) {
    const erro = new Error('Configuração do Supabase Storage inválida.');
    erro.status = 503;
    throw erro;
  }
  return { base, chave, bucket };
}

function caminhoCodificado(caminho) {
  return caminho.split('/').map(encodeURIComponent).join('/');
}

async function chamadaStorage(caminho, opcoes) {
  const { base, chave } = configuracao();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    return await fetch(`${base}/storage/v1/${caminho}`, {
      ...opcoes,
      signal: controller.signal,
      headers: {
        apikey: chave,
        Authorization: `Bearer ${chave}`,
        ...opcoes.headers
      }
    });
  } catch (e) {
    const erro = new Error(e.name === 'AbortError' ? 'Tempo esgotado ao acessar o armazenamento de imagens.' : 'Falha ao acessar o armazenamento de imagens.');
    erro.status = 502;
    throw erro;
  } finally {
    clearTimeout(timeout);
  }
}

function validarArquivo(file) {
  if (!file || !TIPOS[file.mimetype]) {
    const erro = new Error('Envie uma imagem JPEG, PNG ou WebP.');
    erro.status = 400;
    throw erro;
  }
  const b = file.buffer;
  const jpeg = file.mimetype === 'image/jpeg' && b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  const png = file.mimetype === 'image/png' && b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const webp = file.mimetype === 'image/webp' && b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP';
  if (!jpeg && !png && !webp) {
    const erro = new Error('O conteúdo do arquivo não corresponde a uma imagem JPEG, PNG ou WebP válida.');
    erro.status = 400;
    throw erro;
  }
  return TIPOS[file.mimetype];
}

async function enviarImagem(file) {
  const extensao = validarArquivo(file);
  const { bucket } = configuracao();
  const caminho = `${crypto.randomUUID()}.${extensao}`;
  const resposta = await chamadaStorage(`object/${encodeURIComponent(bucket)}/${caminhoCodificado(caminho)}`, {
    method: 'POST',
    headers: { 'Content-Type': file.mimetype, 'x-upsert': 'false' },
    body: file.buffer
  });
  if (!resposta.ok) {
    const erro = new Error('Não foi possível salvar a imagem no Supabase Storage.');
    erro.status = 502;
    throw erro;
  }
  const { base } = configuracao();
  return {
    caminho,
    url: `${base}/storage/v1/object/public/${encodeURIComponent(bucket)}/${caminhoCodificado(caminho)}`
  };
}

async function excluirImagem(caminho) {
  if (!caminho) return;
  const { bucket } = configuracao();
  const resposta = await chamadaStorage('object/' + encodeURIComponent(bucket), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: [caminho] })
  });
  if (!resposta.ok) throw new Error('Não foi possível remover uma imagem antiga do Supabase Storage.');
}

module.exports = { enviarImagem, excluirImagem };