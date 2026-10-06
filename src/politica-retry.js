const RETRY_BASE_MS = 30 * 1000;
const RETRY_MAX_MS = 15 * 60 * 1000;

function atrasoRetryMs(tentativas) {
  return Math.min(RETRY_BASE_MS * (2 ** Math.min(Math.max(Number(tentativas) - 1, 0), 8)), RETRY_MAX_MS);
}

module.exports = { atrasoRetryMs, RETRY_BASE_MS, RETRY_MAX_MS };