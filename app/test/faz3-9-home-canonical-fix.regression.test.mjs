// FAZ 3.9 — İKİ ANA SAYFA HATASININ DÜZELTİLMESİ REGRESYONU
// -----------------------------------------------------------------------
// Bu dosya, ana sayfada rapor edilen İKİ görsel/sunum hatasını doğrular. HİÇBİR finansal motor
// DEĞİŞTİRİLMEDİ — yalnızca sunum katmanı (Sıradaki Adımım'ın gösterdiği tutar, Net Varlık bilgi
// rozetinin görünürlüğü) düzeltildi.
//
// HATA 1 — CANONICAL TUTAR UYUŞMAZLIĞI:
//   "Sıradaki Adımım" (computePriorityPlan/_planKur'un KENDİ waterfall'ından) ve "Bu Ayki Planım"
//   (runGoalCashAllocationEngine() canonical sonucundan) aynı finansal durum için FARKLI tutarlar
//   gösterebiliyordu. Kök neden FAZ 3.3'te yalnızca 'acil_fon' kategorisi için düzeltilmişti;
//   'borç'/'hedef'/'yatırım (serbest tutar)' kategorilerinde aynı yapısal sorun (iki bağımsız
//   waterfall'ın AYNI soruya farklı cevap vermesi) hâlâ sızabiliyordu. Düzeltme:
//   reconcileStepWithCanonicalAllocation()/reconcilePersistedEmergencyTask(), "Bu Ayki Planım"ın
//   zaten kullandığı 4 canonical aday satıra (emergencyRow/debtRow/goalRow/flexRow) genelleştirildi
//   (bkz. MONEY_TASK_CANONICAL_ROW_BY_CATEGORY). Adımın kategorisine canonical bir karşılık YOKSA
//   (ör. bu senaryoda GCAE'nin hiç allocation üretmediği düşük/sıfır faizli bir borç), adım
//   OLDUĞU GİBİ kalır — zorla bir eşleştirme İCAT EDİLMEZ (bkz. test 3).
//
// HATA 2 — BOŞ UYARI/BİLGİ POPOVER'I:
//   "FİNANSAL DURUM" kartındaki net varlık likidite bilgi rozeti (#netWorthLiquidityBadge),
//   varlık yokken (assets<=0) JS `badge.hidden = true` yapıyordu ama `.info-badge{display:
//   inline-flex}` kuralı tarayıcının `[hidden]{display:none}` kuralıyla AYNI özgüllükte olduğu
//   için rozet GÖRÜNÜR kalıyordu — tıklanınca içeriği hiç doldurulmamış BOŞ bir popover açılıyordu.
//   Düzeltme: `.info-badge[hidden]{display:none;}` eklendi (dosyadaki .ses-sheet/.confirm-backdrop/
//   #groupSegments için zaten var olan AYNI desen). Net varlık hesap formülü DEĞİŞMEDİ.
//
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
      month.expenses = s.expenses > 0 ? [{ id: 'e1', category: 'Diğer', amount: s.expenses }] : [];
      persistent.goals = s.goals || [];
      if (s.emergencyFundTarget != null) persistent.emergencyFundTarget = s.emergencyFundTarget;
      persistent.dailyMoneyTask = null; // sıfırdan kurulsun
      setTab('home');
      render();
    }, setup);
  }
  return { page, pageErrors };
}

// EMERGENCY_SCENARIO'nun aynısı ama küçük bir düşük/sıfır faizli kart borcu içeriyor: canonical
// GCAE bu borç için HİÇ allocation üretmiyor (acil fon + serbest tutara gidiyor), oysa
// computePriorityPlan/_planKur'un KENDİ "diğer borçlara ödeme" adımı ORANDAN BAĞIMSIZ her zaman
// bir pay ayırıyor — tam olarak iki bağımsız waterfall'ın AYNI ay için FARKLI tutarlar ürettiği,
// rapor edilen durumun yapısal örneği.
const DIVERGENT_SCENARIO = {
  income: 120000, expenses: 40000, assets: 65000,
  creditCards: [{ id: 'c1', name: 'Kart', currentBalance: 15000, limit: 100000, statementDay: 1, dueDay: 10 }],
  emergencyFundTarget: 72000,
};

// ---------------------------------------------------------------------
// 1. Fresh state: "Sıradaki Adımım" ve "Bu Ayki Planım" en üstteki (acil fon) kararda
// zaten aynı tutarı gösteriyor olmalı (FAZ 3.3'ten beri çalışıyordu, regresyon değil).
// ---------------------------------------------------------------------
test('FAZ3.9-1: fresh "Sıradaki Adımım" matches the canonical top-priority amount shown in "Bu Ayki Planım"', async () => {
  const { page, pageErrors } = await newSession(DIVERGENT_SCENARIO);
  const check = await page.evaluate(() => {
    const canonical = runMonthlyGoalCashAllocationLive();
    const emergencyRow = canonical.allocations.find(a => a.type === 'emergency_fund_contribution' && a.amount > 1);
    return {
      taskAmount: persistent.dailyMoneyTask.task.amount,
      taskCategory: persistent.dailyMoneyTask.task.category,
      canonicalAmount: emergencyRow ? emergencyRow.amount : null,
      planSubAmountText: document.querySelector('#monthlyPlanSummary .hero-row b')?.textContent,
    };
  });
  await page.close();
  assert.equal(check.taskCategory, 'acil_fon');
  assert.equal(check.taskAmount, check.canonicalAmount);
  assert.ok(check.planSubAmountText.includes(Math.round(check.canonicalAmount).toLocaleString('tr-TR')),
    `"Bu Ayki Planım" sub-line ("${check.planSubAmountText}") must show the same canonical amount`);
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// 2. THE REPORTED BUG: once the user works through the plan and reaches the "flexible /
// plannable amount" step (category 'yatirim'), it must show the SAME canonical figure as
// "Bu Ayki Planım" — not computePriorityPlan/_planKur's own (structurally smaller) leftover.
// ---------------------------------------------------------------------
test('FAZ3.9-2: the "plannable amount" step ("Sıradaki Adımım") reconciles to the canonical flexible allocation, not _planKur\'s own smaller leftover', async () => {
  const { page, pageErrors } = await newSession(DIVERGENT_SCENARIO);
  const check = await page.evaluate(() => {
    dismissMoneyTask(); // acil fon adımını atla -> "diğer borçlara ödeme" (canonical karşılığı yok, olduğu gibi kalmalı)
    const afterFirstDismiss = { ...persistent.dailyMoneyTask.task };
    dismissMoneyTask(); // onu da atla -> "Planlanabilir tutar" (category: 'yatirim')
    const afterSecondDismiss = { ...persistent.dailyMoneyTask.task };
    const rawStep = _planCache.steps.find(s => s.category === 'yatirim');
    const canonical = runMonthlyGoalCashAllocationLive();
    const flexRow = canonical.allocations.find(a => a.type === 'long_term_or_flexible' && a.amount > 1);
    return {
      afterFirstDismissCategory: afterFirstDismiss.category,
      afterFirstDismissAmount: afterFirstDismiss.amount,
      afterSecondDismissCategory: afterSecondDismiss.category,
      afterSecondDismissAmount: afterSecondDismiss.amount,
      rawUnreconciledAmount: rawStep ? rawStep.amount : null,
      flexRowAmount: flexRow ? flexRow.amount : null,
    };
  });
  await page.close();
  // sanity: this scenario really does produce a divergence between the two independent engines
  // (otherwise the test would pass even without the fix, and prove nothing).
  assert.notEqual(check.rawUnreconciledAmount, check.flexRowAmount,
    'sanity: computePriorityPlan\'s own leftover must differ from the canonical flexible amount for this to be a meaningful regression test');
  assert.equal(check.afterFirstDismissCategory, 'borc');
  assert.equal(check.afterSecondDismissCategory, 'yatirim');
  assert.equal(check.afterSecondDismissAmount, check.flexRowAmount,
    `"Sıradaki Adımım" (${check.afterSecondDismissAmount}) must match the canonical flexible amount Bu Ayki Planım uses (${check.flexRowAmount}), not _planKur's own leftover (${check.rawUnreconciledAmount})`);
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// 3. A category with NO canonical counterpart in this state (the low/zero-rate card debt,
// which GCAE assigns no allocation to at all) is left alone — no invented number.
// ---------------------------------------------------------------------
test('FAZ3.9-3: a step whose category has no matching canonical allocation this month is left unreconciled (no invented figure)', async () => {
  const { page, pageErrors } = await newSession(DIVERGENT_SCENARIO);
  const check = await page.evaluate(() => {
    dismissMoneyTask(); // -> "diğer borçlara ödeme" (category: 'borc')
    const task = { ...persistent.dailyMoneyTask.task };
    const canonical = runMonthlyGoalCashAllocationLive();
    const debtRow = canonical.allocations.find(a => a.priority === 'P2' && a.relatedDebtId && a.amount > 1);
    const rawStep = _planCache.steps.find(s => s.ik === 'orta');
    return { taskAmount: task.amount, taskCategory: task.category, debtRowExists: !!debtRow, rawStepAmount: rawStep ? rawStep.amount : null };
  });
  await page.close();
  assert.equal(check.taskCategory, 'borc');
  assert.equal(check.debtRowExists, false, 'sanity: canonical GCAE must not have a matching debt_reduction row in this scenario');
  assert.equal(check.taskAmount, check.rawStepAmount, 'without a canonical counterpart, the step\'s own amount must be shown unmodified — never an invented one');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// 4. The net-worth liquidity info badge is never visible with an empty popover.
// ---------------------------------------------------------------------
test('FAZ3.9-4: the net-worth "!" info badge is not visible/clickable when there is nothing to show (assets<=0)', async () => {
  const { page, pageErrors } = await newSession({ income: 120000, expenses: 40000, assets: 0 });
  const check = await page.evaluate(() => {
    const badge = document.getElementById('netWorthLiquidityBadge');
    const pop = document.getElementById('netWorthLiquidityPop');
    const cs = getComputedStyle(badge);
    return { hiddenProp: badge.hidden, computedDisplay: cs.display, popHtml: pop.innerHTML };
  });
  await page.close();
  assert.equal(check.hiddenProp, true);
  assert.equal(check.computedDisplay, 'none', 'the badge must actually be invisible (not just carry the `hidden` attribute while a CSS rule overrides it)');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.9-5: when the net-worth info badge IS shown (assets>0), clicking it reveals real, non-empty content', async () => {
  const { page, pageErrors } = await newSession(DIVERGENT_SCENARIO);
  const before = await page.evaluate(() => {
    const badge = document.getElementById('netWorthLiquidityBadge');
    return { hidden: badge.hidden, display: getComputedStyle(badge).display };
  });
  assert.equal(before.hidden, false);
  assert.notEqual(before.display, 'none');
  await page.click('#netWorthLiquidityBadge');
  await page.waitForTimeout(150);
  const after = await page.evaluate(() => {
    const badge = document.getElementById('netWorthLiquidityBadge');
    const pop = document.getElementById('netWorthLiquidityPop');
    return { isOpen: badge.classList.contains('open'), popDisplay: getComputedStyle(pop).display, popText: pop.textContent.trim() };
  });
  await page.close();
  assert.equal(after.isOpen, true);
  assert.equal(after.popDisplay, 'block');
  assert.ok(after.popText.length > 0, 'the popover must never be empty once opened');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});
