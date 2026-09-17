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

// =======================================================================
// REAL UI TEST FIX REGRESSION — first real user-flow test found 4 display bugs
// for this exact scenario: price=2,000,000, downPayment=500,000, liquid=0,
// safeMonthlyCapacity=0 (income===expenses, no accounts). DecisionResult must be
// `no_unsafe`. None of the UI surfaces may contradict that.
// =======================================================================
test('REAL SCENARIO (price=2M, downPayment=500k, liquid=0, safeMonthlyCapacity=0): DecisionResult is no_unsafe and nothing on screen contradicts it', async () => {
  const { page, pageErrors } = await newSession({ income: 50000, expenses: 50000, assets: 0, goals: [] });
  const check = await page.evaluate(() => {
    const cap = getAffordCapacityInfo();
    openAdHocAffordEntry();
    document.getElementById('adHocPrice').value = '2000000';
    document.getElementById('adHocDownPayment').value = '500000';
    document.getElementById('adHocSubmitBtn').click();
    const r = affordLastResult;

    // Fix #1: capture every fillText() call made while drawing the share card,
    // so we can prove the canvas itself never renders the contradictory string —
    // not just that the underlying data would support the right one.
    const shareTexts = [];
    const proto = CanvasRenderingContext2D.prototype;
    const origFillText = proto.fillText;
    proto.fillText = function(text, ...args) { shareTexts.push(text); return origFillText.apply(this, [text, ...args]); };
    try { drawAffordShareCard(r, false); } finally { proto.fillText = origFillText; }

    return {
      safeMonthlyCapacity: cap.safeMonthlyCapacity,
      liquid: cap.liquid,
      financedAmount: r.financedAmount,
      decisionCategory: r.decision ? r.decision.answerCategory : null,
      etaState: affordEtaState(r, false),
      decisionCardHtml: document.getElementById('affordDecisionCard').innerHTML,
      financeBoxHtml: document.getElementById('affordFinanceBox').innerHTML,
      shareTexts,
    };
  });
  await page.close();

  assert.equal(check.safeMonthlyCapacity, 0);
  assert.equal(check.liquid, 0);
  assert.equal(check.financedAmount, 1500000);
  // DecisionResult must remain unsafe for this scenario
  assert.equal(check.decisionCategory, 'no_unsafe');

  // Fix #1: never "Already there" / "Zaten yeterli" when the deterministic decision is unsafe
  assert.notEqual(check.etaState.text, 'Zaten yeterli');
  assert.notEqual(check.etaState.text, 'Already there');
  assert.ok(!/Zaten yeterli/i.test(check.decisionCardHtml), 'stat card must not show "Zaten yeterli" for an unsafe decision');
  assert.ok(!check.shareTexts.includes('Zaten yeterli'), 'share card canvas must not draw "Zaten yeterli" for an unsafe decision');
  assert.ok(!check.shareTexts.includes('Already there'));

  // Fix #3: financing card must use explicit, non-contradictory terminology
  assert.ok(/Satın alma fiyatı/.test(check.financeBoxHtml), 'own-savings card must show the purchase price explicitly');
  assert.ok(/Kalan tutar/.test(check.financeBoxHtml), 'own-savings card must label the remaining amount "Kalan tutar", not "Tahmini toplam maliyet"');
  assert.ok(/Finansman ödeme toplamı/.test(check.financeBoxHtml), 'bank/org financing cards must distinguish financing-only total from full purchase cost');
  assert.ok(/Peşinat dahil toplam nakit çıkışı/.test(check.financeBoxHtml), 'a total-cash-outlay-including-down-payment figure must be shown');

  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('REAL SCENARIO: "Bu alım için aylık taahhüt" is never a bare, unexplained ₺0 when no monthly pace has been set', async () => {
  const { page, pageErrors } = await newSession({ income: 50000, expenses: 50000, assets: 0, goals: [] });
  const html = await page.evaluate(() => {
    openAdHocAffordEntry();
    document.getElementById('adHocPrice').value = '2000000';
    document.getElementById('adHocDownPayment').value = '500000';
    document.getElementById('adHocSubmitBtn').click();
    return document.getElementById('affordDecisionCard').innerHTML;
  });
  await page.close();
  assert.ok(/Bu alım için aylık taahhüt/.test(html), 'the label must be renamed away from the ambiguous "gereken" (needed) wording');
  assert.ok(/hiç aylık pay ayrılmadı/.test(html), 'the ₺0 value must be explained, not shown bare');
  assert.ok(/Finansal güvenlik sonucu/.test(html), 'safe capacity, monthly commitment and the safety result must be three distinct, explicitly labeled rows');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// Fix #4 — the "Tasarruf Finansmanı" (savings organization financing) default
// must never default to an absurd ₺1/month payment for a large financed amount,
// which previously produced a 1,680,000-month "duration". This tests the
// PARAMETER MAPPING fix (the default value source), not a UI clamp.
// ---------------------------------------------------------------------
test('Savings-organization financing default payment is never an absurd ₺1, and never yields a nonsensical multi-hundred-thousand-month duration', async () => {
  const { page, pageErrors } = await newSession({ income: 50000, expenses: 50000, assets: 0, goals: [] });
  const check = await page.evaluate(() => {
    openAdHocAffordEntry();
    document.getElementById('adHocPrice').value = '2000000';
    document.getElementById('adHocDownPayment').value = '500000';
    document.getElementById('adHocSubmitBtn').click();
    const defaultMonthly = parseFormattedNumber(document.getElementById('affordOrgMonthly').value);
    const resultHtml = document.getElementById('affordOrgResult').innerHTML;
    // pull the rendered duration (e.g. "27 ay") back out to sanity-check it directly too
    const durationMatch = resultHtml.match(/(\d+)\s*ay/);
    return { defaultMonthly, resultHtml, durationMonths: durationMatch ? parseInt(durationMatch[1], 10) : null };
  });
  await page.close();

  // root cause was defaulting to Math.max(1, Math.round(r.maxMonthly)) === ₺1 when safeMonthlyCapacity is 0
  assert.ok(check.defaultMonthly > 1000, `default monthly payment must not collapse to a trivial amount like ₺1 (got ${check.defaultMonthly})`);
  assert.ok(check.durationMonths !== null, 'a duration must be rendered for the default inputs');
  // reasonable testable cap for a normal financing scenario — a sane default term must never run into hundreds of thousands of months
  assert.ok(check.durationMonths < 600, `duration must not be a nonsensical value like 1,680,000 months (got ${check.durationMonths})`);
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('existing Decision Engine answer categories remain unchanged for a straightforward affordable case (regression guard)', async () => {
  const { page, pageErrors } = await newSession({ income: 100000, expenses: 20000, assets: 500000, goals: [] });
  const category = await page.evaluate(() => {
    openAdHocAffordEntry();
    document.getElementById('adHocPrice').value = '2000';
    document.getElementById('adHocDownPayment').value = '2000';
    document.getElementById('adHocSubmitBtn').click();
    return affordLastResult.decision.answerCategory;
  });
  await page.close();
  assert.equal(category, 'yes_today');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// =======================================================================
// PRODUCTION UI REVIEW FIX REGRESSION — "Ad-hoc Karar" was leaking developer
// terminology into user-visible text, and the share card had a wrong/generic
// icon, text overflow and a semantically wrong "Hedef: Ad-hoc Karar" line.
// =======================================================================

test('no user-visible "Ad-hoc Karar" / "Ad-hoc Decision" remains anywhere in the ad-hoc purchase flow', async () => {
  const { page, pageErrors } = await newSession({ income: 80000, expenses: 30000, assets: 200000, goals: [] });
  const visibleText = await page.evaluate(() => {
    setTab('home'); render();
    document.getElementById('homeAffordAdHocBtn').click();
    document.getElementById('adHocPrice').value = '5000';
    document.getElementById('adHocSubmitBtn').click();
    return document.body.innerText;
  });
  await page.close();
  assert.ok(!/Ad-hoc Karar/i.test(visibleText), 'no visible text may contain the developer term "Ad-hoc Karar"');
  assert.ok(!/Ad-hoc Decision/i.test(visibleText), 'no visible text may contain the developer term "Ad-hoc Decision"');
  assert.ok(/Alabilir miyim\?/.test(visibleText), 'the page title must use the product-facing name "Alabilir miyim?"');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('share card uses the real FullBudget logo asset (same DOM asset as splash/auth), not a category emoji', async () => {
  const { page, pageErrors } = await newSession({ income: 80000, expenses: 30000, assets: 200000, goals: [] });
  const check = await page.evaluate(async () => {
    openAdHocPurchaseDecision({ category: 'diger', price: 5000, downPayment: 0 });
    const logoImg = await ensureAffordShareLogoLoaded();
    const expectedSrc = document.querySelector('.splash-logo-img, .auth-logo, .brand-mark-img, .settings-brand-logo').src;

    const drawImageCalls = [];
    const proto = CanvasRenderingContext2D.prototype;
    const origDrawImage = proto.drawImage;
    proto.drawImage = function(img, ...args) { drawImageCalls.push(img && img.src); return origDrawImage.apply(this, [img, ...args]); };
    try { drawAffordShareCard(affordLastResult, false); } finally { proto.drawImage = origDrawImage; }

    return { logoLoaded: !!logoImg, expectedSrc, drawImageCalls };
  });
  await page.close();
  assert.ok(check.logoLoaded, 'the real brand logo asset must load successfully');
  assert.ok(check.drawImageCalls.length > 0, 'the share card must draw an image (the real logo), not skip straight to emoji text');
  assert.ok(check.drawImageCalls.includes(check.expectedSrc), 'the drawn image must be the exact same asset used by the splash/auth screens, not a recreated logo');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('share card contains "Satın Alma Kararı" for the ad-hoc flow, never "Hedef: Ad-hoc Karar"', async () => {
  const { page, pageErrors } = await newSession({ income: 80000, expenses: 30000, assets: 200000, goals: [] });
  const shareTexts = await page.evaluate(() => {
    openAdHocPurchaseDecision({ category: 'diger', price: 5000, downPayment: 0 });
    const calls = [];
    const proto = CanvasRenderingContext2D.prototype;
    const orig = proto.fillText;
    proto.fillText = function(text, ...args) { calls.push(text); return orig.apply(this, [text, ...args]); };
    try { drawAffordShareCard(affordLastResult, false); } finally { proto.fillText = orig; }
    return calls;
  });
  await page.close();
  assert.ok(shareTexts.includes('Satın Alma Kararı'), 'the share card must show "Satın Alma Kararı" for an ad-hoc decision');
  assert.ok(!shareTexts.some(t => /Ad-hoc/i.test(t)), 'no drawn share-card text may contain "Ad-hoc"');
  assert.ok(!shareTexts.some(t => /^Hedef:/.test(t)), 'the ad-hoc share card must not use "Hedef:" (goal) terminology');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('long ETA / decision text wraps on the share card and never exceeds the canvas content width', async () => {
  const { page, pageErrors } = await newSession({ income: 50000, expenses: 50000, assets: 0, goals: [] });
  const check = await page.evaluate(() => {
    // Kısıtlama testi: yardımcı fonksiyonun kendisi, gerçek metinlerden çok daha uzun,
    // suni bir cümleyle bile taşma üretmediğini kanıtlar.
    const canvas = document.createElement('canvas');
    canvas.width = 1080; canvas.height = 1920;
    const ctx = canvas.getContext('2d');
    const maxWidth = 920;
    const veryLongText = 'Mevcut tempoda ulaşılamıyor çünkü bu satın alma için hiçbir aylık pay ayrılmamış ve bu çok daha uzun bir örnek açıklama cümlesi olarak devam ediyor';
    const wrap = affordWrapCanvasText(ctx, veryLongText, maxWidth, {maxFontPx:84, minFontPx:44, maxLines:3, weight:700});
    ctx.font = `700 ${wrap.fontPx}px "Space Grotesk", sans-serif`;
    const widths = wrap.lines.map(l => ctx.measureText(l).width);

    // Uçtan uca gerçek senaryo: bu tam olarak kullanıcı UI testinin gösterdiği metin.
    openAdHocPurchaseDecision({ category: 'diger', price: 2000000, downPayment: 500000 });
    const fillTextCalls = [];
    const proto = CanvasRenderingContext2D.prototype;
    const origFillText = proto.fillText;
    proto.fillText = function(text, x, ...rest) { fillTextCalls.push({text, x, font: this.font}); return origFillText.apply(this, [text, x, ...rest]); };
    try { drawAffordShareCard(affordLastResult, false); } finally { proto.fillText = origFillText; }
    const realCanvas = document.getElementById('affordShareCanvas');
    const realCtx = realCanvas.getContext('2d');
    const overflowing = fillTextCalls.filter(c => {
      realCtx.font = c.font;
      const w = realCtx.measureText(c.text).width;
      return w > realCanvas.width - 40; // kenarlardan en az 20px pay
    });

    return { widths, maxWidth, wrapFontPx: wrap.fontPx, overflowingCount: overflowing.length, overflowing: overflowing.map(o=>o.text) };
  });
  await page.close();
  assert.ok(check.widths.every(w => w <= check.maxWidth + 1), `every wrapped line must fit within maxWidth (got widths ${JSON.stringify(check.widths)} vs maxWidth ${check.maxWidth})`);
  assert.ok(check.wrapFontPx >= 44, 'font must not shrink below the readable minimum');
  assert.equal(check.overflowingCount, 0, `no share-card text may exceed the canvas width: ${JSON.stringify(check.overflowing)}`);
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('share card and the visible Decision Engine UI show the exact same decision category (single source of truth)', async () => {
  const { page, pageErrors } = await newSession({ income: 50000, expenses: 50000, assets: 0, goals: [] });
  const check = await page.evaluate(() => {
    openAdHocPurchaseDecision({ category: 'diger', price: 2000000, downPayment: 500000 });
    const r = affordLastResult;
    const visibleCategory = r.decision.answerCategory;
    const visibleEta = affordEtaState(r, false).text;
    const badgeHtml = document.getElementById('decisionCategoryBadge').innerHTML;

    const shareTexts = [];
    const proto = CanvasRenderingContext2D.prototype;
    const orig = proto.fillText;
    proto.fillText = function(text, ...args) { shareTexts.push(text); return orig.apply(this, [text, ...args]); };
    try { drawAffordShareCard(r, false); } finally { proto.fillText = orig; }

    return { visibleCategory, visibleEta, badgeHtml, shareTexts };
  });
  await page.close();
  assert.equal(check.visibleCategory, 'no_unsafe');
  assert.ok(check.badgeHtml.includes('güvenli değil'), 'visible category badge must reflect no_unsafe');
  assert.ok(check.shareTexts.includes(check.visibleEta), 'share card ETA text must be the exact same string as the visible affordEtaState() result');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('existing real-goal share cards are not broken by the terminology/logo changes', async () => {
  const futureDate = new Date(Date.now() + 200 * 86400000).toISOString().slice(0, 10);
  const { page, pageErrors } = await newSession({
    income: 100000, expenses: 30000, assets: 300000,
    goals: [{ id: 'g1', typeKey: 'diger', name: 'Bilgisayar', targetAmount: 40000, targetDate: futureDate }],
  });
  const check = await page.evaluate(() => {
    openGoalAfford('g1');
    const shareTexts = [];
    const proto = CanvasRenderingContext2D.prototype;
    const orig = proto.fillText;
    let threw = null;
    proto.fillText = function(text, ...args) { shareTexts.push(text); return orig.apply(this, [text, ...args]); };
    try { drawAffordShareCard(affordLastResult, false); } catch (e) { threw = e.message; } finally { proto.fillText = orig; }
    return { shareTexts, threw };
  });
  await page.close();
  assert.equal(check.threw, null, `drawing a real-goal share card must not throw: ${check.threw}`);
  assert.ok(check.shareTexts.some(t => t.startsWith('Hedef:')), 'a real, persisted goal must still show "Hedef: <name>" on its share card');
  assert.ok(!check.shareTexts.includes('Satın Alma Kararı'), 'a real goal share card must not show the ad-hoc "Satın Alma Kararı" label');
  assert.ok(check.shareTexts.includes('FullBudget'), 'the brand footer must still render');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// UNIFICATION — Home "Sor" and Left Navigation "Alabilir miyim?" must be
// ONE product with ONE deterministic Decision Engine path. navAlabilirMiAc()
// (the left-nav data-action="afford" handler) previously referenced a
// non-existent `primary.type` field (pickPrimaryGoal() returns {g, info},
// never `.type`) so its real-goal branch was permanently dead code, AND its
// fallback branch never called openAdHocAffordEntry() — leaving a user with
// no affordable goal stranded on the bare Goals tab with no path to the
// ad-hoc form at all. These tests prove both entry points now converge on
// the exact same functions/DOM/DecisionResult for identical input.
// ---------------------------------------------------------------------

// A/B/C/D. Left-nav "Alabilir miyim?" (no existing affordable goal) must open
// the SAME ad-hoc Decision Engine form as Home's "Sor" button.
test('Left navigation "Alabilir miyim?" opens the ad-hoc Decision Engine form when there is no affordable goal (was previously stranding the user on the bare Goals tab)', async () => {
  const { page, pageErrors } = await newSession({ income: 80000, expenses: 30000, assets: 200000, goals: [] });
  await page.evaluate(() => { setTab('home'); render(); });
  const clicked = await page.evaluate(() => {
    const btn = document.querySelector('#navDrawer [data-action="afford"]');
    if (!btn) return false;
    btn.click();
    return true;
  });
  assert.equal(clicked, true, '#navDrawer [data-action="afford"] must exist in the DOM (rendered by navExtraMenuHtml via renderNav)');
  await page.waitForTimeout(300);
  const state = await page.evaluate(() => ({
    panelVisible: document.getElementById('goalAffordPanel').style.display === 'block',
    formVisible: document.getElementById('adHocAffordForm').style.display === 'block',
  }));
  assert.equal(state.panelVisible, true, 'left-nav must open the shared #goalAffordPanel, same as Home "Sor"');
  assert.equal(state.formVisible, true, 'left-nav must open the shared #adHocAffordForm, same as Home "Sor"');
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// H. Existing goal-linked affordability must still work from the left-nav —
// and now ACTUALLY work, since `primary.type` was never populated before.
test('Left navigation "Alabilir miyim?" opens the real goal-linked affordability flow when an affordable goal exists (fixes the previously-dead primary.type branch)', async () => {
  const futureDate = new Date(Date.now() + 200 * 86400000).toISOString().slice(0, 10);
  const { page, pageErrors } = await newSession({
    income: 80000, expenses: 30000, assets: 0,
    goals: [{ id: 'g1', typeKey: 'diger', name: 'Bilgisayar', targetAmount: 40000, targetDate: futureDate }],
  });
  await page.evaluate(() => { setTab('home'); render(); });
  await page.evaluate(() => { document.querySelector('#navDrawer [data-action="afford"]').click(); });
  await page.waitForTimeout(300);
  const state = await page.evaluate(() => ({
    panelVisible: document.getElementById('goalAffordPanel').style.display === 'block',
    formVisible: document.getElementById('adHocAffordForm').style.display,
    title: document.getElementById('goalAffordTitle').innerHTML,
    hasResult: !!affordLastResult,
  }));
  assert.equal(state.panelVisible, true);
  assert.notEqual(state.formVisible, 'block', 'a real goal must show the goal-linked view, not the ad-hoc form');
  assert.ok(/Diğer/.test(state.title) && !/🧮/.test(state.title), 'left-nav must open the SAME real goal ("Diğer" category, real goal icon) that Home would resolve as primary, not the generic 🧮 ad-hoc entry');
  assert.ok(state.hasResult, 'opening a real goal via left-nav must still produce a DecisionResult');
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// C/E + MANDATORY REGRESSION. Same financial state through (1) Home → Sor and
// (2) Left navigation → Alabilir miyim? must yield: same input form, the
// identical deterministic DecisionResult, the same decision category, the
// same ETA state, and no persistent goal created by either path.
test('MANDATORY REGRESSION: Home "Sor" and Left-nav "Alabilir miyim?" produce an identical DecisionResult, category and ETA state for the same input, and neither persists a goal', async () => {
  const setup = { income: 90000, expenses: 40000, assets: 150000, goals: [] };
  const purchase = { price: 60000, downPayment: 10000 };

  // Path 1: Home "Sor"
  const home = await newSession(setup);
  await home.page.evaluate(() => { setTab('home'); render(); });
  await home.page.evaluate(() => { document.getElementById('homeAffordAdHocBtn').click(); });
  await home.page.waitForTimeout(300); // renderAffordTeaser()'ın "Sor" tetikleyicisi 120ms setTimeout kullanıyor
  const homeResult = await home.page.evaluate((p) => {
    document.getElementById('adHocPrice').value = String(p.price);
    document.getElementById('adHocDownPayment').value = String(p.downPayment);
    document.getElementById('adHocSubmitBtn').click();
    return {
      decision: affordLastResult ? affordLastResult.decision : null,
      category: affordLastResult ? affordLastResult.category : null,
      badgeHtml: document.getElementById('decisionCategoryBadge').innerHTML,
      etaText: affordLastResult ? affordEtaState(affordLastResult, false).text : null,
      goalsCount: persistent.goals.length,
      formVisible: document.getElementById('adHocAffordForm').style.display === 'block',
    };
  }, purchase);
  await home.page.close();
  assert.equal(pageErrors_ok(home.pageErrors), true, JSON.stringify(home.pageErrors));

  // Path 2: Left navigation "Alabilir miyim?"
  const nav = await newSession(setup);
  await nav.page.evaluate(() => { setTab('home'); render(); });
  await nav.page.evaluate(() => { document.querySelector('#navDrawer [data-action="afford"]').click(); });
  await nav.page.waitForTimeout(300); // navAlabilirMiAc() de AYNI 120ms setTimeout desenini kullanıyor
  const navResult = await nav.page.evaluate((p) => {
    document.getElementById('adHocPrice').value = String(p.price);
    document.getElementById('adHocDownPayment').value = String(p.downPayment);
    document.getElementById('adHocSubmitBtn').click();
    return {
      decision: affordLastResult ? affordLastResult.decision : null,
      category: affordLastResult ? affordLastResult.category : null,
      badgeHtml: document.getElementById('decisionCategoryBadge').innerHTML,
      etaText: affordLastResult ? affordEtaState(affordLastResult, false).text : null,
      goalsCount: persistent.goals.length,
      formVisible: document.getElementById('adHocAffordForm').style.display === 'block',
    };
  }, purchase);
  await nav.page.close();
  assert.equal(pageErrors_ok(nav.pageErrors), true, JSON.stringify(nav.pageErrors));

  assert.equal(homeResult.formVisible, true, 'Home path must reach the same #adHocAffordForm');
  assert.equal(navResult.formVisible, true, 'Left-nav path must reach the same #adHocAffordForm');
  assert.deepEqual(navResult.decision, homeResult.decision, 'identical financial input through both entry points must produce the exact same DecisionResult');
  assert.equal(navResult.category.tr, homeResult.category.tr, 'both entry points must show the same category label');
  assert.equal(navResult.badgeHtml, homeResult.badgeHtml, 'both entry points must render the same category badge');
  assert.equal(navResult.etaText, homeResult.etaText, 'both entry points must show the same ETA state');
  assert.equal(homeResult.goalsCount, 0, 'Home "Sor" must not persist a goal');
  assert.equal(navResult.goalsCount, 0, 'Left-nav "Alabilir miyim?" must not persist a goal');
});
function pageErrors_ok(errs) { return errs.length === 0; }

// F. Home "Hedef Ekle" must still open the existing Goals flow, unmerged with
// the Decision Engine — the two actions stay separate per product requirements.
test('Home "Hedef Ekle" still opens the Goals flow (not merged into the Decision Engine)', async () => {
  const { page, pageErrors } = await newSession({ income: 80000, expenses: 30000, assets: 200000, goals: [] });
  await page.evaluate(() => { setTab('home'); render(); });
  const btn = await page.$('#homeAffordGoToGoalsBtn');
  assert.ok(btn, '#homeAffordGoToGoalsBtn ("Hedef Ekle") must still exist alongside "Sor"');
  await btn.click();
  await page.waitForTimeout(200);
  const state = await page.evaluate(() => ({
    tab: aktifYaprak(),
    adHocFormVisible: document.getElementById('adHocAffordForm') && document.getElementById('adHocAffordForm').style.display === 'block',
  }));
  assert.equal(state.tab, 'goals', '"Hedef Ekle" must land on the Goals tab');
  assert.notEqual(state.adHocFormVisible, true, '"Hedef Ekle" must NOT open the ad-hoc Decision Engine form');
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});
