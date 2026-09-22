// MİKRO UX/COPY DÜZELTMESİ — piyasa fiyat referansı etiketleri regresyon testleri
// -----------------------------------------------------------------------
// Bu değişiklik SALT kullanıcıya görünen metin: "Piyasa Verileri" bölümündeki "Ev
// Referansları"/"Araba Referansları" başlıkları "Ev Fiyat Referansları"/"Araç Fiyat
// Referansları" oldu, giriş açıklaması netleştirildi, ve Hedefler kartındaki "Bugünkü fiyat"
// satır etiketi "Referans fiyat" oldu. Hiçbir hesap/değer/motor DEĞİŞMEDİ — bu dosya hem kaynak
// metinleri hem de gerçek DOM render çıktısını doğrular. computeGoalInfo()/basePrice/
// inflatedPrice hesapları ASLA mutasyona uğratılmaz — yalnızca DOM ve salt-okunur motor
// çağrılarıyla gözlemlenir.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..', '..');
const appHtmlSource = readFileSync(path.join(appDir, 'app', 'index.html'), 'utf8');

let server, browser, baseUrl;

before(async () => {
  server = http.createServer((req, res) => {
    try {
      let reqPath = decodeURIComponent(req.url.split('?')[0]);
      if (reqPath === '/') reqPath = '/app/index.html';
      const filePath = path.join(appDir, reqPath);
      if (!filePath.startsWith(appDir)) { res.writeHead(403); res.end(); return; }
      const body = readFileSync(filePath);
      const ct = filePath.endsWith('.html') ? 'text/html' : filePath.endsWith('.js') ? 'application/javascript' : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': ct });
      res.end(body);
    } catch (e) {
      res.writeHead(404);
      res.end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}/app/index.html`;
  browser = await chromium.launch({ args: ['--no-sandbox'] });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function newSession(setup) {
  const page = await browser.newPage({ viewport: { width: 430, height: 1600 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  for (const [ov, btn] of [['#onboardingOverlay', '#onboardSkipBtn'], ['#authOverlay', '#authGuestBtn']]) {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const shown = await page.evaluate((s) => {
        const e = document.querySelector(s);
        return !!(e && e.classList.contains('show'));
      }, ov).catch(() => false);
      if (shown) {
        const b = await page.$(btn);
        if (b) { await b.click({ force: true }).catch(() => {}); await page.waitForTimeout(300); break; }
      }
      await page.waitForTimeout(150);
    }
  }
  if (setup) {
    await page.evaluate((s) => {
      persistent.accounts = s.assets ? [{ id: 'a1', name: 'Banka', type: 'Banka Hesabı', balance: s.assets, currency: 'TRY' }] : [];
      month.incomes = s.income > 0 ? [{ id: 'i1', category: 'Maaş', amount: s.income }] : [];
      month.expenses = [];
      persistent.goals = s.goals || [];
      setTab('goals');
      render();
    }, setup);
  }
  return { page, pageErrors };
}

test('MICRO-1: "Piyasa Verileri" category headers are "Ev Fiyat Referansları" / "Araç Fiyat Referansları"', async () => {
  assert.ok(appHtmlSource.includes("'hedef-ev-ref': {tr:'Ev Fiyat Referansları'"), '"hedef-ev-ref" must be "Ev Fiyat Referansları"');
  assert.ok(appHtmlSource.includes("'hedef-araba-ref': {tr:'Araç Fiyat Referansları'"), '"hedef-araba-ref" must be "Araç Fiyat Referansları"');
  assert.ok(!appHtmlSource.includes("tr:'Ev Referansları'"), 'the old "Ev Referansları" label must no longer be used');
  assert.ok(!appHtmlSource.includes("tr:'Araba Referansları'"), 'the old "Araba Referansları" label must no longer be used');
});

test('MICRO-2: the market-reference intro note is clarified without changing the rest of the explanation', async () => {
  const expected = 'Bu değerler yaklaşık piyasa fiyat referanslarıdır. Gerçek fiyat; şehir, model, yaş, konum, özellikler ve piyasa koşullarına göre değişir.';
  assert.ok(appHtmlSource.includes(expected), `the clarified intro sentence must be present, e.g.: "${expected}"`);
  assert.ok(!appHtmlSource.includes('Bu veriler yaklaşık piyasa referansıdır.'), 'the old, less precise intro sentence must no longer appear');
  // the rest of the explanation (own-price option) must remain intact
  assert.ok(appHtmlSource.includes('Kendi fiyatını girmek istersen hedef eklerken "kendi fiyatımı gireceğim" seçeneğini kullan.'), 'the trailing "enter your own price" guidance must remain unchanged');
});

test('MICRO-3: the Goals UI row label is "Referans fiyat" instead of "Bugünkü fiyat", with the underlying value unchanged', async () => {
  const futureDate = new Date(Date.now() + 300 * 86400000).toISOString().slice(0, 10);
  const { page, pageErrors } = await newSession({
    income: 100000,
    goals: [{ id: 'g1', typeKey: 'ev', name: 'Ev', targetAmount: 1000000, targetDate: futureDate }],
  });
  const check = await page.evaluate(() => {
    const info = computeGoalInfo(persistent.goals[0]);
    return {
      basePrice: info.basePrice,
      formattedBasePrice: fmt(info.basePrice),
      goalListHtml: document.getElementById('goalList').innerHTML,
    };
  });
  await page.close();
  assert.ok(check.basePrice > 0, 'sanity: basePrice must be computed for this fixture');
  assert.ok(check.goalListHtml.includes('Referans fiyat'), 'the goal card must show the "Referans fiyat" label');
  assert.ok(!check.goalListHtml.includes('Bugünkü fiyat'), 'the old "Bugünkü fiyat" label must no longer appear in the goal card');
  assert.ok(check.goalListHtml.includes(check.formattedBasePrice), `the displayed value must still reflect the unchanged basePrice calculation (expected to find "${check.formattedBasePrice}")`);
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('MICRO-4: "Piyasa Verileri" section renders the renamed category headers in the live DOM', async () => {
  const { page, pageErrors } = await newSession({ income: 100000, goals: [] });
  const check = await page.evaluate(() => {
    renderMarketRefList();
    return document.getElementById('marketRefList').innerHTML;
  });
  await page.close();
  assert.ok(check.includes('Ev Fiyat Referansları'), 'the rendered market-reference list must show "Ev Fiyat Referansları"');
  assert.ok(check.includes('Araç Fiyat Referansları'), 'the rendered market-reference list must show "Araç Fiyat Referansları"');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});
