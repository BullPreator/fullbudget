/* =========================================================
   Express'e bağlı entegrasyon testleri.

   server.js'in KENDİSİNİ (express yönlendirmesi, express.static, 404,
   /health, /ai/coach zinciri ve graceful shutdown kablolaması) uçtan uca
   çalıştırır.

   express kurulu DEĞİLSE bu dosyadaki testler atlanır (skip) - çünkü
   express bir üretim bağımlılığıdır ve bazı ortamlarda (offline sandbox)
   npm erişimi olmayabilir. Güvenlik mantığının tamamı zaten
   server.test.mjs içinde express olmadan test ediliyor.

   Çalıştır:  npm install && npm run test:express
   ========================================================= */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';

import { startMockOpenAI, req, VALID_BODY } from './harness.mjs';

const require = createRequire(import.meta.url);

let expressAvailable = true;
try {
  require.resolve('express');
} catch {
  expressAvailable = false;
}

describe('Express entegrasyonu (server.js)', { skip: expressAvailable ? false : 'express kurulu değil — `npm install` sonrası çalışır' }, () => {
  let server;
  let origin;
  let openai;

  before(async () => {
    openai = await startMockOpenAI('ok');

    // server.js yapılandırmayı process.env'den okur.
    process.env.OPENAI_API_KEY = 'test-key-never-logged';
    process.env.OPENAI_BASE_URL = openai.url;
    process.env.CORS_ORIGINS = 'https://fullbudget.app';
    process.env.AI_RATE_LIMIT_MAX = '5';
    process.env.ACCESS_LOG = '0';
    process.env.NODE_ENV = 'development';

    const { createApp, CONFIG } = require('../server.js');
    const app = createApp({
      ...CONFIG,
      port: 0,
      corsOrigins: ['https://fullbudget.app'],
      rateLimit: { windowMs: 60000, max: 5 },
      openai: { apiKey: 'test-key-never-logged', model: 'gpt-5.6-luna', url: openai.url, timeoutMs: 5000 },
    });

    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (openai) await openai.close();
  });

  test('sunucu ayağa kalkar ve /health 200 döner', async () => {
    const r = await req(origin, '/health');
    assert.equal(r.status, 200);
    assert.equal(r.json.status, 'ok');
    assert.ok(!r.text.includes('test-key'), 'anahtar /health yanıtına sızmış');
  });

  test('/ai/coach uçtan uca 200 + sözleşme korunuyor', async () => {
    const r = await req(origin, '/ai/coach', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: VALID_BODY,
    });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json).sort(), ['answer', 'contextVersion']);
  });

  test('güvenlik başlıkları express yanıtlarında da var', async () => {
    const r = await req(origin, '/health');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('x-powered-by'), null, 'X-Powered-By sızıyor');
    assert.ok(r.headers.get('x-request-id'));
  });

  test('bilinmeyen yol 404 + JSON (HTML değil)', async () => {
    const r = await req(origin, '/bilinmeyen-yol');
    assert.equal(r.status, 404);
    assert.ok(r.json, 'JSON hata gövdesi bekleniyordu');
    assert.ok(!/\.js:\d+|at Object|\/home\//.test(r.text), 'stack/yol sızmış');
  });

  test('.env gibi dotfile static üzerinden servis edilmez', async () => {
    const r = await req(origin, '/.env');
    assert.notEqual(r.status, 200);
  });

  test('rate limit express üzerinden de çalışır', async () => {
    const send = () => req(origin, '/ai/coach', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: VALID_BODY,
    });
    let saw429 = false;
    for (let i = 0; i < 10; i++) {
      const r = await send();
      if (r.status === 429) { saw429 = true; break; }
    }
    assert.ok(saw429, 'rate limit devreye girmedi');
  });
});
