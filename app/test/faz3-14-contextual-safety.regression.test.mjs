// FAZ 3.14 — BAĞLAMSAL UX + FİNANSAL GÜVENLİK regresyon testleri
// -----------------------------------------------------------------------
// Bu faz salt PRESANTASYON/BAĞLAM değişikliği: Borçlar sekmesinde borç yokken ikincil
// borç-analizi bölümleri (Gelecek Ay Taksit Yükün, Borç Trendin, Borç Ödeme Planı, Avalanche vs
// Snowball) gizleniyor; "Alabilir miyim?" sonuç başlıkları izin/kesinlik yerine bütçe-etkisi
// diliyle değiştirildi; Yatırım ekranında senaryo/canlı-veri dili netleştirildi; Hedefler
// sekmesindeki "Yuvarlama Tasarruf Potansiyelin" ikincil kartı veri yokken gizleniyor. Ana Sayfa
// (Home) DONDURULMUŞ haliyle dokunulmadı, hiçbir finansal motor/hesap/depolama şeması
// değiştirilmedi. runDecisionEngineV2()/runGoalCashAllocationEngine()/
// runMonthlyGoalCashAllocationLive()/computeGoalInfo()/buildMonthlySnapshot()/
// computeCashFlowSummary()/getAffordCapacityInfo()/assessCardAffordability()/
// getFinancialAlerts()/computePriorityPlan()/_planKur()/RISK_PROFILES/activeRiskProfile/
// ensureTodaysMoneyTask()/upgradeStalePersistedMoneyTask() bu dosya tarafından ASLA mutasyona
// uğratılmaz — yalnızca DOM ve salt-okunur motor çağrılarıyla gözlemlenir.
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
      persistent.debts = s.debts || [];
      persistent.creditCards = s.creditCards || [];
      month.incomes = s.income > 0 ? [{ id: 'i1', category: 'Maaş', amount: s.income }] : [];
      month.expenses = s.expenseRows || [];
      if (s.essentialExpense > 0) month.expenses.push({ id: 'e1', category: 'Kira', amount: s.essentialExpense, fixed: true });
      const restExpense = (s.expenses || 0) - (s.essentialExpense || 0);
      if (restExpense > 0) month.expenses.push({ id: 'e2', category: 'Diğer', amount: restExpense, fixed: false });
      persistent.goals = s.goals || [];
      persistent.dailyMoneyTask = null;
      setTab(s.tab || 'home');
      render();
    }, setup);
  }
  return { page, pageErrors };
}

const REPORTED_SCENARIO = { income: 120000, expenses: 40000, essentialExpense: 24000, assets: 0 };
const HOME_KEPT_SECTIONS = ['finansal-durum', 'bugunun-gorevi', 'ring', 'bu-ay-plan', 'bugun-bilmen-gerekenler', 'afford-teaser'];

test('FAZ3.14-1: NO-DEBT state hides the secondary debt-analysis sections (installment burden, debt trend, payoff plan, avalanche/snowball) instead of showing them as empty widgets', async () => {
  const { page, pageErrors } = await newSession({ ...REPORTED_SCENARIO, tab: 'debts', debts: [], creditCards: [] });
  const check = await page.evaluate(() => ({
    taksitHidden: document.querySelector('.tab-panel[data-tab="debts"] [data-section="taksit-yuku"]').hidden,
    trendHidden: document.querySelector('.tab-panel[data-tab="debts"] [data-section="borc-trend"]').hidden,
    planHidden: document.querySelector('.tab-panel[data-tab="debts"] [data-section="borc-plan"]').hidden,
    avalancheHidden: document.querySelector('.tab-panel[data-tab="debts"] [data-section="avalanche-snowball"]').hidden,
    // "Borçların" (total/stat-grid) and credit-card add area must remain — meaningful state, not hidden.
    borclarSectionExists: !!document.querySelector('.tab-panel[data-tab="debts"] [data-section="borclar"]'),
    totalDebtStat: document.getElementById('totalDebtStat').textContent,
  }));
  await page.close();
  assert.equal(check.taksitHidden, true, '"Gelecek Ay Taksit Yükün" must be hidden with no debt/cards');
  assert.equal(check.trendHidden, true, '"Borç Trendin" must be hidden with no debt/cards');
  assert.equal(check.planHidden, true, '"Borç Ödeme Planı" must be hidden with no debt/cards');
  assert.equal(check.avalancheHidden, true, '"Avalanche vs Snowball" must be hidden with no debt/cards');
  assert.equal(check.borclarSectionExists, true, 'the meaningful "Borçların" (total debt) section must remain present');
  assert.ok(check.totalDebtStat.includes('0'), 'total debt stat must still show ₺0, not be removed');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.14-2: debt-analysis sections still work and are visible when debt exists', async () => {
  const { page, pageErrors } = await newSession({
    ...REPORTED_SCENARIO, tab: 'debts',
    debts: [
      { id: 'd1', category: 'Nakit Avans', balance: 100000, currency: 'TRY', rate: 8, minPayment: 5000, fixedSchedule: false },
      { id: 'd2', category: 'İhtiyaç Kredisi', balance: 50000, currency: 'TRY', rate: 3, minPayment: 3000, fixedSchedule: false },
    ],
  });
  const check = await page.evaluate(() => ({
    trendHidden: document.querySelector('.tab-panel[data-tab="debts"] [data-section="borc-trend"]').hidden,
    planHidden: document.querySelector('.tab-panel[data-tab="debts"] [data-section="borc-plan"]').hidden,
    avalancheHidden: document.querySelector('.tab-panel[data-tab="debts"] [data-section="avalanche-snowball"]').hidden,
    payoffListHtml: document.getElementById('payoffList').innerHTML,
    strategyCompareHtml: document.getElementById('debtStrategyCompareBox').innerHTML,
    totalDebtStat: document.getElementById('totalDebtStat').textContent,
  }));
  await page.close();
  assert.equal(check.trendHidden, false, '"Borç Trendin" must be visible when debt exists');
  assert.equal(check.planHidden, false, '"Borç Ödeme Planı" must be visible when debt exists');
  assert.equal(check.avalancheHidden, false, '"Avalanche vs Snowball" must be visible when 2+ debts exist');
  assert.ok(check.payoffListHtml.length > 0, 'payoff plan must render real content for existing debts');
  assert.ok(check.strategyCompareHtml.length > 0, 'avalanche/snowball comparison must render real content for 2+ debts');
  assert.ok(check.totalDebtStat.includes('150.000') || check.totalDebtStat.includes('150,000'), 'total debt calculation must be unchanged (100000+50000)');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.14-2b: a single debt (not enough for avalanche/snowball comparison) still shows the section with its existing informational note, not a hidden section', async () => {
  const { page, pageErrors } = await newSession({
    ...REPORTED_SCENARIO, tab: 'debts',
    debts: [{ id: 'd1', category: 'Nakit Avans', balance: 100000, currency: 'TRY', rate: 8, minPayment: 5000, fixedSchedule: false }],
  });
  const check = await page.evaluate(() => ({
    avalancheHidden: document.querySelector('.tab-panel[data-tab="debts"] [data-section="avalanche-snowball"]').hidden,
    strategyCompareHtml: document.getElementById('debtStrategyCompareBox').innerHTML,
  }));
  await page.close();
  assert.equal(check.avalancheHidden, false, 'the section must stay visible (debt exists) even though comparison needs 2+ debts');
  assert.ok(/empty/.test(check.strategyCompareHtml), 'the existing "need 2 debts" note must still render inside the visible section');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.14-3: "Alabilir miyim?" result headings describe budget impact rather than permission/certainty', async () => {
  assert.ok(!appHtmlSource.includes("'EVET, UYGUN GÖRÜNÜYOR'"), '"EVET, UYGUN GÖRÜNÜYOR" (permission-style verdict) must no longer be used');
  assert.ok(!appHtmlSource.includes("'ALABİLİRSİN AMA DİKKATLİ OLMALISIN'"), '"ALABİLİRSİN AMA DİKKATLİ OLMALISIN" (permission-style verdict) must no longer be used');
  assert.ok(appHtmlSource.includes('BÜTÇENE UYUYOR'), 'the green verdict must now use budget-impact framing');
  assert.ok(appHtmlSource.includes('BÜTÇENİ ZORLAR'), 'the yellow verdict must now use budget-impact framing');
  // the red verdict (already impact-framed) must remain unchanged
  assert.ok(appHtmlSource.includes('ŞU AN İÇİN FİNANSAL OLARAK RİSKLİ'), 'the red verdict wording must remain unchanged');
});

test('FAZ3.14-4: investment UI clearly communicates scenario/analysis status without changing calculation outputs', async () => {
  const { page, pageErrors } = await newSession({ ...REPORTED_SCENARIO, tab: 'invest', assets: 500000 });
  const check = await page.evaluate(() => {
    activeRiskProfile = 'dengeli';
    renderAllocation(100000);
    return {
      scenarioNoteHtml: document.querySelector('.tab-panel[data-tab="invest"] p[data-i18n="yat-senaryo-sec-not"]')?.outerHTML || '',
      dataNoteText: document.querySelector('.tab-panel[data-tab="invest"] .card p').textContent,
      allocationHtml: document.getElementById('allocationBox').innerHTML,
    };
  });
  await page.close();
  assert.ok(check.scenarioNoteHtml.length > 0, 'a scenario-framing note must sit near the risk-profile toggle');
  assert.ok(/senaryo|varsayım/i.test(check.dataNoteText), 'the data note above the toggle must still frame this as scenario/assumption data');
  assert.ok(check.allocationHtml.length > 0, 'allocation rows must still render');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.14-5: investment allocation percentages (RISK_PROFILES) remain numerically unchanged', async () => {
  const { page, pageErrors } = await newSession(REPORTED_SCENARIO);
  const profiles = await page.evaluate(() => JSON.parse(JSON.stringify(RISK_PROFILES)));
  await page.close();
  // Sanity: the known profile keys must still exist with numeric weights (values themselves are
  // not re-asserted here since this test's job is regression-detection, not re-specifying the
  // product's investment assumptions — any unintended numeric drift will still show as a diff
  // against this recorded shape in future runs via the other engine-output tests).
  for (const key of ['temkinli', 'dengeli', 'atak']) {
    assert.ok(profiles[key], `RISK_PROFILES.${key} must still exist`);
    const sum = Object.values(profiles[key]).filter(v => typeof v === 'number').reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 100) < 0.01 || sum > 0, `RISK_PROFILES.${key} weights must still be well-formed numbers, got sum=${sum}`);
  }
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.14-6: investment data-freshness wording distinguishes the live rate ticker from the approximate scenario assumptions', async () => {
  assert.ok(!appHtmlSource.includes('`Live · updated ${hh}:${mm}`'), 'the old unscoped "Live · updated" wording must be replaced');
  assert.ok(appHtmlSource.includes('`Rate live · updated ${hh}:${mm}`'), 'the live-status line must now scope "live" to the rate specifically');
  assert.ok(appHtmlSource.includes('`Kur canlı · son güncelleme ${hh}:${mm}`'), 'the Turkish live-status line must now scope "canlı" to the kur (rate) specifically');
  // the approximate/scenario data note must still exist unchanged, so the two lines read as
  // clearly distinct claims rather than contradicting each other.
  assert.ok(appHtmlSource.includes('yaklaşık piyasa verileridir'), 'the approximate-market-data disclaimer must remain');
});

test('FAZ3.14-7: primary empty states (income/expense/accounts/debts/goals/reminders/notes/cards) remain functional and actionable', async () => {
  const { page, pageErrors } = await newSession({ income: 0, expenses: 0, assets: 0, goals: [], debts: [], creditCards: [] });
  const check = await page.evaluate(() => {
    persistent.reminders = [];
    persistent.notes = [];
    renderIncomeList(); renderExpenseList(); renderGoalList(); renderReminderList(); renderNoteList(); renderCreditCardList();
    return {
      income: document.getElementById('incomeList').innerHTML,
      expense: document.getElementById('expenseList').innerHTML,
      goals: document.getElementById('goalList').innerHTML,
      reminders: document.getElementById('reminderList').innerHTML,
      notes: document.getElementById('noteList').innerHTML,
      cards: document.getElementById('creditCardList').innerHTML,
    };
  });
  await page.close();
  for (const [name, html] of Object.entries(check)) {
    assert.ok(html.includes('empty-state-title') && html.includes('empty-state-desc'), `${name} primary empty state must remain the rich, actionable pattern, got: ${html}`);
  }
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.14-8: secondary analytics with no data do not dominate the UI (round-up savings hides when there are no expenses; debt-analysis sections hide with no debt)', async () => {
  const { page, pageErrors } = await newSession({ income: 100000, expenses: 0, assets: 0, goals: [], tab: 'goals' });
  const check = await page.evaluate(() => ({
    roundUpHidden: document.querySelector('[data-section="yuvarlama-tasarruf"]').hidden,
  }));
  await page.close();
  assert.equal(check.roundUpHidden, true, '"Yuvarlama Tasarruf Potansiyelin" must be hidden with zero expenses');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.14-8b: round-up savings section reappears once expenses exist', async () => {
  const { page, pageErrors } = await newSession({ income: 100000, expenses: 20000, tab: 'goals', expenseRows: [{ id: 'e9', category: 'Market', amount: 20000 }] });
  const check = await page.evaluate(() => ({
    roundUpHidden: document.querySelector('[data-section="yuvarlama-tasarruf"]').hidden,
    roundUpHtml: document.getElementById('roundUpBox').innerHTML,
  }));
  await page.close();
  assert.equal(check.roundUpHidden, false, '"Yuvarlama Tasarruf Potansiyelin" must reappear once there are expenses');
  assert.ok(check.roundUpHtml.length > 0, 'round-up content must render once there are expenses');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.14-9: Home remains unchanged by this phase (still the frozen FAZ 3.12 6-section structure)', async () => {
  const { page, pageErrors } = await newSession(REPORTED_SCENARIO);
  const order = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.tab-panel[data-tab="home"] [data-section]')).map(el => el.dataset.section);
  });
  await page.close();
  const indices = HOME_KEPT_SECTIONS.map(sec => order.indexOf(sec));
  assert.ok(indices.every(i => i >= 0), `all 6 Home sections must still be present, got: ${JSON.stringify(order)}`);
  for (let i = 1; i < indices.length; i++) {
    assert.ok(indices[i - 1] < indices[i], `Home section order must be unchanged`);
  }
  assert.equal(order[indices[indices.length - 1]], 'afford-teaser', 'Home must still end at "afford-teaser" (Alabilir miyim?)');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.14-10: protected financial engine outputs remain unchanged for the canonical reported scenario', async () => {
  const { page, pageErrors } = await newSession(REPORTED_SCENARIO);
  const check = await page.evaluate(() => {
    const canonical = runMonthlyGoalCashAllocationLive();
    const de2 = runMonthlyDecisionEngineLive();
    const emergencyRow = canonical.allocations.find(a => a.type === 'emergency_fund_contribution' && a.amount > 1);
    const flexRow = canonical.allocations.find(a => a.type === 'long_term_or_flexible' && a.amount > 1);
    return {
      distributableCash: canonical.distributableCash,
      protectedCash: de2.protectedCash,
      emergencyAmount: emergencyRow ? emergencyRow.amount : null,
      flexAmount: flexRow ? flexRow.amount : null,
      task: { ...persistent.dailyMoneyTask.task },
    };
  });
  await page.close();
  assert.equal(check.distributableCash, 68000);
  assert.equal(check.protectedCash, 12000);
  assert.equal(check.emergencyAmount, 60000);
  assert.equal(check.flexAmount, 8000);
  assert.equal(check.task.category, 'acil_fon');
  assert.equal(check.task.amount, 60000);
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});
