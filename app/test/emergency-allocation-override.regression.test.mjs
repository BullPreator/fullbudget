// EMERGENCY ALLOCATION OVERRIDE — kullanıcının "bu ay gerçekçi olarak ayırabileceğim tutar"ı
// canonical Goal & Cash Allocation Engine'in waterfall'ına GİRDİ olarak vermesi.
// -----------------------------------------------------------------------------------------
// Denetim: mevcut acil fon tahsisi runGoalCashAllocationEngine()'ın ADIM 2'sinde
// (emergency_fund_contribution) hesaplanıyor: amt = min(remaining, stillShort) — stillShort =
// emergencyGap - protectedCash. Bu HER ZAMAN "elden geldiğince kapat" mantığıyla, kullanıcının
// o ay gerçekten ayırabileceği tutarı hiç sormadan çalışıyordu. Bu değişiklik:
//   - runDecisionEngineV2()/runGoalCashAllocationEngine()'ın kendisine YENİ bir motor EKLEMEDİ,
//     yalnızca ADIM 2'nin GİRDİSİNİ (hesaplanan varsayılan yerine, varsa kullanıcı override'ı)
//     değiştirdi — waterfall'ın YAPISI (sıra, diğer adımlar, remaining zinciri) AYNEN duruyor.
//   - Override, month.emergencyAllocationOverride'da (yalnızca CARİ AYA ait — month, ay
//     değişince MONTH_KEY rotasyonuyla sıfırlanır) tutulur; buildMonthlySnapshot() bunu
//     snapshot.emergencyAllocationOverride olarak taşır, emergencyGap/protectedCash/
//     emergencyTarget3'e HİÇ dokunmaz.
//   - Tahsis edilmeyen fark waterfall'ın `remaining` değişkeninde kalır ve borç/hedef/esnek-kalan
//     adımlarına doğal olarak akar (İKİNCİ bir allocation sistemi YOK).
//   - "Sıradaki Adımım" (ensureTodaysMoneyTask/reconcilePersistedEmergencyTask) ve günlük güvenli
//     harcama (getCanonicalFreeSpendingPoolTL) ZATEN aynı runGoalCashAllocationEngine() sonucunu
//     okuyor — bu dosyada YENİDEN senkronize edilmedi, var olan tek-kaynak mimarisi sayesinde
//     otomatik olarak hizalı kalıyorlar.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
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

// Stage'lerdeki (FAZ 3.20) acceptance senaryosuyla AYNI: income=120000, expenses=40000, debt=0,
// assets=0 -> protectedCash=12000, distributableCash=68000, stillShort(=hesaplanan varsayılan)=60000.
async function newSession(setup) {
  const page = await browser.newPage({ viewport: { width: 390, height: 1200 } });
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
  await page.evaluate(() => {
    persistent.accounts = [];
    persistent.debts = [];
    persistent.creditCards = [];
    persistent.goals = [];
    persistent.dailyMoneyTask = null;
    month.incomes = [{ id: 'i1', category: 'Maaş', amount: 120000 }];
    month.expenses = [{ id: 'e1', category: 'Diğer', amount: 40000, fixed: false }];
    month.emergencyAllocationOverride = null;
  });
  if (setup) await page.evaluate(setup);
  await page.evaluate(() => render());
  return { page, pageErrors };
}

async function openPlanDetail(page) {
  await page.evaluate(() => {
    const wrap = document.getElementById('planDetailWrap');
    if (wrap) wrap.hidden = false;
  });
}

// -----------------------------------------------------------------------
// EMERGENCY-OVERRIDE-01: varsayılan hesaplanan tahsis doğru
// -----------------------------------------------------------------------
test('EMERGENCY-OVERRIDE-01: override yokken hesaplanan varsayılan tahsis 60000', async () => {
  const { page, pageErrors } = await newSession();
  const r = await page.evaluate(() => {
    const allocation = runMonthlyGoalCashAllocationLive();
    const row = allocation.allocations.find(a => a.type === 'emergency_fund_contribution');
    return { amount: row ? row.amount : null, calculatedAmount: row ? row.calculatedAmount : null, isOverridden: row ? row.isOverridden : null, distributableCash: allocation.distributableCash };
  });
  assert.equal(r.distributableCash, 68000);
  assert.equal(Math.round(r.amount), 60000, `Beklenen varsayılan tahsis 60000, gerçek: ${r.amount}`);
  assert.equal(Math.round(r.calculatedAmount), 60000);
  assert.equal(r.isOverridden, false);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// -----------------------------------------------------------------------
// EMERGENCY-OVERRIDE-02: kullanıcı daha düşük tutar girince kalan distributable doğru geri dönüyor
// -----------------------------------------------------------------------
test('EMERGENCY-OVERRIDE-02: override=20000 iken kalan (long_term_or_flexible) 48000', async () => {
  const { page, pageErrors } = await newSession();
  await openPlanDetail(page);
  const r = await page.evaluate(() => {
    setEmergencyAllocationOverride('20000');
    const allocation = runMonthlyGoalCashAllocationLive();
    const emergencyRow = allocation.allocations.find(a => a.type === 'emergency_fund_contribution');
    const flexRow = allocation.allocations.find(a => a.type === 'long_term_or_flexible');
    return {
      emergencyAmount: emergencyRow ? emergencyRow.amount : null,
      isOverridden: emergencyRow ? emergencyRow.isOverridden : null,
      calculatedAmount: emergencyRow ? emergencyRow.calculatedAmount : null,
      flexAmount: flexRow ? flexRow.amount : 0,
      distributableCash: allocation.distributableCash,
    };
  });
  assert.equal(Math.round(r.emergencyAmount), 20000, `Emergency tahsisi 20000 olmalı, gerçek: ${r.emergencyAmount}`);
  assert.equal(r.isOverridden, true);
  assert.equal(Math.round(r.calculatedAmount), 60000, 'Hesaplanan varsayılan hâlâ ayrıca raporlanmalı');
  assert.equal(Math.round(r.flexAmount), 48000, `68000-20000=48000 waterfall'a geri dönmeli, gerçek: ${r.flexAmount}`);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// -----------------------------------------------------------------------
// EMERGENCY-OVERRIDE-03: kullanıcı daha yüksek tutar girince distributable cash'i aşamıyor
// -----------------------------------------------------------------------
test('EMERGENCY-OVERRIDE-03: override=999999 girilse bile tahsis distributableCash (68000) ile sınırlı', async () => {
  const { page, pageErrors } = await newSession();
  const r = await page.evaluate(() => {
    setEmergencyAllocationOverride('999999');
    const allocation = runMonthlyGoalCashAllocationLive();
    const emergencyRow = allocation.allocations.find(a => a.type === 'emergency_fund_contribution');
    return { emergencyAmount: emergencyRow ? emergencyRow.amount : null, distributableCash: allocation.distributableCash, unallocatedCash: allocation.unallocatedCash };
  });
  assert.equal(Math.round(r.emergencyAmount), 68000, `Tahsis distributableCash'i aşmamalı, gerçek: ${r.emergencyAmount}`);
  assert.ok(r.emergencyAmount <= r.distributableCash + 0.01, 'Tahsis distributableCash\'ten büyük olamaz');
  assert.equal(Math.round(r.unallocatedCash), 0);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// -----------------------------------------------------------------------
// EMERGENCY-OVERRIDE-04: override sadece ilgili aya ait
// -----------------------------------------------------------------------
test('EMERGENCY-OVERRIDE-04: override yalnızca month nesnesinde tutulur, persistent\'e/başka bir aya YAZILMAZ', async () => {
  const { page, pageErrors } = await newSession();
  const r = await page.evaluate(() => {
    setEmergencyAllocationOverride('20000');
    const carriesOnMonth = month.emergencyAllocationOverride === 20000;
    const notOnPersistent = !('emergencyAllocationOverride' in persistent);
    // Ay değişimini simüle et: yeni bir 'month' nesnesi (gerçek uygulamanın ay-rotasyon
    // mantığıyla AYNI şekilde, bkz. index.html ~16700 civarı "month = {incomes:[],...}").
    const freshMonth = normalizeMonthFinancialFields({ incomes: [], expenses: [], goal: { type: 'save', amount: 0 } });
    return { carriesOnMonth, notOnPersistent, freshMonthOverride: freshMonth.emergencyAllocationOverride };
  });
  assert.equal(r.carriesOnMonth, true, 'override cari ayın month nesnesinde tutulmalı');
  assert.equal(r.notOnPersistent, true, 'override persistent (aylar-arası kalıcı state) içine YAZILMAMALI');
  assert.equal(r.freshMonthOverride, null, 'yeni/taze bir ay override\'ı DEVRALMAMALI');
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// -----------------------------------------------------------------------
// EMERGENCY-OVERRIDE-05: override kaldırılınca default hesaplamaya dönüyor
// -----------------------------------------------------------------------
test('EMERGENCY-OVERRIDE-05: override temizlenince (boş string) tahsis tekrar hesaplanan 60000\'e döner', async () => {
  const { page, pageErrors } = await newSession();
  const r = await page.evaluate(() => {
    setEmergencyAllocationOverride('20000');
    const overridden = runMonthlyGoalCashAllocationLive().allocations.find(a => a.type === 'emergency_fund_contribution').amount;
    setEmergencyAllocationOverride(''); // reset
    const afterReset = runMonthlyGoalCashAllocationLive().allocations.find(a => a.type === 'emergency_fund_contribution');
    return { overridden, afterResetAmount: afterReset.amount, afterResetIsOverridden: afterReset.isOverridden, monthField: month.emergencyAllocationOverride };
  });
  assert.equal(Math.round(r.overridden), 20000);
  assert.equal(Math.round(r.afterResetAmount), 60000, `Reset sonrası varsayılana dönmeli, gerçek: ${r.afterResetAmount}`);
  assert.equal(r.afterResetIsOverridden, false);
  assert.equal(r.monthField, null);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// -----------------------------------------------------------------------
// EMERGENCY-OVERRIDE-06: Sıradaki Adımım ve canonical allocation aynı tutarı gösteriyor
// -----------------------------------------------------------------------
test('EMERGENCY-OVERRIDE-06: override sonrası "Sıradaki Adımım" canonical emergency tahsisiyle senkron', async () => {
  const { page, pageErrors } = await newSession();
  const r = await page.evaluate(() => {
    setEmergencyAllocationOverride('20000'); // zaten render() tetikler (bkz. setEmergencyAllocationOverride)
    const allocation = runMonthlyGoalCashAllocationLive();
    const emergencyRow = allocation.allocations.find(a => a.type === 'emergency_fund_contribution');
    const task = persistent.dailyMoneyTask && persistent.dailyMoneyTask.task;
    return { canonicalAmount: emergencyRow.amount, taskAmount: task ? task.amount : null, taskCategory: task ? moneyTaskCategoryFromStep(task) : null };
  });
  assert.equal(r.taskCategory, 'acil_fon', `"Sıradaki Adımım" acil fon kategorisinde olmalı, gerçek: ${r.taskCategory}`);
  assert.equal(Math.round(r.taskAmount), Math.round(r.canonicalAmount), `Sıradaki Adımım (${r.taskAmount}) canonical (${r.canonicalAmount}) ile eşleşmeli`);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// -----------------------------------------------------------------------
// EMERGENCY-OVERRIDE-07: override sonrası canonical serbest/esnek (long_term_or_flexible) havuz
// beklenen tutarı yansıtır
// -----------------------------------------------------------------------
// RP-1 (2026-09): bu test eskiden Home ring'inin DOM'daki günlük tempo gösterimini
// (getCanonicalFreeSpendingPoolTL/computeSafeDailySpendTempo/#dailyAmountNum) de doğruluyordu;
// ring kaldırıldığı için o kısım çıkarıldı. ÇEKİRDEK doğrulama (override sonrası canonical
// GCAE'nin 'long_term_or_flexible' satırının doğru tutarı üretmesi) KORUNDU — artık ring-only
// yardımcı fonksiyon yerine doğrudan canonical allocation satırından okunuyor.
test('EMERGENCY-OVERRIDE-07: override=20000 iken canonical serbest/esnek kalan (long_term_or_flexible=48000) doğru', async () => {
  const { page, pageErrors } = await newSession();
  await page.evaluate(() => { setEmergencyAllocationOverride('20000'); });
  const r = await page.evaluate(() => {
    const allocation = runMonthlyGoalCashAllocationLive();
    const flexRow = allocation.allocations.find(a => a && a.type === 'long_term_or_flexible');
    const pool = flexRow ? Math.max(0, Number(flexRow.amount) || 0) : 0;
    return { pool };
  });
  assert.equal(Math.round(r.pool), 48000, `Serbest/esnek kalan 48000 olmalı, gerçek: ${r.pool}`);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// -----------------------------------------------------------------------
// EMERGENCY-OVERRIDE-08: sayfa yenileme sonrası override korunuyor
// -----------------------------------------------------------------------
test('EMERGENCY-OVERRIDE-08: override persist edilir ve sayfa yenilenince (aynı ay) korunur', async () => {
  const { page, pageErrors } = await newSession();
  await page.evaluate(async () => {
    setEmergencyAllocationOverride('20000');
    // persistMonth() 250ms debounce'lu — testte gerçek storage yazımını bekle.
    await new Promise(r => setTimeout(r, 500));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(800); // storage'dan yükleme + ilk render
  const r = await page.evaluate(() => ({
    monthField: month.emergencyAllocationOverride,
  }));
  assert.equal(Math.round(r.monthField), 20000, `Sayfa yenileme sonrası override korunmalı, gerçek: ${r.monthField}`);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// -----------------------------------------------------------------------
// EK: UI — input, hedef/korunan/kalan-ihtiyaç satırları ve "zorunlu" dilinin YOKLUĞU
// -----------------------------------------------------------------------
test('EK: Acil Fon override UI\'ı Hedef/Korunan nakit/Kalan ihtiyaç gösterir ve zorlayıcı dil kullanmaz', async () => {
  const { page, pageErrors } = await newSession();
  await openPlanDetail(page);
  const r = await page.evaluate(() => {
    render();
    const wrapText = document.getElementById('planPriorityGap').innerText;
    const input = document.getElementById('emergencyAllocOverrideInput');
    return { wrapText, inputValue: input ? input.value : null, hasInput: !!input };
  });
  assert.equal(r.hasInput, true, 'emergencyAllocOverrideInput DOM\'da bulunmalı');
  assert.equal(Math.round(Number(r.inputValue)), 60000, `Input varsayılan olarak hesaplanan tutarla dolu gelmeli, gerçek: ${r.inputValue}`);
  assert.ok(/Hedef/.test(r.wrapText) && /Korunan nakit/.test(r.wrapText) && /Kalan ihtiyaç/.test(r.wrapText), `Beklenen satırlar eksik: ${r.wrapText}`);
  assert.ok(!/zorunlu|yeterli|doğru karar|harcamalısın/i.test(r.wrapText), `Metin zorlayıcı/yönlendirici dil içermemeli: ${r.wrapText}`);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});
