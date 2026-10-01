/* Web Share Target regression testleri.
   Gerçek Chromium + gerçek service worker (localhost = güvenli bağlam). Sunucu, GitHub Pages'i taklit eder:
   - /fullbudget/ alt yolunda (subpath) VE /app/ altında servis eder,
   - POST isteklerine 405 döner (statik barındırma POST bilmez): yanıt 303 ise bunu SW üretmiştir. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..', '..');
const appDir = path.join(repoRoot, 'app');

let server, browser, port;
const swSuffix = { v: '' };           // sw.js baytlarını değiştirip yeni SW kurulumunu (activate temizliğini) tetiklemek için
const log405 = [];                    // sunucuya ulaşan POST'lar (SW yakalamadıysa buraya düşer)

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

before(async () => {
  server = http.createServer((req, res) => {
    try {
      if (req.method !== 'GET') { log405.push(req.method + ' ' + req.url); res.writeHead(405); res.end('method not allowed'); return; }
      let p = decodeURIComponent(req.url.split('?')[0]);
      let file;
      if (p.startsWith('/fullbudget/')) file = path.join(appDir, p.slice('/fullbudget/'.length));
      else if (p.startsWith('/app/')) file = path.join(repoRoot, p);
      else { res.writeHead(404); res.end('nf'); return; }
      if (file.endsWith(path.sep) || p.endsWith('/')) file = path.join(file, 'index.html');
      if (!file.startsWith(appDir) || !existsSync(file)) { res.writeHead(404); res.end('nf'); return; }
      let body = readFileSync(file);
      if (file.endsWith('sw.js') && swSuffix.v) body = Buffer.concat([body, Buffer.from('\n// ' + swSuffix.v)]);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(body);
    } catch (e) { res.writeHead(500); res.end(String(e)); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  browser = await chromium.launch({ args: ['--no-sandbox'] });
});
after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise((r) => server.close(r));
});

const SUB = () => `http://localhost:${port}/fullbudget/`;
const DIRECT = () => `http://localhost:${port}/app/`;

const CSV = 'Tarih,Açıklama,Tutar\n05.09.2026,MIGROS ISTANBUL,"125,40"\n06.09.2026,SHELL AKARYAKIT,"850,00"\n07.09.2026,NETFLIX.COM,"199,99"\n';
const PDF_BYTES = '%PDF-1.4\n% stub\n';
const PDF_LINES = ['05.09.2026 MIGROS ISTANBUL 125,40', '06.09.2026 SHELL AKARYAKIT 850,00'];

/* pdf.js CDN'i (internet gerektirir) gerçek bir PDF yerine bu kod ile taklit edilir: PDF'in kendisini ayrıştıran
   mevcut extractPdfLines/buildDraftsFromPdfLines AYNEN çalışır, yalnızca metin öğeleri sahte kütüphaneden gelir. */
const PDFJS_STUB = `window.pdfjsLib={GlobalWorkerOptions:{},getDocument:function(){return {promise:Promise.resolve({numPages:1,getPage:function(){return Promise.resolve({getTextContent:function(){return Promise.resolve({items:${JSON.stringify(PDF_LINES.map((s, i) => ({ str: s, transform: [1, 0, 0, 1, 0, 700 - i * 20] })))}})}})}})}}};`;

async function open(base, { seed = true, query = '' } = {}) {
  const context = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(base + query, { waitUntil: 'load', timeout: 30000 });
  await dismissOverlays(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((res) => { navigator.serviceWorker.addEventListener('controllerchange', res); setTimeout(res, 6000); });
    }
  });
  if (seed) {
    await page.evaluate(() => {
      persistent.creditCards = [{ id: 'c1', name: 'Test Kart', currentBalance: 1000, limit: 50000, currency: 'TRY', minPayment: 100, statementDay: 1, dueDay: 10 }];
      persist();
    });
    // Uygulama kart kaydını açılışta normalize eder (varsayılan alanlar ekler): taban çizgisi normalize hâl olsun.
    await page.reload({ waitUntil: 'load' });
    await dismissOverlays(page);
  }
  return { context, page, pageErrors };
}
/* pdf.js CDN taklidi YALNIZCA PDF testinde kurulur (route kurulumu SW'nin POST yakalamasını etkilemesin). */
async function stubPdfJs(page) {
  await page.route(/pdf\.min\.js/, (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: PDFJS_STUB }));
}
async function dismissOverlays(page) {
  for (const [ov, btn] of [['#onboardingOverlay', '#onboardSkipBtn'], ['#authOverlay', '#authGuestBtn']]) {
    const dl = Date.now() + 5000;
    while (Date.now() < dl) {
      const shown = await page.evaluate((s) => { const e = document.querySelector(s); return !!(e && e.classList.contains('show')); }, ov).catch(() => false);
      if (shown) { const b = await page.$(btn); if (b) { await b.click({ force: true }).catch(() => {}); await page.waitForTimeout(300); break; } }
      await page.waitForTimeout(120);
    }
  }
}

/* Gerçek bir Share Target gönderimi: tarayıcı multipart POST yapar, SW yakalar, 303 ile ./?shared=… adresine gider. */
async function share(page, base, file /* {name,type,text}|null|'none' */) {
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'load', timeout: 20000 }),
    page.evaluate(({ action, file }) => {
      const form = document.createElement('form');
      form.method = 'POST'; form.action = action; form.enctype = 'multipart/form-data';
      const input = document.createElement('input');
      input.type = 'file'; input.name = 'file';
      if (file !== 'none') {
        if (file) {
          const dt = new DataTransfer();
          dt.items.add(new File([file.text], file.name, { type: file.type }));
          input.files = dt.files;
        }
        form.appendChild(input);                  // file===null → dosya seçilmemiş alan (boş parça)
      } else {
        const other = document.createElement('input'); other.name = 'baska'; other.value = 'x'; form.appendChild(other);
      }
      document.body.appendChild(form);
      form.submit();
    }, { action: base + 'share-target', file }),
  ]);
  await dismissOverlays(arguments[0]);
}
async function dialog(page) {
  await page.waitForSelector('#customConfirmModal.acik', { timeout: 8000 });
  return page.evaluate(() => ({
    text: document.getElementById('customConfirmMsg').textContent,
    ok: document.getElementById('customConfirmOkBtn').textContent,
    cancel: document.getElementById('customConfirmCancelBtn').textContent,
    cancelHidden: getComputedStyle(document.getElementById('customConfirmCancelBtn')).display === 'none',
  }));
}
/* Kullanıcı verisi parmak izi: bütçe (gelir/gider), hesaplar, kartlar, borçlar, hedefler, varlıklar, içe aktarılan
   işlem kayıtları (mükerrer korumanın dayanağı). Uygulamanın kendi açılış zaman damgaları bilerek hariç. */
const snapshot = (page) => page.evaluate(() => JSON.stringify({
  inc: month.incomes, exp: month.expenses, acc: persistent.accounts, cards: persistent.creditCards, debts: persistent.debts,
  goals: persistent.goals, assets: persistent.assets, imported: persistent.importedTransactions, cardPay: persistent.cardPaymentLog,
}));

const SUMMARY_CSV = { name: 'ekstre.csv', type: 'text/csv', text: CSV };

/* ---------- Statik sözleşme: manifest + SW kaynağı ---------- */
test('manifest: share_target relative ./share-target, POST multipart, yalnızca istenen türler', () => {
  const m = JSON.parse(readFileSync(path.join(appDir, 'manifest.json'), 'utf8'));
  assert.equal(m.share_target.action, './share-target', 'mutlak /share-target OLMAMALI');
  assert.equal(m.share_target.method, 'POST');
  assert.equal(m.share_target.enctype, 'multipart/form-data');
  assert.deepEqual(m.share_target.params.files, [{ name: 'file', accept: ['application/pdf', 'text/csv', '.csv', '.xlsx', '.xls'] }]);
  assert.ok(!JSON.stringify(m).includes('octet-stream'), 'application/octet-stream başlangıçta eklenmemeli');
  assert.equal(m.scope, './');
});

test('sw.js: mutlak /share-target yok; shared-files temizlikten muaf; fetch yalnızca minimum müdahale', () => {
  const swRaw = readFileSync(path.join(appDir, 'sw.js'), 'utf8');
  const sw = swRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');   // yorumları at: yalnızca KOD denetlenir
  // tek meşru kullanım: istek yolunun SONUNU denetleyen endsWith('/share-target'); yönlendirme/anahtar mutlak yol kullanmaz
  assert.ok(!/['"`]\/share-target/.test(sw.replace("endsWith('/share-target')", '')), 'SW kodunda mutlak /share-target kullanılmamalı');
  assert.ok(!/Response\.redirect\(\s*['"`]\//.test(sw), 'yönlendirme mutlak yol olmamalı');
  assert.match(sw, /'\.\/\?shared=1'/);
  assert.match(sw, /'\.\/\?shared=error'/);
  assert.match(sw, /redirect\([^)]*303\)/);
  assert.match(sw, /const SHARED_CACHE = 'shared-files'/);
  assert.match(sw, /k !== CACHE_VERSION && k !== SHARED_CACHE/);
  // Mevcut davranışlar yerinde: navigate network-first, statik cache-first/SWR, çapraz köken karışma yok
  assert.match(sw, /req\.mode === 'navigate'/);
  assert.match(sw, /caches\.match\(req\)\.then\(\(cached\)/);
  assert.match(sw, /if \(req\.method !== 'GET'\) return;/);
  const m = sw.match(/CACHE_VERSION = 'fullbudget-v(\d+)'/);
  assert.ok(m && +m[1] >= 15, 'CACHE_VERSION artırılmış olmalı');
});

/* ---------- SW seviyesi: depolama + yönlendirme ---------- */
test('SW: geçerli dosya → shared-files/latest (MIME + X-Name korunur) ve ./?shared=1', async () => {
  const { context, page, pageErrors } = await open(SUB());
  const out = await page.evaluate(async (action) => {
    const fd = new FormData();
    fd.append('file', new File([new Uint8Array([37, 80, 68, 70, 45, 49])], 'Ekstre Ağustos İ.pdf', { type: 'application/pdf' }));
    const res = await fetch(action, { method: 'POST', body: fd });          // redirect: follow
    const cache = await caches.open('shared-files');
    const keys = (await cache.keys()).map((r) => r.url);
    const hit = await cache.match(keys[0]);
    return { finalUrl: res.url, redirected: res.redirected, keys, type: hit.headers.get('Content-Type'),
      name: decodeURIComponent(hit.headers.get('X-Name')), bytes: Array.from(new Uint8Array(await hit.arrayBuffer())) };
  }, SUB() + 'share-target');
  assert.equal(new URL(out.finalUrl).pathname, '/fullbudget/');
  assert.equal(new URL(out.finalUrl).search, '?shared=1');
  assert.deepEqual(out.keys, [`http://localhost:${port}/fullbudget/latest`], 'anahtar SW kapsamına (alt yol) göre');
  assert.equal(out.type, 'application/pdf');
  assert.equal(out.name, 'Ekstre Ağustos İ.pdf');
  assert.deepEqual(out.bytes, [37, 80, 68, 70, 45, 49]);
  assert.deepEqual(log405, [], 'POST sunucuya ulaşmamalı (SW yakalamalı)');
  assert.deepEqual(pageErrors, []);
  await context.close();
});

test('SW: dosya yok / boş dosya / string alan → ./?shared=error ve cache\'e yazılmaz', async () => {
  const { context, page } = await open(SUB());
  const run = (mk) => page.evaluate(async ({ action, mk }) => {
    const fd = new FormData();
    if (mk === 'empty') fd.append('file', new File([], 'bos.pdf', { type: 'application/pdf' }));
    if (mk === 'string') fd.append('file', 'metin');
    if (mk === 'other') fd.append('baska', 'x');
    const res = await fetch(action, { method: 'POST', body: fd });
    const keys = (await (await caches.open('shared-files')).keys()).length;
    return { search: new URL(res.url).search, keys };
  }, { action: SUB() + 'share-target', mk });
  for (const mk of ['none', 'empty', 'string', 'other']) {
    const r = await run(mk);
    assert.equal(r.search, '?shared=error', mk);
    assert.equal(r.keys, 0, mk + ': cache boş kalmalı');
  }
  await context.close();
});

test('SW: share-target dışındaki POST ve share-target GET\'i yakalanmaz; GET davranışı (statik cache) bozulmaz', async () => {
  const { context, page } = await open(SUB());
  log405.length = 0;
  const out = await page.evaluate(async (base) => {
    const post = await fetch(base + 'baska-yol', { method: 'POST', body: 'x' });
    const getShare = await fetch(base + 'share-target');
    const manifest = await fetch(base + 'manifest.json');
    const names = await caches.keys();
    const versioned = names.find((n) => n.startsWith('fullbudget-v'));
    const cached = versioned ? !!(await (await caches.open(versioned)).match(base + 'manifest.json')) : false;
    return { post: post.status, getShare: getShare.status, manifest: manifest.status, cached, names };
  }, SUB());
  assert.equal(out.post, 405, 'başka POST SW tarafından yakalanmamalı (sunucuya düşer)');
  assert.equal(out.getShare, 404, 'share-target GET yakalanmamalı');
  assert.equal(out.manifest, 200);
  assert.ok(out.cached, 'statik dosyalar mevcut cache mantığıyla sürümlü önbellekte');
  assert.ok(log405.some((l) => l.includes('baska-yol')));
  await context.close();
});

test('SW: genel cache temizliği (activate) shared-files\'ı SİLMEZ, eski sürümlü cache\'i siler', async () => {
  const { context, page } = await open(SUB());
  await page.evaluate(async () => {
    await (await caches.open('shared-files')).put(new URL('latest', location.href).href, new Response('abc', { headers: { 'X-Name': 'a.csv' } }));
    await (await caches.open('fullbudget-v1-eski')).put(new URL('x', location.href).href, new Response('old'));
  });
  swSuffix.v = 'yeni-surum-' + Date.now();                 // sw.js baytları değişti → yeni SW install + activate
  const names = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    await reg.update();
    const dl = Date.now() + 10000;
    while (Date.now() < dl) {
      const n = await caches.keys();
      if (!n.includes('fullbudget-v1-eski')) return n;
      await new Promise((r) => setTimeout(r, 150));
    }
    return await caches.keys();
  });
  swSuffix.v = '';
  assert.ok(!names.includes('fullbudget-v1-eski'), 'eski sürümlü cache temizlenmeli (genel temizlik çalıştı)');
  assert.ok(names.includes('shared-files'), 'shared-files korunmalı');
  const kept = await page.evaluate(async () => {
    const hit = await (await caches.open('shared-files')).match(new URL('latest', location.href).href);
    return hit ? await hit.text() : null;
  });
  assert.equal(kept, 'abc');
  await context.close();
});

/* ---------- Uygulama akışı ---------- */
test('CSV paylaş → FullBudget açılır → özet (işlem/yeni/mevcut) → Vazgeç → hiçbir veri değişmez', async () => {
  const { context, page, pageErrors } = await open(SUB());
  const before = await snapshot(page);
  await share(page, SUB(), SUMMARY_CSV);
  const d = await dialog(page);
  assert.equal(await snapshot(page), before, 'paylaşım navigasyonu sonrası veri parmak izi aynı');
  assert.match(d.text, /3 işlem bulundu/);
  assert.match(d.text, /3 yeni işlem/);
  assert.match(d.text, /0 işlem zaten mevcut/);
  assert.match(d.text, /ekstre\.csv/);
  assert.match(d.text, /Test Kart/);
  assert.equal(d.ok, 'İçe Aktar');
  assert.equal(d.cancel, 'Vazgeç');
  assert.equal(await page.evaluate(() => location.search), '', '?shared adres çubuğundan temizlenmiş olmalı');
  assert.equal(await page.evaluate(async () => !!(await (await caches.open('shared-files')).match(new URL('latest', location.href).href))), false, 'shared-files/latest temizlenmeli');
  // İçe Aktar'a BASILMADAN taslak yalnızca bellekte; kalıcı veri aynı
  assert.equal(await snapshot(page), before, 'özet gösterilirken veri değişmemeli');
  await page.click('#customConfirmCancelBtn');
  await page.waitForTimeout(400);
  assert.equal(await snapshot(page), before, 'Vazgeç sonrası veri değişmemeli');
  assert.equal(await page.evaluate(() => csvDraftTransactions.length), 0, 'taslak temizlenmeli');
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('csvReviewSection')).display), 'none');
  assert.deepEqual(pageErrors, []);
  await context.close();
});

test('CSV: İçe Aktar → mevcut inceleme ekranı açılır, onaylanana kadar veri DEĞİŞMEZ; onay → mevcut hat işler', async () => {
  const { context, page, pageErrors } = await open(SUB());
  const before = await snapshot(page);
  await share(page, SUB(), SUMMARY_CSV);
  await dialog(page);
  await page.click('#customConfirmOkBtn');
  await page.waitForSelector('#csvReviewSection', { state: 'visible', timeout: 8000 });
  assert.equal(await page.evaluate(() => aktifYaprak()), 'debts');
  assert.equal(await page.evaluate(() => document.querySelectorAll('#csvReviewList .csv-row').length), 3);
  assert.equal(await snapshot(page), before, 'inceleme açıkken (onaysız) veri değişmemeli');
  await page.click('#csvApproveBtn');
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => ({
    exp: month.expenses.filter((e) => e.sourceType === 'csv').length,
    imported: persistent.importedTransactions.length,
    card: persistent.creditCards[0].currentBalance,
  }));
  assert.equal(after.exp, 3);
  assert.equal(after.imported, 3);
  assert.equal(after.card, 1000 + 125.4 + 850 + 199.99);
  assert.deepEqual(pageErrors, []);
  await context.close();
});

test('Aynı dosya TEKRAR paylaşılır → mevcut mükerrer koruması çalışır (özet + "Olası kopya" rozetleri)', async () => {
  const { context, page, pageErrors } = await open(SUB());
  await share(page, SUB(), SUMMARY_CSV);
  await dialog(page); await page.click('#customConfirmOkBtn');
  await page.waitForSelector('#csvReviewSection', { state: 'visible' });
  await page.click('#csvApproveBtn'); await page.waitForTimeout(400);
  const expAfterFirst = await page.evaluate(() => month.expenses.length);

  await share(page, SUB(), SUMMARY_CSV);
  const d = await dialog(page);
  assert.match(d.text, /3 işlem bulundu/);
  assert.match(d.text, /0 yeni işlem/);
  assert.match(d.text, /3 işlem zaten mevcut/);
  await page.click('#customConfirmOkBtn');
  await page.waitForSelector('#csvReviewSection', { state: 'visible' });
  assert.equal(await page.evaluate(() => document.querySelectorAll('#csvReviewList .csv-badge.dup').length), 3, 'mevcut "Olası kopya" rozeti');
  assert.equal(await page.evaluate(() => month.expenses.length), expAfterFirst, 'onaysız ikinci paylaşım yeni kayıt eklememeli');
  // Olası mükerrerler VARSAYILAN OLARAK SEÇİLİ DEĞİL: satırlar listede (rozetli) ama işaretsiz
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('#csvReviewList .csv-row-check')].filter((c) => c.checked).length), 0);
  assert.equal(await page.evaluate(() => document.querySelectorAll('#csvReviewList .csv-row.excluded').length), 3);
  assert.match(await page.evaluate(() => document.getElementById('csvReviewSummary').textContent), /3 işlem bulundu, 0 tanesi/);
  // "Seçilenleri Onayla" hiçbir şey eklemez (seçili işlem yok)
  await page.click('#csvApproveBtn'); await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => month.expenses.length), expAfterFirst, 'varsayılan seçimle onay kopya EKLEMEMELİ');
  assert.equal(await page.evaluate(() => document.getElementById('toast').textContent), 'Seçili işlem yok');
  // Kullanıcı bilerek işaretlerse mevcut hat yine işler (karar kullanıcıda)
  await page.check('#csvReviewList .csv-row:first-child .csv-row-check');
  await page.click('#csvApproveBtn'); await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => month.expenses.length), expAfterFirst + 1);
  assert.deepEqual(pageErrors, []);
  await context.close();
});

test('PDF paylaş → FullBudget açılır → mevcut PDF hattıyla özet → onay → işlenir', async () => {
  const { context, page, pageErrors } = await open(SUB());
  const before = await snapshot(page);
  await stubPdfJs(page);
  await share(page, SUB(), { name: 'kart-ekstresi.pdf', type: 'application/pdf', text: PDF_BYTES });
  const d = await dialog(page);
  assert.match(d.text, /2 işlem bulundu/);
  assert.match(d.text, /kart-ekstresi\.pdf/);
  assert.equal(await snapshot(page), before);
  await page.click('#customConfirmOkBtn');
  await page.waitForSelector('#csvReviewSection', { state: 'visible' });
  await page.click('#csvApproveBtn'); await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => month.expenses.filter((e) => e.sourceType === 'pdf').length), 2);
  assert.deepEqual(pageErrors, []);
  await context.close();
});

for (const [label, name, type] of [
  ['XLSX', 'ekstre.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['XLS', 'ekstre.xls', 'application/vnd.ms-excel'],
]) {
  test(`${label} paylaş → FullBudget açılır, çökmez; dürüstçe "henüz okunamıyor" der, veri değişmez`, async () => {
    const { context, page, pageErrors } = await open(SUB());
    const before = await snapshot(page);
    await share(page, SUB(), { name, type, text: 'PK\u0003\u0004 sahte' });
    const d = await dialog(page);
    assert.match(d.text, /Excel dosyaları henüz doğrudan okunamıyor/);
    assert.match(d.text, /CSV veya PDF/);
    assert.equal(d.ok, 'Tamam');
    assert.equal(d.cancelHidden, true);
    await page.click('#customConfirmOkBtn');
    assert.equal(await snapshot(page), before);
    assert.deepEqual(pageErrors, []);
    await context.close();
  });
}

test('Dosya yok → ?shared=error → "Dosya alınamadı." mesajı, uygulama çökmez', async () => {
  const { context, page, pageErrors } = await open(SUB());
  const before = await snapshot(page);
  await share(page, SUB(), 'none');
  const d = await dialog(page);
  assert.equal(d.text, 'Dosya alınamadı.\nLütfen dosyayı tekrar paylaşmayı dene.');
  assert.equal(d.cancelHidden, true);
  assert.equal(await page.evaluate(() => location.search), '');
  await page.click('#customConfirmOkBtn');
  assert.equal(await snapshot(page), before);
  assert.deepEqual(pageErrors, []);
  await context.close();
});

test('Boş dosya → ?shared=error mesajı', async () => {
  const { context, page, pageErrors } = await open(SUB());
  await share(page, SUB(), { name: 'bos.csv', type: 'text/csv', text: '' });
  const d = await dialog(page);
  assert.match(d.text, /Dosya alınamadı\./);
  assert.deepEqual(pageErrors, []);
  await context.close();
});

test('Elle yazılmış ?shared=error ve cache\'i boş ?shared=1 de çökmez', async () => {
  for (const q of ['?shared=error', '?shared=1']) {
    const { context, page, pageErrors } = await open(SUB(), { seed: false, query: q });
    const d = await dialog(page);
    assert.match(d.text, /Dosya alınamadı\./, q);
    assert.deepEqual(pageErrors, [], q);
    await context.close();
  }
});

test('Yanlış/uyumsuz dosya (txt/png) → desteklenmeyen tür mesajı, çökmez, veri değişmez', async () => {
  const { context, page, pageErrors } = await open(SUB());
  const before = await snapshot(page);
  await share(page, SUB(), { name: 'foto.png', type: 'image/png', text: 'x' });
  const d = await dialog(page);
  assert.match(d.text, /Bu dosya türü desteklenmiyor/);
  await page.click('#customConfirmOkBtn');
  assert.equal(await snapshot(page), before);
  assert.deepEqual(pageErrors, []);
  await context.close();
});

test('Bozuk CSV (okunabilir işlem yok) → mevcut hat uyarır, özet/inceleme açılmaz, veri değişmez', async () => {
  const { context, page, pageErrors } = await open(SUB());
  const before = await snapshot(page);
  await share(page, SUB(), { name: 'cop.csv', type: 'text/csv', text: 'a,b\nc,d\n' });
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('işlem okunamadı'), null, { timeout: 8000 });
  assert.equal(await page.evaluate(() => document.getElementById('customConfirmModal').classList.contains('acik')), false);
  assert.equal(await snapshot(page), before);
  assert.deepEqual(pageErrors, []);
  await context.close();
});

test('Kart yoksa dosya içe aktarılmaz, kullanıcı yönlendirilir (çökme yok, veri değişmez)', async () => {
  const { context, page, pageErrors } = await open(SUB(), { seed: false });
  await page.evaluate(() => { persistent.creditCards = []; persist(); });
  const before = await snapshot(page);
  await share(page, SUB(), SUMMARY_CSV);
  const d = await dialog(page);
  assert.match(d.text, /Önce bir kredi kartı ekle/);
  await page.click('#customConfirmOkBtn');
  assert.equal(await snapshot(page), before);
  assert.deepEqual(pageErrors, []);
  await context.close();
});

test('Normal kullanım etkilenmez: paylaşımsız açılışta diyalog/özet yok, mevcut CSV yükleme çalışır', async () => {
  const { context, page, pageErrors } = await open(DIRECT());
  await page.waitForTimeout(900);
  assert.equal(await page.evaluate(() => document.getElementById('customConfirmModal').classList.contains('acik')), false);
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('csvReviewSection')).display), 'none');
  // mevcut dosya girişi (manuel yükleme) hâlâ doğrudan inceleme ekranını açar
  await page.evaluate(() => { setTab('debts'); });
  await page.setInputFiles('#csvFileInput', { name: 'ekstre.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) });
  await page.waitForSelector('#csvReviewSection', { state: 'visible', timeout: 8000 });   // taksit YOKKEN de görünür
  assert.equal(await page.evaluate(() => document.querySelectorAll('#csvReviewList .csv-row').length), 3);
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('#csvReviewList .csv-row-check')].every((c) => c.checked)), true, 'mükerrer olmayan satırlar varsayılan seçili');
  assert.deepEqual(pageErrors, []);
  await context.close();
});

test('Alt yol uyumu: /app/ altında da aynı akış çalışır (SW kapsamına göre anahtar/yönlendirme)', async () => {
  const { context, page, pageErrors } = await open(DIRECT());
  await share(page, DIRECT(), SUMMARY_CSV);
  const d = await dialog(page);
  assert.match(d.text, /3 işlem bulundu/);
  assert.deepEqual(pageErrors, []);
  await context.close();
});

test('Ekstre İncelemesi "Taksit Yükü" kapsayıcısından ayrı; taksit yokken de görünür', async () => {
  const { context, page, pageErrors } = await open(DIRECT());
  const out = await page.evaluate(() => {
    const sec = document.getElementById('csvReviewSection');
    const taksit = document.querySelector('[data-section="taksit-yuku"]');
    renderInstallmentBurden && renderInstallmentBurden();
    return { insideTaksit: !!sec.closest('[data-section="taksit-yuku"]'), taksitHidden: taksit.hidden,
      sameTab: sec.closest('.tab-panel').dataset.tab, sibling: sec.parentElement === taksit.parentElement };
  });
  assert.equal(out.insideTaksit, false);
  assert.equal(out.taksitHidden, true, 'taksit yokken Taksit Yükü bölümü gizli kalmaya devam eder (davranış değişmedi)');
  assert.equal(out.sameTab, 'debts');
  assert.equal(out.sibling, true);
  assert.deepEqual(pageErrors, []);
  await context.close();
});

test('Varsayılan seçim: CSV içinde mükerrer olmayan satırlar seçili, yalnızca olası mükerrerler işaretsiz (PDF ve fiş taslakları dahil)', async () => {
  const { context, page } = await open(DIRECT());
  const out = await page.evaluate(() => {
    persistent.importedTransactions = [{ cardId: 'c1', date: '05.09', merchant: 'MIGROS ISTANBUL', amount: 125.4, importedAt: new Date().toISOString() }];
    const csv = parseCsvTransactions('Tarih,Açıklama,Tutar\n05.09.2026,MIGROS ISTANBUL,"125,40"\n06.09.2026,SHELL,"850,00"\n', 'c1').transactions;
    const pdf = buildDraftsFromPdfLines(['05.09.2026 MIGROS ISTANBUL 125,40', '06.09.2026 SHELL AKARYAKIT 850,00'], 'c1').transactions;
    return { csv: csv.map((t) => [t.isDuplicate, t.include]), pdf: pdf.map((t) => [t.isDuplicate, t.include]) };
  });
  assert.deepEqual(out.csv, [[true, false], [false, true]]);
  assert.deepEqual(out.pdf, [[true, false], [false, true]]);
  await context.close();
});
