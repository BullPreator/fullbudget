// FAZ 3.14 IP-1 (race-condition hardening):
// -----------------------------------------------------------------------------------------
// Denetim (mevcut IP-1 implementasyonunun doğrulaması sırasında tespit edildi): checkMonthRollover()'ın
// SENKRON kısmı (monthKey'i güncelleyip `month`'u geçici boş bir iskelete sıfırlaması)
// `await FullBudgetDataService.loadMonth()`'tan ÖNCE tamamlanıyordu. Bu tek bir çağrı içinde
// güvenliydi, ama FARKLI bir tetikleyicinin (örn. visibilitychange'in başlattığı rollover hâlâ
// loadMonth()'u beklerken kullanıcının gelir/gider "ekle" butonuna basması) bu bekleme
// penceresine girmesine engel değildi: o handler kendi needsMonthRollover() kontrolünde
// monthKey ZATEN güncellendiği için false görüyor, checkMonthRollover()'ı hiç çağırmadan
// doğrudan month.incomes.push(...)'a geçiyordu — ama month o an hâlâ boş iskeletti. Bekleyen
// çağrı await sonrası month.incomes = m.incomes || [] yaptığında bu push tamamen siliniyordu.
//
// Bu dosya YENİ bir mimari test ETMİYOR: mevcut checkMonthRollover()/needsMonthRollover()
// davranışını (ROLLOVER-01..05, dokunulmadı) aynen koruyarak, YALNIZCA bu eşzamanlılık
// penceresini kapatan `_monthRolloverInFlight` mekanizmasını doğruluyor:
//   - RACE-01: visibilitychange rollover'ı loadMonth() aşamasında beklerken gelir eklenirse,
//     yeni gelir KAYBOLMAMALI.
//   - RACE-02: aynı senaryo gider ("Harcama ekle") yolu için.
//   - RACE-03: aynı senaryoda recurring (düzenli) bir gelir şablonu da varsa, runMonthlyAutomation()
//     TAM OLARAK BİR KEZ çalışmalı (ne kayıp ne duplicate).
//
// Zamanlamaya dayalı bekleme (waitForTimeout ile "yeterince bekle" tahmini) KULLANILMIYOR.
// Bunun yerine FullBudgetDataService.loadMonth() YENİ ay anahtarı için çağrıldığında, testin
// kontrolündeki bir "gate" Promise'ini bekleyecek şekilde geçici olarak yamalanıyor (yalnızca o
// anahtar için — diğer çağrılar orijinal davranışı korur). Rollover'ın gerçekten bu bekleme
// noktasında durduğu ve butonun kendi işinin HENÜZ tamamlanmadığı, sabit bir bekleme SÜRESİ
// tahmin ederek değil, sayfa içindeki gerçek durum bayraklarını (page.waitForFunction ile,
// koşul gerçekleşene kadar) sorgulayarak doğrulanıyor.
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

// month-transition-rollover.regression.test.mjs ile BİREBİR aynı yardımcılar (o dosyaya
// dokunulmadı — burada bilinçli olarak, bağımsız/self-contained kalması için kopyalandı).
function pinDateInitScript(isoString) {
  return (iso) => {
    const RealDate = Date;
    class FakeDate extends RealDate {
      constructor(...args) {
        if (args.length === 0) super(iso);
        else super(...args);
      }
      static now() { return new RealDate(iso).getTime(); }
    }
    window.Date = FakeDate;
  };
}

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

async function newSession(pinnedIso) {
  const page = await browser.newPage({ viewport: { width: 390, height: 1200 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  if (pinnedIso) await page.addInitScript(pinDateInitScript(pinnedIso), pinnedIso);
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

function nextMonthIso(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  const nm = m === 12 ? 1 : m + 1;
  const ny = m === 12 ? y + 1 : y;
  return `${ny}-${String(nm).padStart(2, '0')}-05T10:00:00`;
}

function nextMonthKey(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  const nm = m === 12 ? 1 : m + 1;
  const ny = m === 12 ? y + 1 : y;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

// FullBudgetDataService.loadMonth()'u, YALNIZCA verilen `gatedMonthKey` için çağrıldığında
// testin kontrolündeki bir Promise'i bekleyecek şekilde yamalar. Diğer tüm anahtarlar için
// (örn. eski ayın kaydını okuyan doğrulama çağrıları) orijinal davranış aynen korunur.
// Döndürülen bayraklar zamanlama TAHMİNİ değil, gerçek yürütme noktalarını işaretler:
//   window.__raceLoadMonthHit      -> gated loadMonth() çağrısı BAŞLADI (gate'i beklemeye başladı)
//   window.__raceLoadMonthResolved -> gate serbest bırakıldı VE orijinal loadMonth() döndü
async function installLoadMonthGate(page, gatedMonthKey) {
  await page.evaluate((key) => {
    window.__raceLoadMonthHit = false;
    window.__raceLoadMonthResolved = false;
    let releaseFn;
    window.__raceGate = new Promise((res) => { releaseFn = res; });
    window.__raceReleaseGate = () => releaseFn();
    const orig = FullBudgetDataService.loadMonth.bind(FullBudgetDataService);
    FullBudgetDataService.loadMonth = async function (mKey) {
      if (mKey === key) {
        window.__raceLoadMonthHit = true;
        await window.__raceGate;
        const result = await orig(mKey);
        window.__raceLoadMonthResolved = true;
        return result;
      }
      return orig(mKey);
    };
  }, gatedMonthKey);
}

// -----------------------------------------------------------------------
// RACE-01: visibilitychange rollover'ı loadMonth() aşamasında BEKLERKEN "gelir ekle"
// tetiklenirse, yeni gelir KAYBOLMAMALI (eski, kayıp-yaratan davranış: month henüz boş
// iskeletken push edilip az sonra rollover'ın kendi ataması tarafından silinirdi).
// -----------------------------------------------------------------------
test('RACE-01: rollover loadMonth() beklerken eklenen gelir kaybolmuyor', async () => {
  const { page, pageErrors } = await newSession();

  const oldMonthKey = await page.evaluate(() => monthKey);
  const newMonthKey = nextMonthKey(oldMonthKey);

  // Eski ayda gerçek, diske yazılmış bir kayıt olsun (bozulmadığını doğrulamak için).
  await page.evaluate(async () => {
    month.incomes = [{ id: 'old-i1', category: 'Maaş', amount: 50000, note: '', recurring: false, accountId: '' }];
    month.expenses = [];
    await FullBudgetDataService.saveMonth(monthKey, month);
  });

  await installLoadMonthGate(page, newMonthKey);

  // Saat yeni aya geçiyor (sayfa açık, reload YOK — canlı senaryo).
  const fakeIso = nextMonthIso(oldMonthKey);
  await page.evaluate((iso) => {
    const RealDate = Date;
    class FakeDate extends RealDate {
      constructor(...args) { if (args.length === 0) super(iso); else super(...args); }
      static now() { return new RealDate(iso).getTime(); }
    }
    window.Date = FakeDate;
  }, fakeIso);

  // 1) visibilitychange'in gerçek tetikleyicisini simüle et (index.html'deki listener aynen
  //    üretimde olduğu gibi checkMonthRollover()'ı AWAIT ETMEDEN/fire-and-forget çağırır).
  await page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });

  // 2) Rollover'ın GERÇEKTEN gated loadMonth() aşamasında beklediğini, sabit bir süre tahmin
  //    etmeden, gerçek bir durum bayrağını sorgulayarak doğrula.
  await page.waitForFunction(() => window.__raceLoadMonthHit === true, { timeout: 10000 });
  const inFlightWhileBlocked = await page.evaluate(() => typeof _monthRolloverInFlight !== 'undefined' && _monthRolloverInFlight !== null);
  assert.equal(inFlightWhileBlocked, true, '_monthRolloverInFlight, loadMonth beklenirken dolu olmalı');

  // 3) Bu bekleme penceresi İÇİNDEYKEN gelir ekleme butonunu tetikle (gerçek UI akışı: sekmeyi
  //    aç, tutarı yaz, butona bas).
  await page.evaluate(() => executeQuickAction({ tab: 'income', section: 'gelirin', focus: 'incomeAmountInput' }));
  await page.waitForTimeout(200); // sekme geçişi animasyonu — race penceresiyle ilgisiz, UI navigasyonu
  await page.fill('#incomeAmountInput', '7500');
  await page.click('#addIncomeBtn');

  // 4) Handler'ın kendi işinin (push/persist/render) gate serbest kalmadan TAMAMLANMADIĞINI
  //    doğrula — zamanlama tahmini değil, doğrudan durumu okuyarak.
  const notYetPushed = await page.evaluate(() => !month.incomes.some((i) => Math.round(i.amount) === 7500));
  assert.equal(notYetPushed, true, 'gate serbest kalmadan yeni gelir month.incomes içine düşmemeli');
  const gateStillPending = await page.evaluate(() => window.__raceLoadMonthResolved === false);
  assert.equal(gateStillPending, true, 'gate serbest kalmadan gated loadMonth() henüz dönmemeli');

  // 5) Gate'i serbest bırak ve TÜM işlemlerin tamamlanmasını (yine durum bayraklarıyla) bekle.
  await page.evaluate(() => window.__raceReleaseGate());
  await page.waitForFunction(() => window.__raceLoadMonthResolved === true, { timeout: 10000 });
  await page.waitForFunction(() => month.incomes.some((i) => Math.round(i.amount) === 7500), { timeout: 10000 });
  await page.waitForFunction(() => typeof _monthRolloverInFlight !== 'undefined' && _monthRolloverInFlight === null, { timeout: 10000 });

  const r = await page.evaluate(async (oldKey) => {
    // addIncomeBtn'in kendi persist() çağrısı debounce'lu (persistMonth/persistPersistent) —
    // disk durumunu okumadan önce senkron olarak flush et (zamanlama tahmini değil, mevcut
    // flushPendingPersistence() yardımcı fonksiyonunun aynen kullanımı).
    flushPendingPersistence();
    const newKey = monthKey;
    const oldRecord = await FullBudgetDataService.loadMonth(oldKey);
    const newRecord = await FullBudgetDataService.loadMonth(newKey);
    return {
      liveMonthKey: monthKey,
      liveIncomes: month.incomes.map((i) => Math.round(i.amount)),
      oldRecordIncomes: oldRecord ? oldRecord.incomes : null,
      newRecordIncomes: newRecord ? newRecord.incomes : null,
    };
  }, oldMonthKey);

  assert.equal(r.liveMonthKey, newMonthKey, 'aktif monthKey yeni aya geçmiş olmalı');
  assert.deepEqual(r.liveIncomes.sort(), [7500], 'yeni ay yalnızca race sırasında eklenen geliri içermeli');
  assert.ok(r.newRecordIncomes && r.newRecordIncomes.length === 1 && Math.round(r.newRecordIncomes[0].amount) === 7500,
    `yeni gelir yeni ayın diskteki kaydına yazılmalı, gerçek: ${JSON.stringify(r.newRecordIncomes)}`);
  assert.ok(r.oldRecordIncomes && r.oldRecordIncomes.length === 1 && Math.round(r.oldRecordIncomes[0].amount) === 50000,
    `eski ayın diskteki kaydı BOZULMAMALI, gerçek: ${JSON.stringify(r.oldRecordIncomes)}`);

  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// -----------------------------------------------------------------------
// RACE-02: aynı senaryo, gider ("Harcama ekle") yolu için.
// -----------------------------------------------------------------------
test('RACE-02: rollover loadMonth() beklerken eklenen gider kaybolmuyor', async () => {
  const { page, pageErrors } = await newSession();

  const oldMonthKey = await page.evaluate(() => monthKey);
  const newMonthKey = nextMonthKey(oldMonthKey);

  await page.evaluate(async () => {
    month.incomes = [];
    month.expenses = [{ id: 'old-e1', category: 'Market', amount: 12000, note: '', recurring: false, fixed: false, accountId: '', cardId: '' }];
    await FullBudgetDataService.saveMonth(monthKey, month);
  });

  await installLoadMonthGate(page, newMonthKey);

  const fakeIso = nextMonthIso(oldMonthKey);
  await page.evaluate((iso) => {
    const RealDate = Date;
    class FakeDate extends RealDate {
      constructor(...args) { if (args.length === 0) super(iso); else super(...args); }
      static now() { return new RealDate(iso).getTime(); }
    }
    window.Date = FakeDate;
  }, fakeIso);

  await page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });

  await page.waitForFunction(() => window.__raceLoadMonthHit === true, { timeout: 10000 });
  const inFlightWhileBlocked = await page.evaluate(() => typeof _monthRolloverInFlight !== 'undefined' && _monthRolloverInFlight !== null);
  assert.equal(inFlightWhileBlocked, true, '_monthRolloverInFlight, loadMonth beklenirken dolu olmalı');

  await page.evaluate(() => executeQuickAction({ tab: 'expenses', section: 'harcama-ekle', focus: 'amountInput' }));
  await page.waitForTimeout(200);
  await page.fill('#amountInput', '900');
  await page.click('#addBtn');

  const notYetPushed = await page.evaluate(() => !month.expenses.some((e) => Math.round(e.amount) === 900));
  assert.equal(notYetPushed, true, 'gate serbest kalmadan yeni gider month.expenses içine düşmemeli');
  const gateStillPending = await page.evaluate(() => window.__raceLoadMonthResolved === false);
  assert.equal(gateStillPending, true, 'gate serbest kalmadan gated loadMonth() henüz dönmemeli');

  await page.evaluate(() => window.__raceReleaseGate());
  await page.waitForFunction(() => window.__raceLoadMonthResolved === true, { timeout: 10000 });
  await page.waitForFunction(() => month.expenses.some((e) => Math.round(e.amount) === 900), { timeout: 10000 });
  await page.waitForFunction(() => typeof _monthRolloverInFlight !== 'undefined' && _monthRolloverInFlight === null, { timeout: 10000 });

  const r = await page.evaluate(async (oldKey) => {
    flushPendingPersistence(); // bkz. RACE-01'deki aynı gerekçe: debounce'lu yazmayı okumadan önce flush et
    const newKey = monthKey;
    const oldRecord = await FullBudgetDataService.loadMonth(oldKey);
    const newRecord = await FullBudgetDataService.loadMonth(newKey);
    return {
      liveMonthKey: monthKey,
      liveExpenses: month.expenses.map((e) => Math.round(e.amount)),
      oldRecordExpenses: oldRecord ? oldRecord.expenses : null,
      newRecordExpenses: newRecord ? newRecord.expenses : null,
    };
  }, oldMonthKey);

  assert.equal(r.liveMonthKey, newMonthKey, 'aktif monthKey yeni aya geçmiş olmalı');
  assert.deepEqual(r.liveExpenses.sort(), [900], 'yeni ay yalnızca race sırasında eklenen gideri içermeli');
  assert.ok(r.newRecordExpenses && r.newRecordExpenses.length === 1 && Math.round(r.newRecordExpenses[0].amount) === 900,
    `yeni gider yeni ayın diskteki kaydına yazılmalı, gerçek: ${JSON.stringify(r.newRecordExpenses)}`);
  assert.ok(r.oldRecordExpenses && r.oldRecordExpenses.length === 1 && Math.round(r.oldRecordExpenses[0].amount) === 12000,
    `eski ayın diskteki kaydı BOZULMAMALI, gerçek: ${JSON.stringify(r.oldRecordExpenses)}`);

  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// -----------------------------------------------------------------------
// RACE-03: aynı race penceresinde bir de recurring (düzenli) gelir şablonu varsa,
// runMonthlyAutomation() TAM OLARAK BİR KEZ çalışmalı — ne kaybolmalı ne duplicate olmalı —
// ve race sırasında elle eklenen gelir de KORUNMALI.
// -----------------------------------------------------------------------
test('RACE-03: race sırasında recurring otomasyon tam bir kez çalışır, elle eklenen gelir kaybolmaz', async () => {
  const { page, pageErrors } = await newSession();

  const oldMonthKey = await page.evaluate(() => monthKey);
  const newMonthKey = nextMonthKey(oldMonthKey);

  await page.evaluate(async () => {
    persistent.recurringIncomes = [{ category: 'Maaş', amount: 30000, note: '', accountId: '' }];
    month.incomes = [];
    month.expenses = [];
    await FullBudgetDataService.saveMonth(monthKey, month);
  });

  await installLoadMonthGate(page, newMonthKey);

  const fakeIso = nextMonthIso(oldMonthKey);
  await page.evaluate((iso) => {
    const RealDate = Date;
    class FakeDate extends RealDate {
      constructor(...args) { if (args.length === 0) super(iso); else super(...args); }
      static now() { return new RealDate(iso).getTime(); }
    }
    window.Date = FakeDate;
  }, fakeIso);

  await page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });

  await page.waitForFunction(() => window.__raceLoadMonthHit === true, { timeout: 10000 });

  // Aynı bekleme penceresi içinde ELLE bir gelir daha eklenmeye çalışılıyor.
  await page.evaluate(() => executeQuickAction({ tab: 'income', section: 'gelirin', focus: 'incomeAmountInput' }));
  await page.waitForTimeout(200);
  await page.fill('#incomeAmountInput', '5000');
  await page.click('#addIncomeBtn');

  const notYetPushed = await page.evaluate(() => !month.incomes.some((i) => Math.round(i.amount) === 5000));
  assert.equal(notYetPushed, true, 'gate serbest kalmadan elle eklenen gelir month.incomes içine düşmemeli');

  await page.evaluate(() => window.__raceReleaseGate());
  await page.waitForFunction(() => window.__raceLoadMonthResolved === true, { timeout: 10000 });
  await page.waitForFunction(() => month.incomes.some((i) => Math.round(i.amount) === 5000), { timeout: 10000 });
  await page.waitForFunction(() => typeof _monthRolloverInFlight !== 'undefined' && _monthRolloverInFlight === null, { timeout: 10000 });
  // Her iki taraf da (visibilitychange'in tetiklediği IIFE + addIncomeBtn handler'ının kendi
  // devamı) mikro-görev kuyruğunda ayrışabildiği için son bir tık bekleyip son duruma bakıyoruz.
  await page.waitForFunction(() => month.incomes.length >= 2, { timeout: 10000 });

  const r = await page.evaluate(async (oldKey) => {
    flushPendingPersistence(); // bkz. RACE-01'deki aynı gerekçe: debounce'lu yazmayı okumadan önce flush et
    const newKey = monthKey;
    const newRecord = await FullBudgetDataService.loadMonth(newKey);
    return {
      liveMonthKey: monthKey,
      liveIncomeAmounts: month.incomes.map((i) => Math.round(i.amount)).sort((a, b) => a - b),
      lastAutoMonth: persistent.lastAutoMonth,
      newRecordIncomeAmounts: newRecord && newRecord.incomes ? newRecord.incomes.map((i) => Math.round(i.amount)).sort((a, b) => a - b) : null,
    };
  }, oldMonthKey);

  assert.equal(r.liveMonthKey, newMonthKey, 'aktif monthKey yeni aya geçmiş olmalı');
  assert.deepEqual(r.liveIncomeAmounts, [5000, 30000],
    `recurring şablon TAM BİR KEZ + race sırasında eklenen gelir birlikte bulunmalı, gerçek: ${JSON.stringify(r.liveIncomeAmounts)}`);
  assert.equal(r.lastAutoMonth, newMonthKey, 'lastAutoMonth yeni aya güncellenmeli (otomasyon çalıştı)');
  assert.deepEqual(r.newRecordIncomeAmounts, [5000, 30000],
    `disk kaydı da aynı iki geliri (duplicate/kayıp olmadan) içermeli, gerçek: ${JSON.stringify(r.newRecordIncomeAmounts)}`);

  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});
