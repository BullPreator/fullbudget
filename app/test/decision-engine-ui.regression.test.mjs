// DECISION ENGINE V1 — UI ENTEGRASYON regresyon testleri
// -----------------------------------------------------------------------
// runDecisionEngine()'in kendisi zaten app/test/decision-engine.regression.test.mjs
// tarafından kapsanıyor. Bu dosya SADECE yeni UI bağlantısını doğrular: Ana Sayfa
// "Alabilir miyim?" girişinin ad-hoc akışı gerçekten tetiklediğini, ad-hoc akışın
// persistent.goals'a HİÇBİR ŞEY yazmadığını, kullanıcının bir fiyat girip gerçek bir
// DecisionResult aldığını, gösterilen kategori etiketinin DecisionResult ile birebir
// eşleştiğini ve var olan hedef-bağlı "Alabilir miyim?" akışının bozulmadığını.
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
      persistent.debts = [];
      persistent.creditCards = [];
      month.incomes = s.income > 0 ? [{ id: 'i1', category: 'Maaş', amount: s.income }] : [];
      month.expenses = s.expenses > 0 ? [{ id: 'e1', category: 'Diğer', amount: s.expenses }] : [];
      persistent.goals = s.goals || [];
      render();
      setTab('goals');
    }, setup);
  }
  return { page, pageErrors };
}

// ---------------------------------------------------------------------
// 1. Visible entry point invokes the ad-hoc Decision Engine flow — no goals yet
// ---------------------------------------------------------------------
test('visible Home entry point ("Sor" button) opens the ad-hoc Decision Engine flow when there are no goals', async () => {
  const { page, pageErrors } = await newSession({ income: 80000, expenses: 30000, assets: 200000, goals: [] });
  await page.evaluate(() => { setTab('home'); render(); });
  const btn = await page.$('#homeAffordAdHocBtn');
  assert.ok(btn, '#homeAffordAdHocBtn must exist on the home afford teaser when there is no affordable goal');
  await btn.click();
  await page.waitForTimeout(300);
  const state = await page.evaluate(() => ({
    panelVisible: document.getElementById('goalAffordPanel').style.display === 'block',
    formVisible: document.getElementById('adHocAffordForm').style.display === 'block',
  }));
  assert.equal(state.panelVisible, true);
  assert.equal(state.formVisible, true);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// 1b. Product UX correction: "Sor" must ALSO be visible when the user already
// has an active, affordable goal — the ad-hoc question ("Bu arabayı/evi/tatili
// karşılayabilir miyim?") must always be answerable from this entry point,
// regardless of whether a tracked goal already exists.
// ---------------------------------------------------------------------
test('"Sor" (ad-hoc) button is ALSO visible on Home when an existing affordable goal is present, alongside the goal-linked "Check" button', async () => {
  const futureDate = new Date(Date.now() + 200 * 86400000).toISOString().slice(0, 10);
  const { page, pageErrors } = await newSession({
    income: 100000, expenses: 30000, assets: 300000,
    goals: [{ id: 'g1', typeKey: 'diger', name: 'Bilgisayar', targetAmount: 40000, targetDate: futureDate }],
  });
  await page.evaluate(() => { setTab('home'); render(); });
  const state = await page.evaluate(() => ({
    checkBtnExists: !!document.getElementById('homeAffordBtn'),
    adHocBtnExists: !!document.getElementById('homeAffordAdHocBtn'),
  }));
  assert.equal(state.checkBtnExists, true, 'the existing goal-linked "Check" button must remain present and unchanged');
  assert.equal(state.adHocBtnExists, true, '"Sor" must be visible even though an affordable goal already exists');

  // clicking "Sor" here must open the SAME ad-hoc flow, not a goal-linked one
  await page.click('#homeAffordAdHocBtn');
  await page.waitForTimeout(300);
  const flowState = await page.evaluate(() => ({
    formVisible: document.getElementById('adHocAffordForm').style.display === 'block',
    affordLastGoalIdIsNull: affordLastGoalId === null,
  }));
  assert.equal(flowState.formVisible, true);
  assert.equal(flowState.affordLastGoalIdIsNull, true, 'opening the ad-hoc flow from Home must not attach it to the existing goal');
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('with both buttons visible, clicking "Check" still opens the unchanged goal-linked afford flow (not the ad-hoc one)', async () => {
  const futureDate = new Date(Date.now() + 200 * 86400000).toISOString().slice(0, 10);
  const { page, pageErrors } = await newSession({
    income: 100000, expenses: 30000, assets: 300000,
    goals: [{ id: 'g1', typeKey: 'diger', name: 'Bilgisayar', targetAmount: 40000, targetDate: futureDate }],
  });
  await page.evaluate(() => { setTab('home'); render(); });
  await page.click('#homeAffordBtn');
  await page.waitForTimeout(300);
  const state = await page.evaluate(() => ({
    formVisible: document.getElementById('adHocAffordForm').style.display === 'block',
    affordLastGoalId,
    decisionCardHasContent: document.getElementById('affordDecisionCard').innerHTML.length > 0,
  }));
  assert.equal(state.formVisible, false, 'the ad-hoc input form must stay hidden for the goal-linked "Check" flow');
  assert.equal(state.affordLastGoalId, 'g1');
  assert.equal(state.decisionCardHasContent, true);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// 2. Ad-hoc decision does not create a persistent goal
// ---------------------------------------------------------------------
test('ad-hoc decision flow does not create or persist a fake goal', async () => {
  const { page, pageErrors } = await newSession({ income: 80000, expenses: 30000, assets: 200000, goals: [] });
  const result = await page.evaluate(() => {
    const goalsBefore = (persistent.goals || []).length;
    openAdHocAffordEntry();
    document.getElementById('adHocPrice').value = '15000';
    document.getElementById('adHocSubmitBtn').click();
    const goalsAfter = (persistent.goals || []).length;
    return { goalsBefore, goalsAfter, decisionPresent: !!(affordLastResult && affordLastResult.decision), affordLastGoalId };
  });
  await page.close();
  assert.equal(result.goalsBefore, 0);
  assert.equal(result.goalsAfter, 0, 'ad-hoc flow must not push anything into persistent.goals');
  assert.equal(result.decisionPresent, true);
  assert.equal(result.affordLastGoalId, null, 'ad-hoc decision must not be tied to a goal id');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// 3. User can enter a purchase amount through the visible form and receive a DecisionResult
// ---------------------------------------------------------------------
test('entering a price in the ad-hoc form and submitting produces a real DecisionResult', async () => {
  const { page, pageErrors } = await newSession({ income: 100000, expenses: 20000, assets: 500000, goals: [] });
  await page.evaluate(() => { setTab('home'); render(); });
  await page.click('#homeAffordAdHocBtn');
  await page.waitForTimeout(200);
  await page.fill('#adHocPrice', '5000');
  await page.fill('#adHocDownPayment', '5000');
  await page.click('#adHocSubmitBtn');
  await page.waitForTimeout(200);
  const decision = await page.evaluate(() => affordLastResult ? affordLastResult.decision : null);
  assert.ok(decision, 'submitting the ad-hoc form must populate affordLastResult.decision');
  assert.ok(['yes_today', 'yes_on_date', 'yes_with_condition', 'yes_delays_goals', 'no_unsafe'].includes(decision.answerCategory));
  assert.equal(decision.sourceEngineVersion, 1);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('ad-hoc form correctly passes financing and recurring monthly cost through to the Decision Engine', async () => {
  const { page } = await newSession({ income: 100000, expenses: 20000, assets: 500000, goals: [] });
  await page.evaluate(() => { openAdHocAffordEntry(); });
  await page.fill('#adHocPrice', '60000');
  await page.fill('#adHocDownPayment', '10000');
  await page.check('#adHocFinancingToggle');
  await page.fill('#adHocMonths', '12');
  await page.fill('#adHocRatePct', '3');
  await page.fill('#adHocRecurringCost', '2000');
  await page.click('#adHocSubmitBtn');
  await page.waitForTimeout(200);
  const decision = await page.evaluate(() => affordLastResult.decision);
  await page.close();
  // monthlyImpact must include BOTH the computed installment AND the recurring cost (2000 floor)
  assert.ok(decision.monthlyImpact >= 2000, `monthlyImpact ${decision.monthlyImpact} should include the recurring cost`);
});

// ---------------------------------------------------------------------
// 4. Displayed category matches the deterministic DecisionResult
// ---------------------------------------------------------------------
test('the displayed category badge text matches DecisionResult.answerCategory exactly', async () => {
  const { page, pageErrors } = await newSession({ income: 20000, expenses: 20000, assets: 10000, goals: [] }); // guaranteed no_unsafe (zero cash flow)
  await page.evaluate(() => { openAdHocAffordEntry(); });
  await page.fill('#adHocPrice', '50000');
  await page.fill('#adHocDownPayment', '50000');
  await page.click('#adHocSubmitBtn');
  await page.waitForTimeout(200);
  const check = await page.evaluate(() => {
    const decision = affordLastResult.decision;
    const badgeHtml = document.getElementById('decisionCategoryBadge').innerHTML;
    const expectedLabel = decisionCategoryLabel(decision.answerCategory, decision.affordabilityDate, currentLang === 'en');
    return { answerCategory: decision.answerCategory, badgeHtml, expectedLabel, badgeContainsExpected: badgeHtml.includes(expectedLabel) };
  });
  await page.close();
  assert.equal(check.answerCategory, 'no_unsafe');
  assert.ok(check.badgeHtml.length > 0, 'category badge must be rendered');
  assert.ok(check.badgeContainsExpected, `badge HTML "${check.badgeHtml}" should contain the exact template-derived label "${check.expectedLabel}"`);
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('the displayed category badge updates correctly for a yes_today case with real app data', async () => {
  const { page } = await newSession({ income: 100000, expenses: 20000, assets: 500000, goals: [] });
  await page.evaluate(() => { openAdHocAffordEntry(); });
  await page.fill('#adHocPrice', '2000');
  await page.fill('#adHocDownPayment', '2000');
  await page.click('#adHocSubmitBtn');
  await page.waitForTimeout(200);
  const check = await page.evaluate(() => {
    const decision = affordLastResult.decision;
    const badgeHtml = document.getElementById('decisionCategoryBadge').innerHTML;
    return { answerCategory: decision.answerCategory, badgeHtml };
  });
  await page.close();
  assert.equal(check.answerCategory, 'yes_today');
  assert.ok(/Bugün alabilirsin/.test(check.badgeHtml) || /buy this today/i.test(check.badgeHtml), check.badgeHtml);
});

// ---------------------------------------------------------------------
// 5. Existing goal-linked afford flow still works (no regression)
// ---------------------------------------------------------------------
test('existing goal-linked "Alabilir miyim?" flow (openGoalAfford) still renders correctly and now also carries a consistent DecisionResult', async () => {
  const futureDate = new Date(Date.now() + 200 * 86400000).toISOString().slice(0, 10);
  const { page, pageErrors } = await newSession({
    income: 100000, expenses: 30000, assets: 300000,
    goals: [{ id: 'g1', typeKey: 'diger', name: 'Bilgisayar', targetAmount: 40000, targetDate: futureDate }],
  });
  const check = await page.evaluate(() => {
    openGoalAfford('g1');
    const dc = document.getElementById('affordDecisionCard');
    const badge = document.getElementById('decisionCategoryBadge');
    const adHocFormVisible = document.getElementById('adHocAffordForm').style.display === 'block';
    return {
      panelVisible: document.getElementById('goalAffordPanel').style.display === 'block',
      decisionCardHasContent: dc.innerHTML.length > 0,
      badgeHasContent: badge.innerHTML.length > 0,
      decision: affordLastResult.decision,
      affordLastGoalId,
      adHocFormVisible,
      cap: getAffordCapacityInfo().monthlyCashFlow,
    };
  });
  await page.close();
  assert.equal(check.panelVisible, true);
  assert.equal(check.decisionCardHasContent, true, 'existing computeAffordability-based decision card must still render');
  assert.equal(check.affordLastGoalId, 'g1');
  assert.equal(check.adHocFormVisible, false, 'ad-hoc input form must stay hidden for a real goal-linked flow');
  assert.ok(check.decision, 'goal-linked flow must also carry a Decision Engine result');
  assert.equal(check.badgeHasContent, true);
  // consistency requirement (§8): the same canonical cash-flow underlies both computeAffordability and Decision Engine
  assert.equal(check.decision.cashFlowAfterDecision <= check.cap, true);
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('closing the afford panel hides the ad-hoc form so it does not linger for the next open', async () => {
  const { page } = await newSession({ income: 80000, expenses: 30000, assets: 200000, goals: [] });
  await page.evaluate(() => { openAdHocAffordEntry(); });
  await page.evaluate(() => { closeGoalAffordPanel(); });
  const visible = await page.evaluate(() => document.getElementById('adHocAffordForm').style.display);
  await page.close();
  assert.equal(visible, 'none');
});
