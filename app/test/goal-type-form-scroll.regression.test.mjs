// HEDEFLER — hedef türü kartına dokununca formun otomatik görünür alana kaydırılması
// -----------------------------------------------------------------------
// Amaç: Hedef Ekle formunda bir tür kartına (Ev, Araba, Bilgisayar, ...) dokunulunca, altta
// render edilen alanların (#goalFieldsBox) kullanıcıyı elle kaydırmaya zorlamadan, smooth
// şekilde ve sabit alt gezinme çubuğunun altında kalmadan görünür olması. Gerçek Chromium +
// gerçek app/index.html (mevcut testlerle aynı yöntem); hesap/kayıt mantığına dokunulmaz.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..', '..'); // repo kökü (app/ ve app/index.html'i içerir)

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

async function newPage(viewport) {
  const page = await browser.newPage({ viewport: viewport || { width: 1440, height: 900 } });
  const consoleErrors = [];
  page.on('pageerror', (err) => consoleErrors.push(String(err)));
  // 'domcontentloaded' yerine 'load' kullanılmadı: bu sandbox ortamında döviz/altın
  // kuru API'leri ve Google Fonts gibi dış kaynaklara giden istekler egress politikası
  // tarafından reddediliyor ve 'load' olayı hiç tetiklenmeyebiliyor (gerçek CI/production
  // ortamında bu kısıtlama yok). DOM ve script'lerin çalışması için 'domcontentloaded'
  // yeterli ve daha güvenilir.
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(300); // inline script'lerin ilk render'ı tamamlaması için kısa pay
  // Onboarding/auth overlaylerini kapat — AYNI desen ai-coach-priority-plan.regression.test.mjs
  // dosyasındaki newSession() ile (uygulamanın ilk açılış akışı, kopyalanmadı, aynen izlendi).
  for (const [ov, btn] of [['#onboardingOverlay', '#onboardSkipBtn'], ['#authOverlay', '#authGuestBtn']]) {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const shown = await page.evaluate((s) => {
        const e = document.querySelector(s);
        return !!(e && e.classList.contains('show'));
      }, ov).catch(() => false);
      if (shown) {
        const b = await page.$(btn);
        if (b) { await b.click({ force: true }).catch(() => {}); await page.waitForTimeout(300); break; }
        break;
      }
      await page.waitForTimeout(150);
    }
  }
  // Açılış splash ekranı (varsa) kısa bir süre sonra kendiliğinden kalkar; garanti olsun diye
  // gizli olmasını bekle - gerçek uygulama akışına müdahale etmez, yalnızca bekler.
  await page.waitForFunction(() => {
    const s = document.getElementById('splashScreen');
    return !s || getComputedStyle(s).display === 'none' || getComputedStyle(s).visibility === 'hidden' || getComputedStyle(s).opacity === '0';
  }, null, { timeout: 6000 }).catch(() => {});
  return { page, consoleErrors };
}


const MOBILE = { width: 430, height: 700 };
const TYPES = ['ev','araba','bilgisayar','telefon','tatil','motor','egitim','dugun','acilfon','yatirim'];

async function openGoalForm(page) {
  await page.evaluate(() => { setTab('goals'); render(); });
  await page.locator('#showGoalFormBtn').click();
  await page.locator('#goalForm').waitFor({ state: 'visible', timeout: 5000 });
}

// Pencere kaydırması artık durana kadar bekle (smooth scroll bitsin)
async function settle(page) {
  let last = -1, stable = 0;
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && stable < 3) {
    const y = await page.evaluate(() => Math.round(window.scrollY));
    stable = (y === last) ? stable + 1 : 0;
    last = y;
    await page.waitForTimeout(100);
  }
}

// window.scrollTo çağrılarını kaydet (smooth mu, kaç kez)
async function spyScroll(page) {
  await page.evaluate(() => {
    window.__scrollCalls = [];
    const orig = window.scrollTo.bind(window);
    // Yalnızca {top,behavior} biçimli çağrıları say (helper). Uygulamanın mevcut setTab() içindeki
    // window.scrollTo(0,0) çağrısı (sayısal argüman) bu davranışın parçası değil, sayılmaz.
    window.scrollTo = function (a) { if (a && typeof a === 'object') window.__scrollCalls.push(a); return orig.apply(window, arguments); };
  });
}

// Tür kartını ekranın ortasına getirip GERÇEK dokunuşla (hit-test'li) tıkla
async function tapType(page, key) {
  const idx = await page.evaluate((k) => GOAL_TYPES.findIndex(t => t.key === k), key);
  assert.ok(idx >= 0, key + ' GOAL_TYPES içinde olmalı');
  const card = page.locator('#goalTypeGrid .goal-type-btn').nth(idx);
  await card.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(150);
  await card.click();
}

for (const key of TYPES) {
  test(`${key}: karta dokununca form otomatik görünür, alt şerit örtmez, smooth`, async () => {
    const { page, consoleErrors } = await newPage(MOBILE);
    await openGoalForm(page);
    await spyScroll(page);
    await tapType(page, key);
    await settle(page);

    const r = await page.evaluate(() => {
      const box = document.getElementById('goalFieldsBox');
      const first = box.querySelector('input, select, button');
      const fr = first.getBoundingClientRect();
      const nav = document.querySelector('.bottom-nav').getBoundingClientRect();
      const cx = fr.left + fr.width / 2, cy = fr.top + fr.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      return {
        active: activeGoalType,
        activeClass: document.querySelector('#goalTypeGrid .goal-type-btn.active span:last-child').textContent,
        boxTop: box.getBoundingClientRect().top,
        firstTop: fr.top, firstBottom: fr.bottom,
        navTop: nav.top, vh: innerHeight,
        firstHitOk: !!hit && (first === hit || first.contains(hit) || hit.contains(first) || box.contains(hit)),
        maxScroll: document.documentElement.scrollHeight - innerHeight, y: scrollY,
      };
    });
    assert.equal(r.active, key, 'hedef seçimi mevcut sistemdeki gibi yapılmalı');
    assert.ok(r.firstTop >= 0 && r.firstBottom <= r.navTop - 4, `ilk alan görünür alanda ve alt şeridin üstünde olmalı: ${JSON.stringify(r)}`);
    assert.ok(r.firstHitOk, 'ilk alan alt şerit/launcher tarafından örtülmemeli (hit-test)');
    // Kaydırma payı varsa form üstü ~80-120px civarında; pay yoksa (sayfa sonu) en fazla o kadar yukarıda
    if (r.y < r.maxScroll - 2) assert.ok(r.boxTop >= 70 && r.boxTop <= 130, `form üstü ~100px altında olmalı: ${r.boxTop}`);
    const calls = await page.evaluate(() => window.__scrollCalls);
    // 'instant' çağrısı yalnızca uygulamanın ertelenmiş setTab() sıfırlamasını geri alır (konum korunur);
    // asıl form kaydırması smooth olmalı.
    const smooth = calls.filter(c => c.behavior === 'smooth');
    assert.ok(smooth.length >= 1, 'form görünür değilken smooth kaydırma yapılmalı');
    assert.ok(calls.every(c => c.behavior === 'smooth' || c.behavior === 'instant'), 'ani sıçrama yalnızca konum geri yüklemesi olabilir');
    assert.deepEqual(consoleErrors, [], 'sayfa hatası olmamalı');
    await page.close();
  });
}

test('form zaten görünürken (uzun ekran) smooth kaydırma yapılmaz', async () => {
  const { page } = await newPage({ width: 430, height: 2000 });
  await openGoalForm(page);
  await spyScroll(page);
  await tapType(page, 'bilgisayar');
  await settle(page);
  const r = await page.evaluate(() => {
    const first = document.querySelector('#goalFieldsBox input, #goalFieldsBox select');
    const f = first.getBoundingClientRect();
    return { firstVisible: f.top >= 60 && f.bottom <= innerHeight, smooth: window.__scrollCalls.filter(c => c.behavior === 'smooth').length };
  });
  assert.equal(r.firstVisible, true, 'uzun ekranda ilk alan zaten görünür olmalı');
  assert.equal(r.smooth, 0, 'form zaten görünürken smooth kaydırma yapılmamalı');
  // Aynı karta tekrar dokunmak da gereksiz kaydırma yapmaz
  await tapType(page, 'bilgisayar');
  await settle(page);
  assert.equal(await page.evaluate(() => window.__scrollCalls.filter(c => c.behavior === 'smooth').length), 0, 'aynı karta tekrar dokunmak smooth kaydırma yapmamalı');
  await page.close();
});

test('masaüstünde (sol ray) da form görünür ve alt-şerit varsayımı hata vermez', async () => {
  const { page, consoleErrors } = await newPage({ width: 1440, height: 600 });
  await openGoalForm(page);
  await tapType(page, 'ev');
  await settle(page);
  const ok = await page.evaluate(() => {
    const first = document.querySelector('#goalFieldsBox select, #goalFieldsBox input');
    const f = first.getBoundingClientRect();
    return f.top >= 0 && f.bottom <= innerHeight;
  });
  assert.equal(ok, true);
  assert.deepEqual(consoleErrors, []);
  await page.close();
});
