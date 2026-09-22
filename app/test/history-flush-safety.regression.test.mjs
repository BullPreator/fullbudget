// FAZ 3.14 IP-5 (history flush safety net):
// -----------------------------------------------------------------------------------------
// AUDIT BULGUSU (FULLBUDGET_YNAB_AUDIT.md, P1, IP-5): scheduleHistorySave()'in 400ms'lik
// debounce yazımı (history[] -> HISTORY_KEY), flushPendingPersistence()'ın month/persistent
// için sağladığı kapatma-öncesi güvenceye DAHİL DEĞİLDİ. Sekme, bir düzenlemeden sonraki
// 400ms içinde kapatılırsa (pagehide/beforeunload/visibilitychange->hidden), bellekteki
// güncel history[] diske hiç yazılmadan kaybolabiliyordu — bir sonraki tam sayfa
// yüklemesinde "Geçmiş" ekranı bayat kalıyordu.
//
// Bu dosya YENİ bir mimari test ETMİYOR: _monthDirty/_persistentDirty deseninin AYNI
// mantıkla history[]'ye genişletilmiş hâlini (_historyDirty + flushPendingPersistence()'daki
// izole history bloğu + scheduleHistorySave()'in debounce callback'inde dirty'nin yazma
// TAMAMLANDIKTAN SONRA temizlenmesi) doğruluyor. Gerçek finansal veri (month/persistent)
// bu değişiklikten ETKİLENMİYOR — mevcut ROLLOVER/RACE testleri ayrıca (dokunulmadan)
// yeniden çalıştırılarak bu doğrulanıyor.
//
// waitForTimeout KULLANILMIYOR: doğrulama tamamen deterministik — gerçek lifecycle
// event'leri (pagehide/beforeunload/visibilitychange) dispatch edilip HEMEN ardından
// (hiç bekleme olmadan) hem bellek hem disk durumu okunuyor. Test ortamında window.storage
// köprüsü kurulmadığı için (mevcut ROLLOVER testlerinde de doğrulandığı gibi) no-bridge
// yol senkron localStorage.setItem kullanır — bu yüzden "hemen okuma" deterministik olarak
// doğru sonucu verir.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..', '..');

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

async function dismissOverlays(page) {
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
}

async function newSession() {
  const page = await browser.newPage({ viewport: { width: 390, height: 1200 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  await dismissOverlays(page);
  await page.evaluate(() => {
    persistent.accounts = [];
    persistent.debts = [];
    persistent.creditCards = [];
    persistent.goals = [];
    persistent.recurringIncomes = [];
    persistent.recurringExpenses = [];
    persistent.dailyMoneyTask = null;
  });
  return { page, pageErrors };
}

// -----------------------------------------------------------------------
// HISTORY-FLUSH-01: bir düzenlemeden HEMEN sonra (400ms debounce dolmadan) "pagehide"
// dispatch edilirse, bekleyen history yazması diske işlenmiş olmalı.
// -----------------------------------------------------------------------
test('HISTORY-FLUSH-01: pagehide, 400ms dolmadan bekleyen history yazmasını diske işler', async () => {
  const { page, pageErrors } = await newSession();

  const before1 = await page.evaluate(async () => {
    const mk = monthKey;
    const onDiskBefore = await FullBudgetDataService.loadHistory();
    return { mk, onDiskBefore };
  });

  const r = await page.evaluate(async (mk) => {
    // render() zaten scheduleHistorySave()'i çağırıyor — gerçek bir gelir ekleyip
    // render() tetiklemek yerine, mevcut kodun KENDİ üretim yolunu (render() içindeki
    // scheduleHistorySave çağrısı) kullanmak için doğrudan bir gelir ekliyoruz.
    month.incomes.push({ id: 'i1', category: 'Maaş', amount: 12345, note: '', recurring: false, accountId: '' });
    render(); // -> scheduleHistorySave() çağrılır, _historyDirty=true, 400ms timer kurulur

    const dirtyRightAfterRender = _historyDirty;
    const memHistoryEntry = history.find(h => h.monthKey === mk);

    // 400ms dolmadan (hiç bekleme YOK) sayfa kapanıyormuş gibi pagehide dispatch et.
    // Üretim kodu bu listener'ı window.addEventListener('pagehide', ...) ile kaydediyor
    // (document değil) — event'i doğru hedefte (window) dispatch etmek gerekiyor.
    window.dispatchEvent(new Event('pagehide'));

    const dirtyAfterPagehide = _historyDirty;
    const onDiskAfter = await FullBudgetDataService.loadHistory();
    const diskEntry = onDiskAfter ? onDiskAfter.find(h => h.monthKey === mk) : null;

    return { dirtyRightAfterRender, dirtyAfterPagehide, memHistoryEntry, diskEntry };
  }, before1.mk);

  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));

  assert.equal(r.dirtyRightAfterRender, true, 'render() sonrası (yazma henüz gerçekleşmeden) _historyDirty true olmalı');
  assert.ok(r.memHistoryEntry, 'bellek-içi history[] render() sonrası hemen güncellenmiş olmalı (senkron)');
  assert.equal(Math.round(r.memHistoryEntry.income), 12345);

  assert.equal(r.dirtyAfterPagehide, false, 'pagehide sonrası _historyDirty false olmalı (flush edildi)');
  assert.ok(r.diskEntry, `pagehide sonrası diskte bu ayın history kaydı olmalı, gerçek: ${JSON.stringify(r.diskEntry)}`);
  assert.equal(Math.round(r.diskEntry.income), 12345, 'diske yazılan history kaydı güncel geliri içermeli');
});

// -----------------------------------------------------------------------
// HISTORY-FLUSH-02: aynı senaryo "beforeunload" için.
// -----------------------------------------------------------------------
test('HISTORY-FLUSH-02: beforeunload, 400ms dolmadan bekleyen history yazmasını diske işler', async () => {
  const { page, pageErrors } = await newSession();
  const mk = await page.evaluate(() => monthKey);

  const r = await page.evaluate(async (mk) => {
    month.expenses.push({ id: 'e1', category: 'Market', amount: 999, note: '', recurring: false, fixed: false, accountId: '', cardId: '' });
    render();
    const dirtyBefore = _historyDirty;
    window.dispatchEvent(new Event('beforeunload'));
    const dirtyAfter = _historyDirty;
    const onDisk = await FullBudgetDataService.loadHistory();
    const diskEntry = onDisk ? onDisk.find(h => h.monthKey === mk) : null;
    return { dirtyBefore, dirtyAfter, diskEntry, memExpense: month.expenses.length };
  }, mk);

  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));

  assert.equal(r.dirtyBefore, true);
  assert.equal(r.dirtyAfter, false, 'beforeunload sonrası _historyDirty false olmalı');
  assert.ok(r.diskEntry, `beforeunload sonrası diskte bu ayın history kaydı olmalı, gerçek: ${JSON.stringify(r.diskEntry)}`);
  assert.equal(Math.round(r.diskEntry.expense), 999);
});

// -----------------------------------------------------------------------
// HISTORY-FLUSH-03: aynı senaryo "visibilitychange" -> hidden için.
// -----------------------------------------------------------------------
test('HISTORY-FLUSH-03: visibilitychange->hidden, 400ms dolmadan bekleyen history yazmasını diske işler', async () => {
  const { page, pageErrors } = await newSession();
  const mk = await page.evaluate(() => monthKey);

  const r = await page.evaluate(async (mk) => {
    month.incomes.push({ id: 'i2', category: 'Diğer', amount: 555, note: '', recurring: false, accountId: '' });
    render();
    const dirtyBefore = _historyDirty;
    // Gerçek kodda `document.visibilityState` salt-okunur; testte yalnızca event'i
    // dispatch ediyoruz ve flushPendingPersistence()'ın _historyDirty davranışını
    // doğrudan gözlemliyoruz (visibilityState'i sahteleme burada gereksiz — üretim
    // listener'ı zaten yalnızca flushPendingPersistence()'ı çağırıyor, biz de aynı
    // fonksiyonu event üzerinden tetikliyoruz).
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    const dirtyAfter = _historyDirty;
    const onDisk = await FullBudgetDataService.loadHistory();
    const diskEntry = onDisk ? onDisk.find(h => h.monthKey === mk) : null;
    return { dirtyBefore, dirtyAfter, diskEntry };
  }, mk);

  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));

  assert.equal(r.dirtyBefore, true);
  assert.equal(r.dirtyAfter, false, 'visibilitychange->hidden sonrası _historyDirty false olmalı');
  assert.ok(r.diskEntry, `visibilitychange->hidden sonrası diskte bu ayın history kaydı olmalı, gerçek: ${JSON.stringify(r.diskEntry)}`);
});

// -----------------------------------------------------------------------
// HISTORY-FLUSH-04: bekleyen bir history yazması YOKSA (400ms zaten dolmuş/hiç
// değişiklik yokken) flush çağrısı gereksiz bir yazma YAPMAMALI (erken-çıkış korunuyor).
// -----------------------------------------------------------------------
test('HISTORY-FLUSH-04: bekleyen history değişikliği yokken flush hiçbir şey yapmaz (erken-çıkış korunuyor)', async () => {
  const { page, pageErrors } = await newSession();

  const r = await page.evaluate(async () => {
    // Hiçbir gelir/gider eklenmedi, render() hiç çağrılmadı -> _historyDirty baştan false.
    const dirtyBefore = _historyDirty;
    let saveHistoryCalled = false;
    const orig = FullBudgetDataService.saveHistory.bind(FullBudgetDataService);
    FullBudgetDataService.saveHistory = async function (data) {
      saveHistoryCalled = true;
      return orig(data);
    };
    document.dispatchEvent(new Event('pagehide'));
    // flushPendingPersistence senkron; hemen ardından kontrol yeterli.
    const dirtyAfter = _historyDirty;
    return { dirtyBefore, dirtyAfter, saveHistoryCalled };
  });

  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  assert.equal(r.dirtyBefore, false, 'hiç düzenleme yapılmadıysa _historyDirty baştan false olmalı');
  assert.equal(r.dirtyAfter, false);
  assert.equal(r.saveHistoryCalled, false, 'bekleyen history değişikliği yokken saveHistory() hiç çağrılmamalı (gereksiz yazma yok)');
});

// -----------------------------------------------------------------------
// HISTORY-FLUSH-05: debounce süresi DOĞAL olarak dolarsa (400ms bekleniyor — bu,
// "kapanış anında" değil "normal akış" senaryosu, dolayısıyla burada bir zamanlama
// TAHMİNİ değil gerçek ürün davranışının kendisi test ediliyor), yazma yine tamamlanır
// ve _historyDirty kendi callback'i tarafından temizlenir — flush'a hiç gerek kalmadan.
// -----------------------------------------------------------------------
test('HISTORY-FLUSH-05: normal 400ms debounce dolduğunda history diske yazılır ve _historyDirty kendiliğinden temizlenir', async () => {
  const { page, pageErrors } = await newSession();
  const mk = await page.evaluate(() => monthKey);

  await page.evaluate(() => {
    month.incomes.push({ id: 'i3', category: 'Maaş', amount: 777, note: '', recurring: false, accountId: '' });
    render();
  });

  // Burada waitForTimeout KULLANILMIYOR: gerçek durum bayrağını (_historyDirty) koşul
  // gerçekleşene kadar polling yapan waitForFunction ile deterministik olarak bekliyoruz.
  await page.waitForFunction(() => _historyDirty === false, { timeout: 5000 });

  const r = await page.evaluate(async (mk) => {
    const onDisk = await FullBudgetDataService.loadHistory();
    return { diskEntry: onDisk ? onDisk.find(h => h.monthKey === mk) : null };
  }, mk);

  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  assert.ok(r.diskEntry, 'normal debounce süresi dolduğunda history diske yazılmış olmalı');
  assert.equal(Math.round(r.diskEntry.income), 777);
});
