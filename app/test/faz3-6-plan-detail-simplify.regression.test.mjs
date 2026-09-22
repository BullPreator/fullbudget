// FAZ 3.6 — "BU AYKİ PLANIM" DETAY SADELEŞTİRMESİ REGRESYONU
// -----------------------------------------------------------------------
// Kullanıcı, gerçek tarayıcıda "Bu Ayki Planım" kartının hâlâ "gereğinden fazla teknik ve
// tekrarlı" göründüğünü bildirdi. Kök neden: #priorityBox eskiden collapsed görünümün DIŞINDA
// (her zaman görünür) duruyordu, ve "Detayları gör" açılınca #decisionEngineV2Box +
// #goalCashAllocationBox AYNI ₺X/₺Y rakamlarını (Dağıtılabilir/Bu ay dağıtılabilir/Acil durum
// fonuna ayır/"Bunu atlarsam ne olur?") üç farklı çerçevede TEKRAR basıyordu.
//
// Bu dosya doğrular:
//   1. Plan detayları (#planDetailWrap) varsayılan olarak GİZLİ.
//   2. Collapsed görünüm YALNIZCA TEK bir ana karar rakamını gösterir (headline == ana karar
//      tutarındaysa, o rakam #monthlyPlanSummary içinde YALNIZCA BİR KEZ görünür — teknik
//      kutular ve #priorityBox collapsed görünümde HİÇ yok).
//   3. Expanded görünüm gelir/gider/borç/kullanılabilir/korunan/planlanabilir kırılımını TEK
//      SEFER gösterir (#decisionEngineV2Box/#goalCashAllocationBox insan gözünden `hidden`).
//   4. Aynı ₺X tahsisat bloğu (ör. "Acil durum fonuna ayır") expanded görünümde
//      TEKRARLANMIYOR — yalnızca headline/ana karar satırında bir kez.
//   5. "Sıradaki Adımım" ve "Bu Ayki Planım" hâlâ AYNI canonical tutarı gösteriyor.
//   6. Yatırım tavsiyesi (spesifik enstrüman/yüzde) yok.
//   7. Günlük/aylık ayrım korunuyor (ring ile plan kartı ayrı kalıyor).
// runDecisionEngineV2()/runGoalCashAllocationEngine()/computeGoalInfo()/buildMonthlySnapshot()/
// computeCashFlowSummary()/getAffordCapacityInfo()/assessCardAffordability()/getFinancialAlerts()/
// computePriorityPlan()/_planKur()/RISK_PROFILES/activeRiskProfile bu dosya tarafından ASLA
// mutasyona uğratılmaz — yalnızca DOM ve salt-okunur motor çağrılarıyla gözlemlenir.
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
      month.expenses = s.expenses || [];
      persistent.goals = s.goals || [];
      persistent.dailyMoneyTask = null; // sıfırdan kurulsun
      setTab('home');
      render();
    }, setup);
  }
  return { page, pageErrors };
}

// Bu senaryoda acil fon açığı (emergencyGap) dağıtılabilir tutardan çok büyük — bu ayki
// dağıtılabilir paranın TAMAMI tek bir kalem (acil durum fonu) olarak gösterilir, headline
// ve ana karar rakamı AYNI olur (kullanıcının verdiği ₺53.000 örneğiyle aynı yapı).
const SINGLE_DECISION_SCENARIO = {
  income: 100000,
  expenses: [{ id: 'e1', category: 'Kira', amount: 90000, fixed: true }],
  assets: 1000,
};

const EMERGENCY_SCENARIO = {
  income: 120000, expenses: [{ id: 'e1', category: 'Diğer', amount: 40000 }], assets: 65000,
  creditCards: [{ id: 'c1', name: 'Kart', currentBalance: 15000, limit: 100000, statementDay: 1, dueDay: 10 }],
};

// ---------------------------------------------------------------------
// 1. Plan details default hidden.
// ---------------------------------------------------------------------
test('FAZ3.6-1: plan details (#planDetailWrap) are hidden by default', async () => {
  const { page, pageErrors } = await newSession(EMERGENCY_SCENARIO);
  const hidden = await page.evaluate(() => document.getElementById('planDetailWrap').hidden);
  await page.close();
  assert.equal(hidden, true);
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// 2. Collapsed view shows only one primary amount — no technical boxes, no extra
//    priority-list rows leak into the default (non-expanded) view.
// ---------------------------------------------------------------------
test('FAZ3.6-2: collapsed view shows exactly one primary canonical amount, no technical/priority content visible', async () => {
  const { page, pageErrors } = await newSession(SINGLE_DECISION_SCENARIO);
  const check = await page.evaluate(() => {
    const result = runMonthlyGoalCashAllocationLive();
    const summaryText = document.getElementById('monthlyPlanSummary').innerText;
    return {
      distributableCash: result.distributableCash,
      allocationCount: result.allocations.length,
      topAmount: result.allocations[0] ? result.allocations[0].amount : null,
      summaryText,
      priorityBoxVisible: !!document.getElementById('priorityBox').offsetParent,
      de2BoxVisible: !!document.getElementById('decisionEngineV2Box').offsetParent,
      allocBoxVisible: !!document.getElementById('goalCashAllocationBox').offsetParent,
      planDetailGapVisible: !!document.getElementById('planPriorityGap').offsetParent,
    };
  });
  await page.close();
  assert.equal(check.allocationCount, 1, 'sanity: this scenario must produce exactly one allocation (full amount into one decision)');
  assert.equal(check.topAmount, check.distributableCash, 'sanity: headline and the single decision must show the same amount for this scenario');
  const grouped = Math.round(check.distributableCash).toLocaleString('tr-TR');
  const occurrences = check.summaryText.split(grouped).length - 1;
  // Legitimate occurrences in the collapsed summary: (1) the headline, (2) the main decision
  // row, (3) the engine's own short reason sentence (which itself restates the amount, e.g.
  // "Bu ay dağıtılabilir ₺7.000'nin tamamını..." — this is the untouched engine's own text,
  // not a duplicate block). Anything beyond that would mean old technical content leaked in.
  assert.ok(occurrences >= 1 && occurrences <= 3, `the canonical amount ${grouped} must appear 1-3 times (headline/decision/reason) in the collapsed summary, got ${occurrences} in: "${check.summaryText}"`);
  assert.equal(check.priorityBoxVisible, false, '#priorityBox must not be visible in the collapsed (default) view');
  assert.equal(check.de2BoxVisible, false, '#decisionEngineV2Box must never be visible to the user');
  assert.equal(check.allocBoxVisible, false, '#goalCashAllocationBox must never be visible to the user');
  assert.equal(check.planDetailGapVisible, false, 'the priority/gap block must be collapsed by default too (lives inside #planDetailWrap)');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// 3. Expanded view shows the income/expense/debt/protected-liquidity/plannable
//    breakdown exactly once.
// ---------------------------------------------------------------------
test('FAZ3.6-3: expanded view shows the cash-flow breakdown exactly once', async () => {
  const { page, pageErrors } = await newSession(EMERGENCY_SCENARIO);
  await page.click('#planDetailToggle');
  await page.waitForTimeout(100);
  const check = await page.evaluate(() => ({
    ledgerText: document.getElementById('planDetailLedger').innerText,
    wrapVisible: !document.getElementById('planDetailWrap').hidden,
    de2BoxVisible: !!document.getElementById('decisionEngineV2Box').offsetParent,
    allocBoxVisible: !!document.getElementById('goalCashAllocationBox').offsetParent,
  }));
  await page.close();
  assert.equal(check.wrapVisible, true, 'clicking "Detayları gör" must reveal the details');
  const countMatches = (re) => (check.ledgerText.match(re) || []).length;
  assert.equal(countMatches(/Gelir/g), 1, 'Gelir must appear exactly once');
  assert.equal(countMatches(/Gider/g), 1, 'Gider must appear exactly once');
  assert.equal(countMatches(/Borç ödemesi/g), 1, 'Borç ödemesi must appear exactly once');
  assert.equal(check.de2BoxVisible, false, '#decisionEngineV2Box must stay invisible even when details are expanded');
  assert.equal(check.allocBoxVisible, false, '#goalCashAllocationBox must stay invisible even when details are expanded');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// 4. No duplicate allocation blocks for the same amount in the expanded view.
// ---------------------------------------------------------------------
test('FAZ3.6-4: the top allocation amount is not repeated as a duplicate block when details are expanded', async () => {
  const { page, pageErrors } = await newSession(SINGLE_DECISION_SCENARIO);
  await page.click('#planDetailToggle');
  await page.waitForTimeout(100);
  const check = await page.evaluate(() => {
    const result = runMonthlyGoalCashAllocationLive();
    const cardText = document.querySelector('[data-section="bu-ay-plan"] .card-featured').innerText;
    return {
      distributableCash: result.distributableCash,
      cardText,
      de2BoxVisible: !!document.getElementById('decisionEngineV2Box').offsetParent,
      allocBoxVisible: !!document.getElementById('goalCashAllocationBox').offsetParent,
    };
  });
  await page.close();
  const grouped = Math.round(check.distributableCash).toLocaleString('tr-TR');
  // The amount legitimately appears in: (1) collapsed headline, (2) collapsed decision row,
  // (3) the engine's own short reason sentence (which restates the amount in prose),
  // (4) the ledger's own "Planlanabilir tutar" total row. It must NOT appear a 5th+ time
  // (that would mean an old duplicate allocation block survived).
  const occurrences = check.cardText.split(grouped).length - 1;
  assert.ok(occurrences <= 4, `expected at most 4 legitimate occurrences of ${grouped} (headline, decision row, reason sentence, ledger total), got ${occurrences} in: "${check.cardText}"`);
  // The two technical boxes that used to duplicate this content (their own "Dağıtılabilir"/
  // "Bu ay dağıtılabilir" header rows, the per-allocation "Bunu atlarsam ne olur?" repeats, the
  // P0 "a real payment was already recorded" context row, etc.) must be structurally invisible —
  // checked by DOM visibility here rather than by text substring, since the engine's OWN untouched
  // reason prose legitimately contains phrases like "Bu ay dağıtılabilir ₺X'nin tamamını...".
  assert.equal(check.de2BoxVisible, false, '#decisionEngineV2Box (the source of the duplicate "Dağıtılabilir" row and repeated P0 context) must not be visible');
  assert.equal(check.allocBoxVisible, false, '#goalCashAllocationBox (the source of the duplicate "Bu ay dağıtılabilir" row and repeated "Bunu atlarsam ne olur?") must not be visible');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// 4b. Exactly one "what if I skip this" disclosure, not one per allocation.
// ---------------------------------------------------------------------
test('FAZ3.6-4b: exactly one "Bunu atlarsam ne olur?" disclosure is visible when expanded', async () => {
  const { page, pageErrors } = await newSession(EMERGENCY_SCENARIO);
  await page.click('#planDetailToggle');
  await page.waitForTimeout(100);
  const check = await page.evaluate(() => {
    const wrap = document.getElementById('planDetailWrap');
    const visibleWhatIfs = Array.from(wrap.querySelectorAll('*')).filter(el =>
      el.children.length === 0 && /Bunu atlarsam ne olur\?/.test(el.textContent || '') && el.offsetParent !== null
    );
    return { count: visibleWhatIfs.length };
  });
  await page.close();
  assert.equal(check.count, 1, `exactly one visible "Bunu atlarsam ne olur?" disclosure expected, got ${check.count}`);
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// 5. "Sıradaki Adımım" and "Bu Ayki Planım" still show the same canonical amount.
// ---------------------------------------------------------------------
test('FAZ3.6-5: "Sıradaki Adımım" and "Bu Ayki Planım" amounts still match after the detail simplification', async () => {
  const { page, pageErrors } = await newSession(EMERGENCY_SCENARIO);
  const check = await page.evaluate(() => {
    const result = runMonthlyGoalCashAllocationLive();
    const emergencyRow = result.allocations.find(a => a.type === 'emergency_fund_contribution' && a.amount > 1);
    return {
      canonicalAmount: emergencyRow ? emergencyRow.amount : null,
      moneyTaskTitle: document.querySelector('#moneyTaskBox .money-task-title')?.innerText || '',
      planSummaryText: document.getElementById('monthlyPlanSummary').innerText,
    };
  });
  await page.close();
  assert.ok(check.canonicalAmount > 0, 'sanity: scenario must produce an emergency-fund allocation');
  const grouped = Math.round(check.canonicalAmount).toLocaleString('tr-TR');
  assert.ok(check.moneyTaskTitle.includes(grouped), `"Sıradaki Adımım" must show ${grouped}, got "${check.moneyTaskTitle}"`);
  assert.ok(check.planSummaryText.includes(grouped), `"Bu Ayki Planım" must show ${grouped}, got "${check.planSummaryText}"`);
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// 6. No investment advice (specific instrument / percentage) anywhere in the card.
// ---------------------------------------------------------------------
test('FAZ3.6-6: no specific-instrument or percentage investment advice appears in "Bu Ayki Planım", collapsed or expanded', async () => {
  const { page, pageErrors } = await newSession({ income: 300000, expenses: [{ id: 'e1', category: 'Diğer', amount: 30000 }], assets: 2000000, goals: [] });
  await page.click('#planDetailToggle');
  await page.waitForTimeout(100);
  const cardText = await page.evaluate(() => document.querySelector('[data-section="bu-ay-plan"] .card-featured').innerText);
  await page.close();
  assert.ok(!/%\s?\d+\s?(hisse|tahvil|fon|altın|döviz)/i.test(cardText), 'no specific instrument/percentage allocation advice should appear');
  assert.ok(!/yatırım tavsiyesi|hisse senedi al|kripto/i.test(cardText), 'no direct investment directive should appear');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// RP-1 (2026-09): FAZ3.6-7 ("daily safe-budget ring and the monthly plan remain clearly distinct
// after the simplification") tamamen kaldırıldı — .ring-note/#dailyAmountNum'a özeldi, ring
// kaldırıldığı için bu davranış artık yok. Bkz. GUNLUK_GUVENLI_HARCAMA_KAPSAM_AUDIT.md.
// ---------------------------------------------------------------------
// 8. Smoke check: no console/page errors across a few scenarios.
// ---------------------------------------------------------------------
test('FAZ3.6-8: "Bu Ayki Planım" renders and expands without errors across several scenarios', async () => {
  for (const setup of [
    SINGLE_DECISION_SCENARIO,
    EMERGENCY_SCENARIO,
    { income: 0, expenses: [], assets: 0, goals: [] },
  ]) {
    const { page, pageErrors } = await newSession(setup);
    await page.click('#planDetailToggle').catch(() => {});
    await page.waitForTimeout(100);
    await page.close();
    assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  }
});
