/* =========================================================
   Test koşum altyapısı.

   Neden Express kullanmıyor: bu ortamda npm kayıt defteri erişilebilir
   değil, dolayısıyla express kurulu değil. Ama P0-A1'de eklenen TÜM
   güvenlik kodu (security.js + coach.js) bilinçli olarak Express'ten
   bağımsız yazıldı - Express'in (req,res,next) sözleşmesi zaten Node'un
   yerleşik http imzasının üzerine "next" eklemekten ibaret.

   Bu dosyadaki runMiddleware(), server.js'in /ai/coach için kurduğu
   zincirin AYNISINI aynı sırayla çalıştırır. Yani testler gerçek üretim
   kodunu çalıştırıyor; yalnızca yönlendirici (router) farklı.

   Express'e özgü kısımlar (express.static, app.get/post yönlendirmesi)
   ayrıca test/express.integration.test.mjs içinde test edilir; o dosya
   express kurulu değilse kendini atlar.
   ========================================================= */

import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sec = require('../security.js');
const { createCoachHandler } = require('../coach.js');

/* Express'in middleware dispatcher'ının minimal eşdeğeri:
   sırayla çalıştır, next(err) gelirse hata yöneticisine atla. */
export function runMiddleware(chain, errorHandler, req, res) {
  let i = 0;
  function next(err) {
    if (err) return errorHandler(err, req, res, () => {});
    const mw = chain[i++];
    if (!mw) {
      // Zincir bitti ama kimse yanıt yazmadı => 404
      const e = new Error('not-found');
      e.status = 404;
      e.publicMessage = 'Kaynak bulunamadı.';
      e.safeType = 'not_found';
      return errorHandler(e, req, res, () => {});
    }
    try {
      const out = mw(req, res, next);
      if (out && typeof out.catch === 'function') out.catch(next);
    } catch (e) {
      next(e);
    }
  }
  next();
}

/* Logları yutan ama inceleyebildiğimiz bir logger - testlerin çıktısı
   kirlenmesin ve "hassas veri loglandı mı" iddiasını doğrulayabilelim. */
export function makeLogger() {
  const lines = [];
  const push = (...args) => lines.push(args.map(String).join(' '));
  return { log: push, warn: push, error: push, lines };
}

/* server.js'teki /ai/coach zincirinin birebir kopyası. */
export async function startTestServer(options = {}) {
  const {
    corsOrigins = [],
    corsCredentials = false,
    rateLimitMax = 10,
    rateLimitWindowMs = 60000,
    production = false,
    trustProxy = false,
    apiKey = 'test-key-never-logged',
    openaiUrl,
    openaiTimeoutMs = 25000,
    fetchImpl,
  } = options;

  const logger = makeLogger();

  const limiter = sec.createRateLimiter({
    windowMs: rateLimitWindowMs,
    max: rateLimitMax,
    trustProxy,
    name: 'ai-coach',
  });

  const corsMw = sec.cors({ origins: corsOrigins, credentials: corsCredentials, methods: 'POST,OPTIONS' });
  const headersMw = sec.securityHeaders({ production, trustProxy });
  const errorHandler = sec.createErrorHandler({ logger });

  const coachHandler = createCoachHandler({
    apiKey,
    model: 'gpt-5.6-luna',
    url: openaiUrl,
    timeoutMs: openaiTimeoutMs,
    fetch: fetchImpl,
    logger,
  });

  const coachChain = [
    sec.requestId,
    headersMw,
    corsMw,
    limiter,
    sec.readJsonBody({ limit: sec.BODY_LIMIT_BYTES }),
    sec.requireAuthenticatedUser,
    sec.validateCoachRequest,
    coachHandler,
  ];

  const server = http.createServer((req, res) => {
    const url = (req.url || '').split('?')[0];

    // /health: rate limit YOK, CORS yok - server.js ile aynı.
    if (url === '/health' && req.method === 'GET') {
      return runMiddleware([
        sec.requestId,
        headersMw,
        (rq, rs) => {
          rs.statusCode = 200;
          rs.setHeader('Content-Type', 'application/json; charset=utf-8');
          rs.end(JSON.stringify({
            status: 'ok',
            timestamp: new Date().toISOString(),
            uptimeSec: Math.round(process.uptime()),
            openaiConfigured: !!apiKey,
          }));
        },
      ], errorHandler, req, res);
    }

    if (url === '/ai/coach') {
      // OPTIONS preflight: yalnızca cors middleware'i yanıtlar.
      if (req.method === 'OPTIONS') {
        return runMiddleware([sec.requestId, headersMw, corsMw], errorHandler, req, res);
      }
      if (req.method !== 'POST') {
        return runMiddleware([sec.requestId, headersMw, corsMw, sec.validateCoachRequest], errorHandler, req, res);
      }
      return runMiddleware(coachChain, errorHandler, req, res);
    }

    return runMiddleware([sec.requestId, headersMw], errorHandler, req, res);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    logger,
    limiter,
    async close() {
      limiter.stop();
      await new Promise((resolve) => server.close(resolve));
    },
    server,
  };
}

/* Sahte OpenAI sunucusu. Gerçek OpenAI'a HİÇ istek gitmez; anahtar da
   sahtedir. `behaviour` ile hata/timeout senaryoları üretilir. */
export async function startMockOpenAI(behaviour = 'ok') {
  const received = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      received.push({ headers: req.headers, body: raw });

      if (behaviour === 'hang') return; // yanıt yok => istemci timeout'a düşer
      if (behaviour === '429') { res.statusCode = 429; return res.end('{}'); }
      if (behaviour === '401') { res.statusCode = 401; return res.end('{}'); }
      if (behaviour === '500') { res.statusCode = 500; return res.end('{"error":{"message":"upstream internal detail LEAK"}}'); }
      if (behaviour === 'badjson') { res.statusCode = 200; return res.end('<<not json>>'); }
      if (behaviour === 'empty') { res.statusCode = 200; return res.end(JSON.stringify({ output: [] })); }

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ output_text: 'Test cevabı: harcamalarını gözden geçir.' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}/v1/responses`,
    received,
    async close() {
      // 'hang' senaryosunda açık bağlantılar kalabilir; zorla kapat.
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/* Basit HTTP istemcisi (fetch, hata gövdesini de okuyabilmemiz için sarıldı). */
export async function req(origin, path, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(origin + path, { method, headers, body });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* JSON değilse null kalır */ }
  return { status: res.status, headers: res.headers, text, json };
}

export const VALID_BODY = JSON.stringify({
  question: 'Bu ay ne yapmalıyım?',
  lang: 'tr',
  contextVersion: 1,
  systemPromptHint: 'Sen FullBudget finans koçusun.',
  context: { monthlyIncome: 50000, monthlyExpenses: 32000, netWorth: 120000 },
  precomputed: { safeDaily: 480 },
});
