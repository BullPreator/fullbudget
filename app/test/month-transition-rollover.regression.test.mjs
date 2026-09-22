// P0-1 (audit fix — stale monthKey / month transition):
// -----------------------------------------------------------------------------------------
// Denetim: now/monthKey/MONTH_KEY yalnızca sayfa yüklenirken bir kez hesaplanıyordu (const,
// index.html'de ~5349). Uygulama açık bırakılıp gerçek takvim ayı değişirse (özellikle PWA
// olarak günlerce kapatılmadan), monthKey hiç güncellenmiyor ve yeni girilen işlemler YANLIŞ
// (eski) aya yazılmaya devam ediyordu. Bu değişiklik:
//   - YENİ bir ay-geçişi mimarisi KURMADI — loadState()'in "ay verisini yükle" mantığını
//     (kasıtlı küçük bir kod tekrarıyla) ve runMonthlyAutomation()'ın KENDİSİNİ (motor
//     matematiğine dokunmadan) yeniden kullanan yeni bir checkMonthRollover() fonksiyonu
//     ekledi.
//   - now/monthKey/MONTH_KEY/daysInMonth/dayOfMonth/daysLeft `const`'tan `let`'e çevrildi
//     (yalnızca bu altı bildirim) — checkMonthRollover() bunları ay gerçekten değiştiğinde
//     günceller, aksi halde davranış AYNEN eskisi gibi sabit kalır.
//   - checkMonthRollover() üç noktadan çağrılıyor: visibilitychange→visible, gelir "ekle"
//     butonu, gider "ekle" butonu (her ikisi de artık async).
//   - runDecisionEngineV2()/runGoalCashAllocationEngine()'a HİÇ dokunulmadı.
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

// Sayfanın KENDİ script'i yüklenirken `new Date()` bu sabit tarihi görsün diye - navigasyondan
// ÖNCE eklenen bir init-script. Playwright her navigate/reload'da yeniden enjekte eder, yani
// bir reload sonrası da aynı sahte tarih geçerli kalır (gerçek dünyada "saat gerçekten o anı
// gösteriyor" durumunun eşdeğeri).
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

// pinnedIso verilirse sayfa BAŞTAN o tarihte yüklenmiş gibi davranır (addInitScript - reload'a
// da hayatta kalır). Verilmezse gerçek sistem saatiyle yüklenir.
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

// -----------------------------------------------------------------------
// ROLLOVER-01: ay değişmediyse checkMonthRollover() no-op
// -----------------------------------------------------------------------
test('ROLLOVER-01: gerçek ay değişmediyse checkMonthRollover() hiçbir şey yapmaz', async () => {
  const { page, pageErrors } = await newSession();
  const r = await page.evaluate(async () => {
    const before = { monthKey, incomesLen: month.incomes.length };
    const changed = await checkMonthRollover();
    return { changed, before, after: { monthKey, incomesLen: month.incomes.length } };
  });
  assert.equal(r.changed, false);
  assert.equal(r.after.monthKey, r.before.monthKey);
  assert.equal(r.after.incomesLen, r.before.incomesLen);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// -----------------------------------------------------------------------
// ROLLOVER-02: gerçek ay değiştiğinde monthKey/MONTH_KEY/daysLeft doğru güncelleniyor
// -----------------------------------------------------------------------
test('ROLLOVER-02: ay değiştiğinde monthKey/MONTH_KEY/daysInMonth/dayOfMonth/daysLeft tazeleniyor', async () => {
  const { page, pageErrors } = await newSession();
  const r = await page.evaluate(async () => {
    const oldMonthKey = monthKey;
    const [y, m] = oldMonthKey.split('-').map(Number);
    const nm = m === 12 ? 1 : m + 1;
    const ny = m === 12 ? y + 1 : y;
    const fakeIso = `${ny}-${String(nm).padStart(2, '0')}-05T10:00:00`;
    const RealDate = Date;
    class FakeDate extends RealDate {
      constructor(...args) { if (args.length === 0) super(fakeIso); else super(...args); }
      static now() { return new RealDate(fakeIso).getTime(); }
    }
    window.Date = FakeDate;
    const changed = await checkMonthRollover();
    return {
      changed, oldMonthKey,
      newMonthKey: monthKey, newMONTH_KEY: MONTH_KEY,
      dayOfMonth, daysInMonth, daysLeft,
      expectedNewMonthKey: `${ny}-${String(nm).padStart(2, '0')}`,
    };
  });
  assert.equal(r.changed, true);
  assert.equal(r.newMonthKey, r.expectedNewMonthKey, 'monthKey yeni aya güncellenmeli');
  assert.equal(r.newMONTH_KEY, `budget:${r.expectedNewMonthKey}`);
  assert.equal(r.dayOfMonth, 5);
  assert.ok(r.daysLeft > 0 && r.daysLeft <= r.daysInMonth, 'daysLeft tutarlı yeniden hesaplanmalı');
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// -----------------------------------------------------------------------
// ROLLOVER-03 (Senaryo A/B/C): app açıkken ay değişiyor, yeni işlem YENİ aya yazılıyor,
// ESKİ ayın verisi bozulmuyor.
// -----------------------------------------------------------------------
test('ROLLOVER-03: ay değiştikten sonra eklenen gelir doğru (yeni) aya kaydediliyor, eski ay bozulmuyor', async () => {
  const { page, pageErrors } = await newSession();

  // Senaryo A: uygulama "ayın son günü" açık — eski ayda gerçek bir kayıt var ve DİSKE yazılmış.
  const setup = await page.evaluate(async () => {
    const oldMonthKey = monthKey;
    month.incomes = [{ id: 'old-i1', category: 'Maaş', amount: 50000, note: '', recurring: false, accountId: '' }];
    month.expenses = [];
    await FullBudgetDataService.saveMonth(oldMonthKey, month);
    return { oldMonthKey };
  });

  // Senaryo B: saat yeni aya geçiyor (sahte Date, sayfa hâlâ açık — reload YOK).
  const fakeIso = nextMonthIso(setup.oldMonthKey);
  await page.evaluate((iso) => {
    const RealDate = Date;
    class FakeDate extends RealDate {
      constructor(...args) { if (args.length === 0) super(iso); else super(...args); }
      static now() { return new RealDate(iso).getTime(); }
    }
    window.Date = FakeDate;
  }, fakeIso);

  // "Gelir" sekmesine geç (uygulamanın kendi qa-shortcut mekanizmasıyla, index.html:2908).
  await page.evaluate(() => executeQuickAction({ tab: 'income', section: 'gelirin', focus: 'incomeAmountInput' }));
  await page.waitForTimeout(200);

  // Senaryo C: yeni bir gelir işlemi ekleniyor (addIncomeBtn tıklanıyor — handler artık
  // checkMonthRollover()'ı kendi içinde await ediyor, ayrıca çağırmaya gerek yok).
  await page.fill('#incomeAmountInput', '7500');
  await page.click('#addIncomeBtn');
  await page.waitForTimeout(300);

  const r = await page.evaluate(async (oldMonthKey) => {
    const newMonthKey = monthKey;
    const oldRecord = await FullBudgetDataService.loadMonth(oldMonthKey);
    const newRecord = await FullBudgetDataService.loadMonth(newMonthKey);
    return {
      liveMonthKey: monthKey,
      liveIncomesLen: month.incomes.length,
      liveIncomeAmount: month.incomes[0] ? month.incomes[0].amount : null,
      oldRecordIncomes: oldRecord ? oldRecord.incomes : null,
      newRecordIncomes: newRecord ? newRecord.incomes : null,
    };
  }, setup.oldMonthKey);

  assert.notEqual(r.liveMonthKey, setup.oldMonthKey, 'aktif monthKey yeni aya geçmeli');
  assert.equal(r.liveIncomesLen, 1, 'yeni ay sadece yeni eklenen geliri içermeli (eskisi taşınmamalı)');
  assert.equal(Math.round(r.liveIncomeAmount), 7500);
  assert.ok(r.newRecordIncomes && r.newRecordIncomes.length === 1 && Math.round(r.newRecordIncomes[0].amount) === 7500,
    `yeni gelir doğru (yeni) ayın diskteki kaydına yazılmalı, gerçek: ${JSON.stringify(r.newRecordIncomes)}`);
  assert.ok(r.oldRecordIncomes && r.oldRecordIncomes.length === 1 && Math.round(r.oldRecordIncomes[0].amount) === 50000,
    `eski ayın diskteki kaydı BOZULMAMALI/kaybolmamalı, gerçek: ${JSON.stringify(r.oldRecordIncomes)}`);

  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// -----------------------------------------------------------------------
// ROLLOVER-04: rollover birden fazla kez tetiklenirse recurring şablonlar TEKRAR eklenmiyor
// -----------------------------------------------------------------------
test('ROLLOVER-04: checkMonthRollover() art arda iki kez çalışırsa recurring gelir ikinci kez eklenmiyor', async () => {
  const { page, pageErrors } = await newSession();
  const oldMonthKey = await page.evaluate(() => monthKey);
  await page.evaluate(() => {
    persistent.recurringIncomes = [{ category: 'Maaş', amount: 30000, note: '', accountId: '' }];
  });
  const fakeIso = nextMonthIso(oldMonthKey);
  await page.evaluate((iso) => {
    const RealDate = Date;
    class FakeDate extends RealDate {
      constructor(...args) { if (args.length === 0) super(iso); else super(...args); }
      static now() { return new RealDate(iso).getTime(); }
    }
    window.Date = FakeDate;
  }, fakeIso);

  const r = await page.evaluate(async () => {
    const first = await checkMonthRollover();
    const afterFirstLen = month.incomes.length;
    const afterFirstLastAuto = persistent.lastAutoMonth;
    const second = await checkMonthRollover(); // aynı ay için tekrar çağrı — no-op olmalı
    return {
      first, second,
      afterFirstLen, afterFirstLastAuto,
      afterSecondLen: month.incomes.length,
      finalMonthKey: monthKey,
    };
  });

  assert.equal(r.first, true, 'ilk çağrı rollover yapmalı');
  assert.equal(r.afterFirstLen, 1, 'recurring gelir bir kez eklenmeli');
  assert.equal(r.afterFirstLastAuto, r.finalMonthKey, 'lastAutoMonth yeni aya güncellenmeli');
  assert.equal(r.second, false, 'ikinci çağrı ay zaten güncel olduğu için no-op dönmeli');
  assert.equal(r.afterSecondLen, 1, 'recurring gelir İKİNCİ KEZ eklenmemeli (duplicate olmamalı)');
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// -----------------------------------------------------------------------
// ROLLOVER-05: Canlı rollover'dan SONRA sayfa yenilenirse (aynı yeni ay) tekrar/yanlış
// bir otomasyon çalışmıyor, veri kaybolmuyor.
// -----------------------------------------------------------------------
test('ROLLOVER-05: canlı rollover sonrası reload aynı ayı tekrar yanlış işlemiyor (duplicate yok)', async () => {
  const { page, pageErrors } = await newSession();
  const oldMonthKey = await page.evaluate(() => monthKey);
  await page.evaluate(() => {
    persistent.recurringIncomes = [{ category: 'Maaş', amount: 22000, note: '', accountId: '' }];
  });

  const fakeIso = nextMonthIso(oldMonthKey);
  // 1) Canlı oturumda (reload YOK) ay değişimini tetikle.
  await page.evaluate((iso) => {
    const RealDate = Date;
    class FakeDate extends RealDate {
      constructor(...args) { if (args.length === 0) super(iso); else super(...args); }
      static now() { return new RealDate(iso).getTime(); }
    }
    window.Date = FakeDate;
  }, fakeIso);
  await page.evaluate(() => checkMonthRollover());

  const beforeReload = await page.evaluate(() => ({
    monthKey, incomesLen: month.incomes.length, lastAutoMonth: persistent.lastAutoMonth,
  }));
  assert.equal(beforeReload.incomesLen, 1);

  // 2) Sayfayı, saat HÂLÂ yeni ayı gösteriyormuş gibi (gerçek dünyada zaman geriye gitmez)
  //    yeniden yükle — normal loadState()/runMonthlyAutomation() yolu tekrar çalışacak.
  await page.addInitScript(pinDateInitScript(fakeIso), fakeIso);
  await page.reload({ waitUntil: 'load' });
  await dismissOverlays(page);
  await page.waitForTimeout(300);

  const afterReload = await page.evaluate(() => ({
    monthKey, incomesLen: month.incomes.length, lastAutoMonth: persistent.lastAutoMonth,
  }));

  assert.equal(afterReload.monthKey, beforeReload.monthKey, 'reload sonrası aynı (yeni) ayda kalınmalı');
  assert.equal(afterReload.incomesLen, 1, `reload recurring geliri İKİNCİ KEZ eklememeli, gerçek: ${afterReload.incomesLen}`);
  assert.equal(afterReload.lastAutoMonth, beforeReload.lastAutoMonth);

  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});
