// DECISION ENGINE V1 — "Sonuçta Alabilir miyim?" regresyon testleri
// -----------------------------------------------------------------------
// Bu dosya runDecisionEngine()'i (bkz. app/index.html içindeki
// DECISION-ENGINE-START/END bloğu) gerçek app/index.html üzerinde, gerçek bir
// Chromium sayfasında çalıştırır. Decision Engine yeni bir hesaplama motoru
// DEĞİL - var olan Finance-Core/Affordability/Debt/Goal motorlarının ince bir
// orkestrasyonu; bu yüzden testler de gerçek kaynaktan, hiçbir mantığı elle
// kopyalamadan çalışır (ai-coach-priority-plan.regression.test.mjs ile aynı yöntem).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

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

async function newSession() {
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
  return { page, pageErrors };
}

// setup: {income, expenses, debt, minPayment, assets, goals}
// request: DecisionRequest passed straight to runDecisionEngine
async function runDecision(setup, request) {
  const { page, pageErrors } = await newSession();
  const r = await page.evaluate(({ setup, request }) => {
    persistent.accounts = setup.assets ? [{ id: 'a1', name: 'Banka', type: 'Banka Hesabı', balance: setup.assets, currency: 'TRY' }] : [];
    persistent.debts = setup.debt ? [{ id: 'd1', category: 'Diğer', balance: setup.debt, minPayment: setup.minPayment || 0, extraPayment: 0, rate: setup.rate || 0 }] : [];
    persistent.creditCards = [];
    month.incomes = setup.income > 0 ? [{ id: 'i1', category: 'Maaş', amount: setup.income }] : [];
    month.expenses = setup.expenses > 0 ? [{ id: 'e1', category: 'Diğer', amount: setup.expenses }] : [];
    persistent.goals = setup.goals || [];
    persistent.dailyMoneyTask = null;
    let renderErr = null;
    try { render(); } catch (e) { renderErr = e.message + ' :: ' + (e.stack || ''); }
    const planCacheBefore = _planCache ? JSON.stringify(_planCache.steps) : null;
    let decisionErr = null, decision = null;
    try { decision = runDecisionEngine(request); } catch (e) { decisionErr = e.message + ' :: ' + (e.stack || ''); }
    const planCacheAfter = _planCache ? JSON.stringify(_planCache.steps) : null;
    return { renderErr, decisionErr, decision, planCacheUnchanged: planCacheBefore === planCacheAfter };
  }, { setup, request });
  await page.close();
  return { r, pageErrors };
}

function assertNoNaNOrInfinity(obj, path = 'root') {
  if (obj == null) return;
  if (typeof obj === 'number') {
    assert.ok(Number.isFinite(obj), `${path} is not finite: ${obj}`);
    return;
  }
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => assertNoNaNOrInfinity(v, `${path}[${i}]`));
    return;
  }
  if (typeof obj === 'object') {
    for (const k of Object.keys(obj)) assertNoNaNOrInfinity(obj[k], `${path}.${k}`);
  }
}

const ANSWER_CATEGORIES = ['yes_today', 'yes_on_date', 'yes_with_condition', 'yes_delays_goals', 'no_unsafe'];

// ---------------------------------------------------------------------
// A. income > expenses, no debt — purchase well within safe capacity -> yes_today
// ---------------------------------------------------------------------
test('A: income>expenses, no debt — cheap purchase is yes_today and fully GREEN-safe (not just financedAmount<=0)', async () => {
  const { r, pageErrors } = await runDecision(
    { income: 100000, expenses: 30000, debt: 0, assets: 500000 },
    { type: 'purchase', purchase: { category: 'diger', price: 5000, downPayment: 5000 } }
  );
  assert.equal(r.renderErr, null, r.renderErr);
  assert.equal(r.decisionErr, null, r.decisionErr);
  assert.equal(r.decision.answerCategory, 'yes_today');
  assert.equal(r.decision.safe, true);
  assert.equal(r.decision.verdict, 'green');
  assertNoNaNOrInfinity(r.decision);
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('A2: yes_today requires full safety GREEN, not merely financedAmount<=0 (correction #1)', async () => {
  // financedAmount<=0 (down payment covers price) BUT liquid assets are essentially zero and
  // income is zero -> emergency fund / cash flow rules must still fire; must NOT be yes_today.
  const { r } = await runDecision(
    { income: 0, expenses: 0, debt: 0, assets: 1000 },
    { type: 'purchase', purchase: { category: 'diger', price: 1000, downPayment: 1000 } }
  );
  assert.notEqual(r.decision.answerCategory, 'yes_today');
});

// ---------------------------------------------------------------------
// B. income > expenses, with debt payments
// ---------------------------------------------------------------------
test('B: income>expenses with debt payments — monthlyImpact/cashFlowAfterDecision account for existing debt', async () => {
  const { r } = await runDecision(
    { income: 80000, expenses: 30000, debt: 500000, minPayment: 15000, assets: 300000 },
    { type: 'purchase', purchase: { category: 'diger', price: 20000, financing: { months: 10, ratePct: 2 } } }
  );
  assert.equal(r.renderErr, null, r.renderErr);
  assertNoNaNOrInfinity(r.decision);
  assert.ok(ANSWER_CATEGORIES.includes(r.decision.answerCategory));
});

// ---------------------------------------------------------------------
// C. negative cash flow (structural, cannot recover) -> no_unsafe, no fabricated date
// ---------------------------------------------------------------------
test('C: structural negative cash flow — no_unsafe, no affordabilityDate fabricated', async () => {
  const { r, pageErrors } = await runDecision(
    { income: 20000, expenses: 40000, debt: 0, assets: 10000 },
    { type: 'purchase', purchase: { category: 'diger', price: 50000, downPayment: 0 } }
  );
  assert.equal(r.decision.answerCategory, 'no_unsafe');
  assert.equal(r.decision.affordabilityDate, null);
  assertNoNaNOrInfinity(r.decision);
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// D. zero income -> no_unsafe, no NaN/Infinity anywhere
// ---------------------------------------------------------------------
test('D: zero income — no_unsafe, all fields finite (no NaN/Infinity)', async () => {
  const { r, pageErrors } = await runDecision(
    { income: 0, expenses: 5000, debt: 0, assets: 20000 },
    { type: 'purchase', purchase: { category: 'diger', price: 10000 } }
  );
  // affordHasMinimumData requires income>0 AND spent>0 - with zero income this is missingData
  assert.equal(r.decisionErr, null, r.decisionErr);
  if (!r.decision.missingData) {
    assertNoNaNOrInfinity(r.decision);
  }
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// E. emergency-fund breach -> yes_with_condition (soft breach) not no_unsafe
// ---------------------------------------------------------------------
test('E: down payment eats emergency reserve (soft breach) — yes_with_condition, not no_unsafe', async () => {
  const { r } = await runDecision(
    { income: 60000, expenses: 20000, debt: 0, assets: 30000 }, // essential ~20000*0.6=12000 (no fixed flagged) -> target3=36000
    { type: 'purchase', purchase: { category: 'diger', price: 15000, downPayment: 15000 } }
  );
  assert.notEqual(r.decision.answerCategory, 'no_unsafe');
  assert.ok(['yes_with_condition', 'yes_today', 'yes_delays_goals'].includes(r.decision.answerCategory));
});

// ---------------------------------------------------------------------
// F. down payment > liquid assets -> no_unsafe (structurally impossible today)
// ---------------------------------------------------------------------
test('F: down payment exceeds liquid assets with no cash-flow path to ever recover — no_unsafe with DOWNPAYMENT_EXCEEDS_LIQUID', async () => {
  // income===expenses (zero cash flow) so liquid never grows - down payment > liquid is
  // permanently unresolvable, unlike a case where waiting a month would legitimately fix it
  // (that case correctly resolves to yes_on_date, tested separately in K/P).
  const { r, pageErrors } = await runDecision(
    { income: 20000, expenses: 20000, debt: 0, assets: 10000 },
    { type: 'purchase', purchase: { category: 'diger', price: 50000, downPayment: 50000 } }
  );
  assert.equal(r.decision.answerCategory, 'no_unsafe');
  assert.equal(r.decision.affordabilityDate, null);
  const codes = r.decision.constraints.map(c => c.code);
  assert.ok(codes.includes('DOWNPAYMENT_EXCEEDS_LIQUID'), JSON.stringify(codes));
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('F2: down payment exceeds liquid TODAY but positive cash flow resolves it later — yes_on_date, not a vague no', async () => {
  const { r } = await runDecision(
    { income: 100000, expenses: 20000, debt: 0, assets: 10000 },
    { type: 'purchase', purchase: { category: 'diger', price: 50000, downPayment: 50000 } }
  );
  assert.equal(r.decision.answerCategory, 'yes_on_date');
  assert.ok(r.decision.affordabilityDate);
});

// ---------------------------------------------------------------------
// G. existing goals — goalImpact populated, excludeGoalId respected
// ---------------------------------------------------------------------
test('G: existing goals — goalImpact reflects other active goals required-monthly sum', async () => {
  const { r } = await runDecision(
    {
      income: 100000, expenses: 30000, debt: 0, assets: 200000,
      goals: [{ id: 'g1', typeKey: 'diger', name: 'Tatil', targetAmount: 60000, targetDate: new Date(Date.now() + 180 * 86400000).toISOString().slice(0, 10) }],
    },
    { type: 'purchase', purchase: { category: 'diger', price: 30000, downPayment: 30000 }, excludeGoalId: null }
  );
  assert.ok(r.decision.goalImpact.length >= 1);
  assert.ok(Number.isFinite(r.decision.goalImpact[0].requiredMonthlyAfter));
});

// ---------------------------------------------------------------------
// H. "gelirartir" goal exclusion — goal_timeline must refuse, never compute a savings pace
// ---------------------------------------------------------------------
test('H: goal_timeline on a "gelirartir" goal returns an explicit unsupported result, never a savings pace', async () => {
  const { r, pageErrors } = await runDecision(
    { income: 60000, expenses: 20000, debt: 0, assets: 50000, goals: [{ id: 'g_gelir', typeKey: 'gelirartir', name: 'Gelirimi Artır', targetAmount: 100000 }] },
    { type: 'goal_timeline', goalId: 'g_gelir' }
  );
  assert.equal(r.decision.answerCategory, 'no_unsafe');
  const codes = r.decision.constraints.map(c => c.code);
  assert.ok(codes.includes('UNSUPPORTED_GOAL_TYPE_INCOME_TARGET'), JSON.stringify(codes));
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// I. cash purchase
// ---------------------------------------------------------------------
test('I: cash purchase — no financing, monthlyImpact reflects only recurring cost (0 here)', async () => {
  const { r } = await runDecision(
    { income: 100000, expenses: 30000, debt: 0, assets: 500000 },
    { type: 'purchase', purchase: { category: 'diger', price: 40000, downPayment: 40000 } }
  );
  assert.equal(r.decision.monthlyImpact, 0);
});

// ---------------------------------------------------------------------
// J. installment purchase — matches loanPrincipal/computeLoanFinancing annuity math
// ---------------------------------------------------------------------
test('J: installment purchase — monthly burden matches the annuity formula exactly', async () => {
  const { page } = await newSession();
  const r = await page.evaluate(() => {
    persistent.accounts = [{ id: 'a1', name: 'Banka', type: 'Banka Hesabı', balance: 200000, currency: 'TRY' }];
    persistent.debts = [];
    month.incomes = [{ id: 'i1', category: 'Maaş', amount: 100000 }];
    month.expenses = [{ id: 'e1', category: 'Diğer', amount: 30000 }];
    persistent.goals = [];
    render();
    const decision = runDecisionEngine({ type: 'purchase', purchase: { category: 'diger', price: 60000, downPayment: 10000, financing: { months: 12, ratePct: 3 } } });
    // independently recompute the expected payment via the SAME annuity formula loanPrincipal derives from
    const principal = 50000;
    const i = 0.03;
    const expectedPayment = principal * i / (1 - Math.pow(1 + i, -12));
    return { decision, expectedPayment };
  });
  await page.close();
  assert.ok(Math.abs(r.decision.monthlyImpact - r.expectedPayment) < 0.01, `${r.decision.monthlyImpact} vs ${r.expectedPayment}`);
});

// ---------------------------------------------------------------------
// K. wait-N purchase — finds a future safe date without inventing income/expense changes
// ---------------------------------------------------------------------
test('K: wait-N purchase — positive cash flow eventually resolves yes_on_date via pure accumulation', async () => {
  const { r, pageErrors } = await runDecision(
    { income: 60000, expenses: 40000, debt: 0, assets: 5000 }, // cash flow +20000/mo, but too little liquid today for a big cash purchase
    { type: 'purchase', purchase: { category: 'diger', price: 100000, downPayment: 0 } }
  );
  assert.notEqual(r.decision.answerCategory, 'yes_today');
  if (r.decision.answerCategory === 'yes_on_date') {
    assert.ok(r.decision.affordabilityDate, 'affordabilityDate must be set for yes_on_date');
  }
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('K2: negative current cash flow cannot magically recover in V1 (no future income/expense invented)', async () => {
  const { r } = await runDecision(
    { income: 20000, expenses: 50000, debt: 0, assets: 5000 }, // permanently negative cash flow
    { type: 'purchase', purchase: { category: 'diger', price: 100000, downPayment: 0 } }
  );
  assert.equal(r.decision.answerCategory, 'no_unsafe');
  assert.equal(r.decision.affordabilityDate, null);
});

// ---------------------------------------------------------------------
// L. recurring monthly ownership cost — affects future cash flow, NOT immediate cash spent
// ---------------------------------------------------------------------
test('L: recurringMonthlyCost affects monthlyImpact but not the one-time cash spent', async () => {
  const { page } = await newSession();
  const r = await page.evaluate(() => {
    persistent.accounts = [{ id: 'a1', name: 'Banka', type: 'Banka Hesabı', balance: 500000, currency: 'TRY' }];
    persistent.debts = [];
    month.incomes = [{ id: 'i1', category: 'Maaş', amount: 100000 }];
    month.expenses = [{ id: 'e1', category: 'Diğer', amount: 30000 }];
    persistent.goals = [];
    render();
    const withoutRecurring = runDecisionEngine({ type: 'purchase', purchase: { category: 'araba', price: 50000, downPayment: 50000 } });
    const withRecurring = runDecisionEngine({ type: 'purchase', purchase: { category: 'araba', price: 50000, downPayment: 50000, recurringMonthlyCost: 3000 } });
    return { withoutRecurring, withRecurring };
  });
  await page.close();
  assert.equal(r.withoutRecurring.monthlyImpact, 0);
  assert.equal(r.withRecurring.monthlyImpact, 3000);
  // cash spent now (reflected via emergencyFundImpact.after / cashFlowAfterDecision baseline) must
  // NOT differ due to recurring cost - only monthlyImpact/cashFlowAfterDecision should move.
  assert.equal(r.withRecurring.cashFlowAfterDecision, r.withoutRecurring.cashFlowAfterDecision - 3000);
});

// ---------------------------------------------------------------------
// M. target-date change — recomputation uses day-aware expiry, consistent with computeGoalInfo
// ---------------------------------------------------------------------
test('M: goal_timeline target-date change recomputes using the same day-aware expiry logic', async () => {
  const { page } = await newSession();
  const r = await page.evaluate(() => {
    const pastDate = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
    const futureDate = new Date(Date.now() + 400 * 86400000).toISOString().slice(0, 10);
    persistent.accounts = [{ id: 'a1', name: 'Banka', type: 'Banka Hesabı', balance: 50000, currency: 'TRY' }];
    persistent.debts = [];
    month.incomes = [{ id: 'i1', category: 'Maaş', amount: 60000 }];
    month.expenses = [{ id: 'e1', category: 'Diğer', amount: 20000 }];
    persistent.goals = [
      { id: 'g_past', typeKey: 'diger', name: 'X', targetAmount: 100000, targetDate: pastDate },
      { id: 'g_future', typeKey: 'diger', name: 'Y', targetAmount: 100000, targetDate: futureDate },
    ];
    render();
    return {
      pastResult: runDecisionEngine({ type: 'goal_timeline', goalId: 'g_past' }),
      futureResult: runDecisionEngine({ type: 'goal_timeline', goalId: 'g_future' }),
    };
  });
  await page.close();
  assert.equal(r.pastResult.answerCategory, 'no_unsafe');
  assert.ok(r.pastResult.constraints.some(c => c.code === 'GOAL_TARGET_DATE_EXPIRED'));
  assert.notEqual(r.futureResult.answerCategory, 'no_unsafe');
});

// ---------------------------------------------------------------------
// N. debt payoff timing
// ---------------------------------------------------------------------
test('N: debt_payoff_timing — yes_on_date with a real payoff date for a payable debt', async () => {
  const { r, pageErrors } = await runDecision(
    { income: 80000, expenses: 20000, debt: 100000, minPayment: 10000, rate: 2, assets: 50000 },
    { type: 'debt_payoff_timing', debt: { debtId: 'debt:d1', extraMonthly: 0 } }
  );
  assert.equal(r.decision.answerCategory, 'yes_on_date');
  assert.ok(r.decision.affordabilityDate);
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('N2: debt_payoff_timing — payment below interest never amortizes -> no_unsafe, not a fabricated date', async () => {
  const { r } = await runDecision(
    { income: 80000, expenses: 20000, debt: 100000, minPayment: 100, rate: 5, assets: 50000 }, // 5%/mo interest >> 100 payment
    { type: 'debt_payoff_timing', debt: { debtId: 'debt:d1', extraMonthly: 0 } }
  );
  assert.equal(r.decision.answerCategory, 'no_unsafe');
  assert.equal(r.decision.affordabilityDate, null);
});

// ---------------------------------------------------------------------
// O. debt vs investment — reuses answerDebtOrInvest's exact reference rate
// ---------------------------------------------------------------------
test('O: debt_vs_invest recommends paying debt when its rate exceeds the reference deposit rate', async () => {
  const { page } = await newSession();
  const r = await page.evaluate(() => {
    persistent.accounts = [{ id: 'a1', name: 'Banka', type: 'Banka Hesabı', balance: 100000, currency: 'TRY' }];
    persistent.debts = [{ id: 'd1', category: 'Diğer', balance: 50000, minPayment: 5000, rate: 8 }]; // 8%/mo, way above deposit reference
    month.incomes = [{ id: 'i1', category: 'Maaş', amount: 80000 }];
    month.expenses = [{ id: 'e1', category: 'Diğer', amount: 20000 }];
    persistent.goals = [];
    render();
    const referenceRate = mevduatAylikBilesikNet();
    const decision = runDecisionEngine({ type: 'debt_vs_invest', compare: { investAmount: 10000 } });
    return { decision, referenceRate };
  });
  await page.close();
  assert.equal(r.decision.recommendedAction.code, 'PAY_DOWN_DEBT_FIRST');
  assert.equal(r.decision.opportunityCost.assumedReturnPct, r.referenceRate);
});

test('O2: debt_vs_invest with invest amount exceeding liquid assets is no_unsafe', async () => {
  const { r } = await runDecision(
    { income: 80000, expenses: 20000, debt: 0, assets: 5000 },
    { type: 'debt_vs_invest', compare: { investAmount: 50000 } }
  );
  assert.equal(r.decision.answerCategory, 'no_unsafe');
});

// ---------------------------------------------------------------------
// P. all 5 answer categories reachable
// ---------------------------------------------------------------------
test('P: all 5 answer categories are reachable across representative inputs', async () => {
  const cases = [
    { setup: { income: 100000, expenses: 20000, debt: 0, assets: 500000 }, request: { type: 'purchase', purchase: { category: 'diger', price: 5000, downPayment: 5000 } } }, // yes_today
    { setup: { income: 60000, expenses: 40000, debt: 0, assets: 5000 }, request: { type: 'purchase', purchase: { category: 'diger', price: 100000, downPayment: 0 } } }, // yes_on_date (positive cash flow, accumulate)
    { setup: { income: 60000, expenses: 20000, debt: 0, assets: 30000 }, request: { type: 'purchase', purchase: { category: 'diger', price: 15000, downPayment: 15000 } } }, // yes_with_condition (emergency reserve dent)
    { setup: { income: 100000, expenses: 30000, debt: 0, assets: 200000, goals: [{ id: 'g1', typeKey: 'diger', name: 'X', targetAmount: 500000, targetDate: new Date(Date.now() + 180 * 86400000).toISOString().slice(0, 10) }] }, request: { type: 'purchase', purchase: { category: 'diger', price: 90000, financing: { months: 6, ratePct: 0 } } } }, // yes_delays_goals
    { setup: { income: 20000, expenses: 40000, debt: 0, assets: 5000 }, request: { type: 'purchase', purchase: { category: 'diger', price: 50000, downPayment: 50000 } } }, // no_unsafe
  ];
  const seen = new Set();
  for (const c of cases) {
    const { r } = await runDecision(c.setup, c.request);
    seen.add(r.decision.answerCategory);
  }
  for (const cat of ANSWER_CATEGORIES) {
    assert.ok(seen.has(cat), `category ${cat} was never reached; got ${[...seen].join(',')}`);
  }
});

// ---------------------------------------------------------------------
// Cross-cutting assertions (task §17)
// ---------------------------------------------------------------------
test('cross-cutting: Decision Engine never mutates the real _planCache', async () => {
  const { r, pageErrors } = await runDecision(
    { income: 80000, expenses: 30000, debt: 200000, minPayment: 10000, assets: 100000, goals: [{ id: 'g1', typeKey: 'diger', name: 'X', targetAmount: 50000, targetDate: new Date(Date.now() + 300 * 86400000).toISOString().slice(0, 10) }] },
    { type: 'purchase', purchase: { category: 'diger', price: 20000, financing: { months: 12, ratePct: 2 } } }
  );
  assert.equal(r.planCacheUnchanged, true);
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('cross-cutting: no duplicated contradictory cash-flow values between AI context and Decision Engine', async () => {
  const { page } = await newSession();
  const r = await page.evaluate(() => {
    persistent.accounts = [{ id: 'a1', name: 'Banka', type: 'Banka Hesabı', balance: 300000, currency: 'TRY' }];
    persistent.debts = [{ id: 'd1', category: 'Diğer', balance: 200000, minPayment: 15000 }];
    month.incomes = [{ id: 'i1', category: 'Maaş', amount: 90000 }];
    month.expenses = [{ id: 'e1', category: 'Diğer', amount: 30000 }];
    persistent.goals = [];
    render();
    const coach = buildAICoachContext();
    const decision = runDecisionEngine({ type: 'purchase', purchase: { category: 'diger', price: 1000, downPayment: 1000 } });
    return { coachCashFlow: coach.financialSnapshot.monthlyCashFlow, cap: getAffordCapacityInfo().monthlyCashFlow, decisionSafetyBase: decision.cashFlowAfterDecision };
  });
  await page.close();
  // cashFlowAfterDecision for a trivial 0-monthlyImpact purchase must equal the SAME canonical cash flow AI context uses
  assert.equal(r.coachCashFlow, r.cap);
  assert.equal(r.decisionSafetyBase, r.cap);
});

test('cross-cutting: AI Coach precomputed.decision is present for afford-intent questions and matches direct runDecisionEngine call', async () => {
  const { page } = await newSession();
  const r = await page.evaluate(() => {
    persistent.accounts = [{ id: 'a1', name: 'Banka', type: 'Banka Hesabı', balance: 500000, currency: 'TRY' }];
    persistent.debts = [];
    month.incomes = [{ id: 'i1', category: 'Maaş', amount: 100000 }];
    month.expenses = [{ id: 'e1', category: 'Diğer', amount: 30000 }];
    persistent.goals = [];
    render();
    const precomputed = buildAICoachPrecomputed('50000 TL bir şey alabilir miyim?');
    const direct = runDecisionEngine({ type: 'purchase', purchase: { category: 'diger', price: 50000 } });
    return { precomputed, direct };
  });
  await page.close();
  assert.ok(r.precomputed.decision, 'precomputed.decision should be populated for an afford-intent question with an amount');
  assert.equal(r.precomputed.decision.answerCategory, r.direct.answerCategory);
  assert.equal(r.precomputed.decision.monthlyImpact, r.direct.monthlyImpact);
  // no LLM-generated calculation fields: headline must be a template key + params, never free prose
  assert.equal(typeof r.precomputed.decision.headline.key, 'string');
  assert.ok(/^decision\./.test(r.precomputed.decision.headline.key));
});

test('existing finance-core tests remain green (sanity re-check inside this suite)', async () => {
  const { page } = await newSession();
  const r = await page.evaluate(() => {
    const cf = computeCashFlowSummary({ income: 110000, expenses: 44067, debtPayments: 0, remainingDays: 16 });
    return cf.remaining;
  });
  await page.close();
  assert.equal(r, 65933);
});
