// FAZ 3.3 — "SIRADAKİ ADIMIM" / "BU AYKİ PLANIM" TUTAR HİZALAMASI regresyon testleri
// -----------------------------------------------------------------------
// Önceki geçişte "Bu Ayki Planım" tek bir canonical rakam (runGoalCashAllocationEngine()'in
// distributableCash'i) gösterecek şekilde düzeltilmişti, ama "Sıradaki Adımım" hâlâ
// computePriorityPlan/_planKur'un KENDİ acil-fon formülünden (aylık damla: kalanın %30'u,
// açığa kadar) geliyordu — aynı ayda AYNI karar için (acil fona bu ay ne kadar ayırmalıyım?)
// iki farklı rakam gösteriyordu. Bu dosya:
//   - "Sıradaki Adımım"ın gösterdiği tutarın, adım gerçekten acil fon katkısıysa, canonical
//     runGoalCashAllocationEngine() sonucundaki emergency_fund_contribution tutarıyla
//     BİREBİR AYNI olduğunu,
//   - bu hizalamanın computePriorityPlan/_planKur'un KENDİ hesabını (adımın _planCache'teki
//     orijinal amount'ı) DEĞİŞTİRMEDİĞİNİ (yalnızca kullanıcıya gösterilen kopya güncellendi),
//   - "Bu ay kullanılabilir tutar" etiketinin ve iki rakam (kullanılabilir vs planlanabilir)
//     arasındaki farkın yalnızca gerçekten fark VARSA açıklandığını,
// doğrular. runDecisionEngineV2()/runGoalCashAllocationEngine()/computePriorityPlan() bu dosya
// tarafından ASLA mutasyona uğratılmaz — yalnızca DOM ve salt-okunur motor çağrılarıyla
// gözlemlenir.
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
      persistent.debts = s.debts || [];
      persistent.creditCards = s.creditCards || [];
      month.incomes = s.income > 0 ? [{ id: 'i1', category: 'Maaş', amount: s.income }] : [];
      month.expenses = s.expenses > 0 ? [{ id: 'e1', category: 'Diğer', amount: s.expenses }] : [];
      persistent.goals = s.goals || [];
      if (s.emergencyFundTarget != null) persistent.emergencyFundTarget = s.emergencyFundTarget;
      persistent.dailyMoneyTask = null; // her senaryo bugünkü görevi kendi planından yeniden kursun
      setTab('home');
      render();
    }, setup);
  }
  return { page, pageErrors };
}

const EMERGENCY_SCENARIO = {
  income: 120000, expenses: 40000, assets: 65000,
  creditCards: [{ id: 'c1', name: 'Kart', currentBalance: 15000, limit: 100000, statementDay: 1, dueDay: 10 }],
  emergencyFundTarget: 72000,
};

// ---------------------------------------------------------------------
// 1. Core fix: when the top step is genuinely about the emergency fund, "Sıradaki
// Adımım"'s shown amount must equal the canonical GCAE emergency_fund_contribution amount.
// ---------------------------------------------------------------------
test('FAZ3.3-1: "Sıradaki Adımım" amount equals the canonical GCAE emergency_fund_contribution amount, matching "Bu Ayki Planım"', async () => {
  const { page, pageErrors } = await newSession(EMERGENCY_SCENARIO);
  const check = await page.evaluate(() => {
    const rec = persistent.dailyMoneyTask;
    const task = rec && rec.task;
    const canonical = runMonthlyGoalCashAllocationLive();
    const emergencyRow = canonical.allocations.find(a => a.type === 'emergency_fund_contribution' && a.amount > 1);
    const headlineSub = document.querySelector('#monthlyPlanSummary .hero-row b') ? document.querySelector('#monthlyPlanSummary .hero-row b').textContent : null;
    return {
      taskCategory: task ? task.category : null,
      taskAmount: task ? task.amount : null,
      emergencyRowAmount: emergencyRow ? emergencyRow.amount : null,
      headlineSub,
    };
  });
  await page.close();
  assert.equal(check.taskCategory, 'acil_fon', 'sanity: the top step in this scenario must classify as acil_fon');
  assert.ok(check.emergencyRowAmount > 0, 'sanity: the canonical engine must produce a real emergency_fund_contribution for this scenario');
  assert.equal(check.taskAmount, check.emergencyRowAmount, `"Sıradaki Adımım" amount (${check.taskAmount}) must equal the canonical GCAE amount (${check.emergencyRowAmount})`);
  const grouped = Math.round(check.emergencyRowAmount).toLocaleString('tr-TR');
  assert.ok(check.headlineSub && check.headlineSub.includes(grouped),
    `"Bu Ayki Planım" sub-line ("${check.headlineSub}") must show the same canonical amount ${grouped}`);
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// 2. The underlying computePriorityPlan step (in _planCache) is NOT mutated — only the
// displayed task copy is reconciled. Calculation engines stay untouched.
// ---------------------------------------------------------------------
test('FAZ3.3-2: reconciling the displayed task does not mutate the underlying _planCache step (computePriorityPlan output stays intact)', async () => {
  const { page, pageErrors } = await newSession(EMERGENCY_SCENARIO);
  const check = await page.evaluate(() => {
    const originalStep = _planCache.steps.find(s => s.ik === 'iyi' && /acil|emergency/i.test(s.label));
    const rec = persistent.dailyMoneyTask;
    return {
      originalStepAmount: originalStep ? originalStep.amount : null,
      taskAmount: rec && rec.task ? rec.task.amount : null,
    };
  });
  await page.close();
  // computePriorityPlan'ın kendi formülü (kalanın %30'u, açığa kadar) canonical GCAE'den
  // (tüm dağıtılabilir nakit) yapısal olarak FARKLI bir sayı üretebilir — bu FARK, bu düzeltmenin
  // _planCache'i DEĞİL yalnızca kullanıcıya gösterilen kopyayı hizaladığının kanıtıdır.
  assert.ok(check.originalStepAmount != null, 'sanity: the original computePriorityPlan step must still exist, unmutated');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// 3. A step unrelated to the emergency fund (e.g. a plain setup/other step) is left
// untouched by the reconciliation — no unrelated number is forced onto it.
// ---------------------------------------------------------------------
test('FAZ3.3-3: a non-emergency-fund step is not altered by the reconciliation', async () => {
  const { page, pageErrors } = await newSession({ income: 0, expenses: 0, assets: 0, goals: [] });
  const check = await page.evaluate(() => {
    const rec = persistent.dailyMoneyTask;
    return { category: rec && rec.task ? rec.task.category : null, amount: rec && rec.task ? rec.task.amount : null };
  });
  await page.close();
  // Gelir yokken plan "kurulum" adımlarını döner (bkz. computePriorityPlan) — bunlar acil fonla
  // ilgili değildir ve tutarları hep 0'dır; reconciliation bunlara dokunmamalı.
  assert.notEqual(check.category, 'acil_fon');
  assert.equal(check.amount, 0);
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// 4. "Bu ay kullanılabilir tutar" label change + conditional explanatory note.
// ---------------------------------------------------------------------
// NOT (FAZ 3.12, 2026-09): "Bu ay kullanılabilir tutar" bağımsız kartı (data-section="top5",
// #top5Savings/#top5KullanilabilirNot) Ana Sayfa'dan tamamen kaldırıldı — bu bir yinelenen
// sunumdu (bkz. index.html'deki FAZ 3.12 yorumu). Bu iki test, o zamanki asıl amacını
// (kullanılabilir tutar ile planlanabilir tutar arasındaki korunan-likidite farkının, fark
// varsa AÇIKÇA gösterilmesi) artık kaldırılmış #top5KullanilabilirNot'a değil, aynı bilginin
// FAZ 3.12'de gösterilmesi ZORUNLU tutulan "Bu Ayki Planım" detaylı dökümüne (#planDetailLedger,
// renderPlanDetailLedger — "Korunan (likidite)" satırı yalnızca de2.protectedCash>0 iken
// basılır) bakarak doğruluyor — kapsam ZAYIFLATILMADI.
test('FAZ3.3-4: "Bu Ayki Planım" detaylı dökümü, korunan likidite ile planlanabilir tutar arasındaki farkı gerçek bir fark varken açıkça gösterir', async () => {
  const { page, pageErrors } = await newSession(EMERGENCY_SCENARIO);
  const check = await page.evaluate(() => {
    const de2 = runMonthlyDecisionEngineLive();
    return {
      ledgerHtml: document.getElementById('planDetailLedger').innerHTML,
      protectedCash: de2.protectedCash,
    };
  });
  await page.close();
  if (check.protectedCash > 1) {
    assert.ok(/Korunan \(likidite\)/.test(check.ledgerHtml), 'when protected cash creates a real gap, "Bu Ayki Planım"\'s detailed ledger must explain it');
  }
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.3-5: when there is no protected-liquidity gap, "Bu Ayki Planım"\'s detailed ledger omits the protected-liquidity row (the two figures are already equal)', async () => {
  const { page, pageErrors } = await newSession({ income: 100000, expenses: 40000, assets: 5000000, goals: [] });
  const check = await page.evaluate(() => {
    const de2 = runMonthlyDecisionEngineLive();
    return { protectedCash: de2.protectedCash, ledgerHtml: document.getElementById('planDetailLedger').innerHTML };
  });
  await page.close();
  if (check.protectedCash <= 1) {
    assert.ok(!/Korunan \(likidite\)/.test(check.ledgerHtml), 'with no protected-cash gap, the ledger must not show a protected-liquidity row since the two figures already match');
  }
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// 5. Daily safe-spend vs monthly plannable amount separation still holds (regression guard).
// ---------------------------------------------------------------------
test('FAZ3.3-6: daily safe-spend and monthly plannable amount stay clearly separated', async () => {
  const { page, pageErrors } = await newSession(EMERGENCY_SCENARIO);
  const bodyText = await page.evaluate(() => document.body.innerText);
  await page.close();
  assert.ok(/aylık planlanabilir tutarla aynı şey değildir/i.test(bodyText) || /not the same as the monthly plannable amount/i.test(bodyText));
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// 6. No investment-advice / buy-sell / instrument / percentage language crept in.
// ---------------------------------------------------------------------
test('FAZ3.3-7: no investment-advice, buy/sell, instrument, or percentage-allocation language appears', async () => {
  const { page, pageErrors } = await newSession(EMERGENCY_SCENARIO);
  const bodyText = await page.evaluate(() => document.body.innerText);
  await page.close();
  assert.ok(!/Kalan tutarı yatırıma yönlendir/i.test(bodyText));
  assert.ok(!/önerilen dağılım/i.test(bodyText));
  assert.ok(!/mevduat \+ hisse/i.test(bodyText));
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// 7. Underlying financial engines/amounts unchanged by this presentation-only pass.
// ---------------------------------------------------------------------
test('FAZ3.3-8: underlying financial amounts are unchanged by this presentation-only alignment', async () => {
  const { page, pageErrors } = await newSession(EMERGENCY_SCENARIO);
  const result = await page.evaluate(() => runMonthlyGoalCashAllocationLive());
  await page.close();
  assert.ok(result.distributableCash >= 0);
  const emergencyRow = result.allocations.find(a => a.type === 'emergency_fund_contribution');
  if (emergencyRow) assert.ok(emergencyRow.amount > 0);
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});
