/* =========================================================
   P0-A1 backend hardening testleri (A–L)
   Çalıştır:  npm test     (node --test test/)
   Gerçek OpenAI'a HİÇBİR istek gitmez; sahte bir yerel sunucu kullanılır.
   ========================================================= */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import {
  startTestServer, startMockOpenAI, req, VALID_BODY, runMiddleware, makeLogger,
} from './harness.mjs';

const require = createRequire(import.meta.url);
const sec = require('../security.js');

/* =========================================================
   A. Geçerli /ai/coach isteği — yanıt sözleşmesi korunuyor mu?
   ========================================================= */
describe('A. valid /ai/coach request', () => {
  test('200 döner ve gövde tam olarak {answer, contextVersion} sözleşmesine uyar', async () => {
    const openai = await startMockOpenAI('ok');
    const srv = await startTestServer({ openaiUrl: openai.url });
    try {
      const r = await req(srv.origin, '/ai/coach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: VALID_BODY,
      });

      assert.equal(r.status, 200);
      assert.equal(typeof r.json.answer, 'string');
      assert.ok(r.json.answer.length > 0);
      assert.equal(r.json.contextVersion, 1);

      // REGRESYON: frontend yalnızca bu iki alanı bekliyor - fazlası da olmamalı.
      assert.deepEqual(Object.keys(r.json).sort(), ['answer', 'contextVersion']);
    } finally { await srv.close(); await openai.close(); }
  });

  test('contextVersion sayı değilse null döner (eski davranış)', async () => {
    const openai = await startMockOpenAI('ok');
    const srv = await startTestServer({ openaiUrl: openai.url });
    try {
      const body = JSON.parse(VALID_BODY);
      delete body.contextVersion;
      const r = await req(srv.origin, '/ai/coach', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      assert.equal(r.status, 200);
      assert.equal(r.json.contextVersion, null);
    } finally { await srv.close(); await openai.close(); }
  });

  test('API anahtarı OpenAI dışına sızmaz ve yanıtta görünmez', async () => {
    const openai = await startMockOpenAI('ok');
    const srv = await startTestServer({ openaiUrl: openai.url, apiKey: 'sk-SECRET-DO-NOT-LEAK' });
    try {
      const r = await req(srv.origin, '/ai/coach', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: VALID_BODY,
      });
      assert.equal(r.status, 200);
      assert.ok(!r.text.includes('SECRET'));
      // Anahtar yalnızca upstream Authorization başlığında olmalı.
      assert.equal(openai.received[0].headers.authorization, 'Bearer sk-SECRET-DO-NOT-LEAK');
      // Loglarda anahtar YOK.
      assert.ok(!srv.logger.lines.join('\n').includes('SECRET'));
    } finally { await srv.close(); await openai.close(); }
  });

  test('finansal context ve soru metni LOGLANMAZ', async () => {
    const openai = await startMockOpenAI('ok');
    const srv = await startTestServer({ openaiUrl: openai.url });
    try {
      await req(srv.origin, '/ai/coach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: 'GIZLI_SORU_METNI',
          context: { netWorth: 987654321 },
        }),
      });
      const logs = srv.logger.lines.join('\n');
      assert.ok(!logs.includes('GIZLI_SORU_METNI'), 'soru metni loglanmış');
      assert.ok(!logs.includes('987654321'), 'finansal değer loglanmış');
    } finally { await srv.close(); await openai.close(); }
  });
});

/* =========================================================
   B. question eksik
   ========================================================= */
describe('B. missing question', () => {
  test('question yoksa 400 + JSON hata', async () => {
    const srv = await startTestServer();
    try {
      const r = await req(srv.origin, '/ai/coach', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: { a: 1 } }),
      });
      assert.equal(r.status, 400);
      assert.equal(r.json.error, 'Soru boş olamaz.');
      assert.ok(r.json.requestId);
    } finally { await srv.close(); }
  });

  test('question yalnızca boşluksa 400', async () => {
    const srv = await startTestServer();
    try {
      const r = await req(srv.origin, '/ai/coach', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: '   ', context: { a: 1 } }),
      });
      assert.equal(r.status, 400);
    } finally { await srv.close(); }
  });

  test('context eksikse 400', async () => {
    const srv = await startTestServer();
    try {
      const r = await req(srv.origin, '/ai/coach', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'merhaba' }),
      });
      assert.equal(r.status, 400);
      assert.match(r.json.error, /context/i);
    } finally { await srv.close(); }
  });

  test('context dizi ise reddedilir (beklenen format dışı)', async () => {
    const srv = await startTestServer();
    try {
      const r = await req(srv.origin, '/ai/coach', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'merhaba', context: [1, 2, 3] }),
      });
      assert.equal(r.status, 400);
    } finally { await srv.close(); }
  });

  test('aşırı derin context reddedilir', async () => {
    const srv = await startTestServer();
    try {
      let deep = { v: 1 };
      for (let i = 0; i < 40; i++) deep = { n: deep };
      const r = await req(srv.origin, '/ai/coach', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'merhaba', context: deep }),
      });
      assert.equal(r.status, 400);
    } finally { await srv.close(); }
  });
});

/* =========================================================
   C. question > 500 karakter
   ========================================================= */
describe('C. question too long', () => {
  test('501 karakter reddedilir', async () => {
    const srv = await startTestServer();
    try {
      const r = await req(srv.origin, '/ai/coach', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'a'.repeat(501), context: { a: 1 } }),
      });
      assert.equal(r.status, 400);
      assert.match(r.json.error, /500 karakter/);
    } finally { await srv.close(); }
  });

  test('tam 500 karakter KABUL edilir (sınır regresyonu)', async () => {
    const openai = await startMockOpenAI('ok');
    const srv = await startTestServer({ openaiUrl: openai.url });
    try {
      const r = await req(srv.origin, '/ai/coach', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'a'.repeat(500), context: { a: 1 } }),
      });
      assert.equal(r.status, 200);
    } finally { await srv.close(); await openai.close(); }
  });
});

/* =========================================================
   D. Bozuk JSON
   ========================================================= */
describe('D. invalid JSON', () => {
  test('bozuk JSON 400 + JSON gövdesi döner (HTML değil)', async () => {
    const srv = await startTestServer();
    try {
      const r = await req(srv.origin, '/ai/coach', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: '{ "question": "merhaba", ',
      });
      assert.equal(r.status, 400);
      assert.ok(r.json, 'yanıt JSON olmalı');
      assert.ok(!r.text.includes('<'), 'HTML hata sayfası dönmemeli');
      assert.ok(!/SyntaxError|at Object|\.js:\d+/.test(r.text), 'stack trace sızmış');
    } finally { await srv.close(); }
  });

  test('boş gövde 400', async () => {
    const srv = await startTestServer();
    try {
      const r = await req(srv.origin, '/ai/coach', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '',
      });
      assert.equal(r.status, 400);
    } finally { await srv.close(); }
  });

  test('JSON dizisi gövdesi 400', async () => {
    const srv = await startTestServer();
    try {
      const r = await req(srv.origin, '/ai/coach', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '[1,2,3]',
      });
      assert.equal(r.status, 400);
    } finally { await srv.close(); }
  });

  test('yanlış Content-Type 415', async () => {
    const srv = await startTestServer();
    try {
      const r = await req(srv.origin, '/ai/coach', {
        method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'merhaba',
      });
      assert.equal(r.status, 415);
    } finally { await srv.close(); }
  });

  test('POST dışı metot 405 + Allow başlığı', async () => {
    const srv = await startTestServer();
    try {
      const r = await req(srv.origin, '/ai/coach', { method: 'PUT' });
      assert.equal(r.status, 405);
      assert.equal(r.headers.get('allow'), 'POST, OPTIONS');
    } finally { await srv.close(); }
  });
});

/* =========================================================
   E. Aşırı büyük gövde (512 KB limiti)
   ========================================================= */
describe('E. oversized body', () => {
  test('512 KB üzeri gövde 413 ile reddedilir', async () => {
    const srv = await startTestServer();
    try {
      const big = JSON.stringify({
        question: 'merhaba',
        context: { blob: 'x'.repeat(600 * 1024) },
      });
      assert.ok(big.length > sec.BODY_LIMIT_BYTES);
      const r = await req(srv.origin, '/ai/coach', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: big,
      });
      assert.equal(r.status, 413);
    } finally { await srv.close(); }
  });

  test('Content-Length yalan söylese bile akış sırasında kesilir', async () => {
    const srv = await startTestServer();
    try {
      // chunked gönderim: Content-Length yok, limit akışta yakalanmalı.
      const stream = new ReadableStream({
        start(controller) {
          const chunk = new TextEncoder().encode('x'.repeat(64 * 1024));
          for (let i = 0; i < 12; i++) controller.enqueue(chunk);
          controller.close();
        },
      });
      let status = 0;
      try {
        const res = await fetch(srv.origin + '/ai/coach', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: stream,
          duplex: 'half',
        });
        status = res.status;
      } catch {
        // Sunucu bağlantıyı kestiyse fetch hata verebilir - bu da kabul edilebilir
        // bir "reddedildi" sinyalidir.
        status = 413;
      }
      assert.equal(status, 413);
    } finally { await srv.close(); }
  });

  test('limitin hemen altındaki gövde kabul edilir', async () => {
    const openai = await startMockOpenAI('ok');
    const srv = await startTestServer({ openaiUrl: openai.url });
    try {
      const body = JSON.stringify({ question: 'merhaba', context: { blob: 'x'.repeat(400 * 1024) } });
      assert.ok(body.length < sec.BODY_LIMIT_BYTES);
      const r = await req(srv.origin, '/ai/coach', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
      });
      assert.equal(r.status, 200);
    } finally { await srv.close(); await openai.close(); }
  });
});

/* =========================================================
   F. Rate limit
   ========================================================= */
describe('F. rate limit', () => {
  test('limit aşılınca 429 + Retry-After + RateLimit başlıkları', async () => {
    const openai = await startMockOpenAI('ok');
    const srv = await startTestServer({ openaiUrl: openai.url, rateLimitMax: 3 });
    try {
      const send = () => req(srv.origin, '/ai/coach', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: VALID_BODY,
      });

      const r1 = await send();
      assert.equal(r1.status, 200);
      assert.equal(r1.headers.get('x-ratelimit-limit'), '3');
      assert.equal(r1.headers.get('x-ratelimit-remaining'), '2');
      assert.match(r1.headers.get('ratelimit'), /limit=3, remaining=2, reset=\d+/);
      assert.equal(r1.headers.get('ratelimit-policy'), '3;w=60');

      assert.equal((await send()).status, 200);
      assert.equal((await send()).status, 200);

      const r4 = await send();
      assert.equal(r4.status, 429);
      assert.equal(r4.headers.get('x-ratelimit-remaining'), '0');
      assert.ok(Number(r4.headers.get('retry-after')) > 0);
      assert.match(r4.json.error, /çok fazla istek/i);
    } finally { await srv.close(); await openai.close(); }
  });

  test('pencere dolunca sayaç sıfırlanır', async () => {
    const openai = await startMockOpenAI('ok');
    const srv = await startTestServer({ openaiUrl: openai.url, rateLimitMax: 1, rateLimitWindowMs: 300 });
    try {
      const send = () => req(srv.origin, '/ai/coach', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: VALID_BODY,
      });
      assert.equal((await send()).status, 200);
      assert.equal((await send()).status, 429);
      await new Promise((r) => setTimeout(r, 350));
      assert.equal((await send()).status, 200);
    } finally { await srv.close(); await openai.close(); }
  });

  test('rate limit gövde okunmadan ÖNCE devreye girer (ucuz reddetme)', async () => {
    const srv = await startTestServer({ rateLimitMax: 1 });
    try {
      await req(srv.origin, '/ai/coach', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"question":"a","context":{}}',
      });
      // İkinci istekte gövde tamamen geçersiz olsa bile 429 dönmeli (400 değil).
      const r = await req(srv.origin, '/ai/coach', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'BOZUK',
      });
      assert.equal(r.status, 429);
    } finally { await srv.close(); }
  });
});

/* =========================================================
   G/H. CORS
   ========================================================= */
describe('G/H. CORS', () => {
  test('G. izinsiz origin: preflight 403 ve CORS başlığı YOK', async () => {
    const srv = await startTestServer({ corsOrigins: ['https://fullbudget.app'] });
    try {
      const pre = await req(srv.origin, '/ai/coach', {
        method: 'OPTIONS',
        headers: { Origin: 'https://kotu-site.example', 'Access-Control-Request-Method': 'POST' },
      });
      assert.equal(pre.status, 403);
      assert.equal(pre.headers.get('access-control-allow-origin'), null);

      const post = await req(srv.origin, '/ai/coach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://kotu-site.example' },
        body: VALID_BODY,
      });
      assert.equal(post.status, 403);
      assert.equal(post.headers.get('access-control-allow-origin'), null);
    } finally { await srv.close(); }
  });

  test('H. izinli origin: preflight 204 ve doğru başlıklar', async () => {
    const openai = await startMockOpenAI('ok');
    const srv = await startTestServer({
      corsOrigins: ['https://fullbudget.app', 'https://www.fullbudget.app'],
      corsCredentials: true,
      openaiUrl: openai.url,
    });
    try {
      const pre = await req(srv.origin, '/ai/coach', {
        method: 'OPTIONS',
        headers: { Origin: 'https://fullbudget.app', 'Access-Control-Request-Method': 'POST' },
      });
      assert.equal(pre.status, 204);
      assert.equal(pre.headers.get('access-control-allow-origin'), 'https://fullbudget.app');
      assert.equal(pre.headers.get('access-control-allow-credentials'), 'true');
      assert.equal(pre.headers.get('vary'), 'Origin');
      // ASLA wildcard
      assert.notEqual(pre.headers.get('access-control-allow-origin'), '*');

      const post = await req(srv.origin, '/ai/coach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://www.fullbudget.app' },
        body: VALID_BODY,
      });
      assert.equal(post.status, 200);
      assert.equal(post.headers.get('access-control-allow-origin'), 'https://www.fullbudget.app');
    } finally { await srv.close(); await openai.close(); }
  });

  test('Origin başlığı yoksa (same-origin) istek normal çalışır', async () => {
    const openai = await startMockOpenAI('ok');
    const srv = await startTestServer({ corsOrigins: [], openaiUrl: openai.url });
    try {
      const r = await req(srv.origin, '/ai/coach', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: VALID_BODY,
      });
      assert.equal(r.status, 200);
    } finally { await srv.close(); await openai.close(); }
  });
});

/* =========================================================
   I. OpenAI hataları
   ========================================================= */
describe('I. OpenAI errors', () => {
  const cases = [
    ['429', 429, /çok fazla istek/i],
    ['401', 500, /kullanılamıyor/i],
    ['500', 502, /cevap veremiyor/i],
    ['badjson', 502, /beklenmedik/i],
    ['empty', 502, /geçerli bir cevap/i],
  ];

  for (const [behaviour, expectStatus, expectMsg] of cases) {
    test(`upstream ${behaviour} → ${expectStatus}, iç detay sızmaz`, async () => {
      const openai = await startMockOpenAI(behaviour);
      const srv = await startTestServer({ openaiUrl: openai.url });
      try {
        const r = await req(srv.origin, '/ai/coach', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: VALID_BODY,
        });
        assert.equal(r.status, expectStatus);
        assert.match(r.json.error, expectMsg);
        assert.ok(!r.text.includes('LEAK'), 'upstream hata detayı sızmış');
        assert.ok(!/\.js:\d+|at Object|node_modules|\/home\//.test(r.text), 'stack/dosya yolu sızmış');
      } finally { await srv.close(); await openai.close(); }
    });
  }

  test('OPENAI_API_KEY yoksa 500 + genel mesaj', async () => {
    const srv = await startTestServer({ apiKey: undefined });
    try {
      const r = await req(srv.origin, '/ai/coach', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: VALID_BODY,
      });
      assert.equal(r.status, 500);
      assert.equal(r.json.error, 'AI Coach şu anda kullanılamıyor.');
    } finally { await srv.close(); }
  });
});

/* =========================================================
   J. Timeout
   ========================================================= */
describe('J. timeout', () => {
  test('upstream cevap vermezse zaman aşımına düşer, istemci asılı kalmaz', async () => {
    const openai = await startMockOpenAI('hang');
    const srv = await startTestServer({ openaiUrl: openai.url, openaiTimeoutMs: 400 });
    try {
      const started = Date.now();
      const r = await req(srv.origin, '/ai/coach', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: VALID_BODY,
      });
      const elapsed = Date.now() - started;
      assert.equal(r.status, 504);
      assert.match(r.json.error, /cevap veremiyor/i);
      assert.ok(elapsed < 3000, `çok uzun sürdü: ${elapsed}ms`);
      assert.ok(srv.logger.lines.join('\n').includes('openai_timeout'));
    } finally { await srv.close(); await openai.close(); }
  });

  test('upstream erişilemezse 504 (ağ hatası)', async () => {
    // Kapalı bir porta yönlendir.
    const srv = await startTestServer({ openaiUrl: 'http://127.0.0.1:1/v1/responses', openaiTimeoutMs: 2000 });
    try {
      const r = await req(srv.origin, '/ai/coach', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: VALID_BODY,
      });
      assert.equal(r.status, 504);
    } finally { await srv.close(); }
  });
});

/* =========================================================
   K. /health
   ========================================================= */
describe('K. health endpoint', () => {
  test('200 + sade bilgi, anahtarın DEĞERİ yok', async () => {
    const srv = await startTestServer({ apiKey: 'sk-SECRET-DO-NOT-LEAK' });
    try {
      const r = await req(srv.origin, '/health');
      assert.equal(r.status, 200);
      assert.equal(r.json.status, 'ok');
      assert.ok(r.json.timestamp);
      assert.equal(r.json.openaiConfigured, true);
      assert.ok(!r.text.includes('SECRET'), 'anahtar /health yanıtına sızmış');
      assert.ok(!r.text.includes('sk-'), 'anahtar biçimi /health yanıtına sızmış');
    } finally { await srv.close(); }
  });

  test('rate limit UYGULANMAZ', async () => {
    const srv = await startTestServer({ rateLimitMax: 2 });
    try {
      for (let i = 0; i < 25; i++) {
        const r = await req(srv.origin, '/health');
        assert.equal(r.status, 200, `${i}. istekte health limitlenmiş`);
      }
    } finally { await srv.close(); }
  });
});

/* =========================================================
   L. Graceful shutdown
   ========================================================= */
describe('L. graceful shutdown', () => {
  test('SIGTERM sonrası devam eden istek tamamlanır, sunucu kapanır', async () => {
    const http = await import('node:http');
    const { attachGracefulShutdown } = require('../shutdown.js');

    let releaseSlowRequest;
    const slow = new Promise((r) => { releaseSlowRequest = r; });

    const server = http.createServer((req2, res2) => {
      if (req2.url === '/slow') {
        slow.then(() => { res2.statusCode = 200; res2.end('done'); });
        return;
      }
      res2.statusCode = 200; res2.end('ok');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    let closedErr = 'not-called';
    const shutdown = attachGracefulShutdown(server, {
      timeoutMs: 5000,
      logger: makeLogger(),
      onClosed: (err) => { closedErr = err || null; },
      // Test süreci gerçek SIGTERM almasın.
      signals: [],
    });

    // Yavaş isteği başlat
    const inflight = fetch(`http://127.0.0.1:${port}/slow`);
    await new Promise((r) => setTimeout(r, 50));

    // Kapanışı tetikle
    shutdown('SIGTERM');

    // Devam eden istek HÂLÂ tamamlanmalı
    releaseSlowRequest();
    const res = await inflight;
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'done');

    // Sunucu kapanmış olmalı
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(closedErr, null, 'server.close() temiz bitmeliydi');

    // Yeni bağlantı artık reddedilmeli
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
  });
});

/* =========================================================
   Ek: güvenlik başlıkları + request id
   ========================================================= */
describe('Güvenlik başlıkları ve request id', () => {
  test('temel başlıklar her yanıtta var', async () => {
    const srv = await startTestServer();
    try {
      const r = await req(srv.origin, '/health');
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(r.headers.get('x-frame-options'), 'DENY');
      assert.equal(r.headers.get('content-security-policy'), "frame-ancestors 'none'");
      assert.equal(r.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
      assert.equal(r.headers.get('x-permitted-cross-domain-policies'), 'none');
      assert.ok(r.headers.get('permissions-policy'));
      assert.equal(r.headers.get('x-powered-by'), null);
    } finally { await srv.close(); }
  });

  test('HSTS yerel http geliştirmede GÖNDERİLMEZ', async () => {
    const srv = await startTestServer({ production: false });
    try {
      const r = await req(srv.origin, '/health');
      assert.equal(r.headers.get('strict-transport-security'), null);
    } finally { await srv.close(); }
  });

  test('HSTS production + http (TLS yok) olsa bile GÖNDERİLMEZ', async () => {
    const srv = await startTestServer({ production: true, trustProxy: false });
    try {
      const r = await req(srv.origin, '/health');
      assert.equal(r.headers.get('strict-transport-security'), null);
    } finally { await srv.close(); }
  });

  test('HSTS production + proxy https başlığı ile GÖNDERİLİR', async () => {
    const srv = await startTestServer({ production: true, trustProxy: true });
    try {
      const r = await req(srv.origin, '/health', { headers: { 'X-Forwarded-Proto': 'https' } });
      assert.match(r.headers.get('strict-transport-security'), /max-age=\d+; includeSubDomains/);
    } finally { await srv.close(); }
  });

  test('her yanıtta X-Request-Id var ve istekler arası farklı', async () => {
    const srv = await startTestServer();
    try {
      const a = await req(srv.origin, '/health');
      const b = await req(srv.origin, '/health');
      assert.ok(a.headers.get('x-request-id'));
      assert.notEqual(a.headers.get('x-request-id'), b.headers.get('x-request-id'));
    } finally { await srv.close(); }
  });

  test('istemcinin geçerli X-Request-Id değeri korunur, bozuk olan reddedilir', async () => {
    const srv = await startTestServer();
    try {
      const good = await req(srv.origin, '/health', { headers: { 'X-Request-Id': 'abc123def456' } });
      assert.equal(good.headers.get('x-request-id'), 'abc123def456');

      // Boşluk/noktalama içeren ya da aşırı uzun değer reddedilir; kendi
      // UUID'imiz üretilir (log satırına enjeksiyon yapılamasın).
      const bad = await req(srv.origin, '/health', { headers: { 'X-Request-Id': 'bad value; drop" x' } });
      assert.notEqual(bad.headers.get('x-request-id'), 'bad value; drop" x');
      assert.match(bad.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);

      const tooShort = await req(srv.origin, '/health', { headers: { 'X-Request-Id': 'abc' } });
      assert.match(tooShort.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
    } finally { await srv.close(); }
  });

  test('hata logu yalnızca güvenli alanları içerir', async () => {
    const srv = await startTestServer();
    try {
      await req(srv.origin, '/ai/coach', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'SIZMAMALI', context: 'yanlış-tip' }),
      });
      const line = srv.logger.lines.find((l) => l.includes('context_invalid'));
      assert.ok(line, 'hata loglanmadı');
      const parsed = JSON.parse(line);
      assert.deepEqual(
        Object.keys(parsed).sort(),
        ['durationMs', 'endpoint', 'method', 'requestId', 'status', 'type'],
      );
      assert.ok(!line.includes('SIZMAMALI'));
    } finally { await srv.close(); }
  });
});

/* =========================================================
   Ek: auth sınırı gerçekten BOŞ mu?
   Sahte bir kimlik doğrulaması eklenmediğini kanıtlar.
   ========================================================= */
describe('Auth sınırı', () => {
  test('requireAuthenticatedUser isteği geçirir ve req.user null bırakır', () => {
    const req2 = {};
    let called = false;
    sec.requireAuthenticatedUser(req2, {}, () => { called = true; });
    assert.equal(called, true);
    assert.equal(req2.user, null, 'sahte bir kullanıcı üretilmiş!');
    assert.equal(req2.authMode, 'anonymous');
  });

  test('kodda sabit token / sahte JWT yok', async () => {
    const fs = await import('node:fs/promises');
    for (const f of ['../security.js', '../coach.js', '../server.js']) {
      const src = await fs.readFile(new URL(f, import.meta.url), 'utf8');
      assert.ok(!/eyJ[A-Za-z0-9_-]{10,}/.test(src), `${f} içinde gömülü JWT var`);
      assert.ok(!/sk-[A-Za-z0-9]{20,}/.test(src), `${f} içinde gömülü API anahtarı var`);
    }
  });
});
