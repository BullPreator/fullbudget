// FAZ 3.17 — FİNANS KOÇU UX + BEHAVIOR AUDIT regresyon testleri
// -----------------------------------------------------------------------
// Denetim bulgusu: Finans Koçu'nun context/precomputed/system-prompt mimarisi (P0-1/P0-3/P1-1)
// bu fazdan ÖNCE de "AI kendi başına hesap YAPMAZ, uydurmaz" ilkesini uyguluyordu —
// buildAICoachContext() yalnızca canonical motorlardan (computeCashFlowSummary/totalAssets/
// computeNetWorth/computeGoalInfo/getAffordCapacityInfo) okur, buildAICoachPrecomputed()
// affordability/decision sonuçlarını GERÇEK motordan (computeAffordability/runDecisionEngine)
// alır, ve AI_COACH_SYSTEM_PROMPT_HINT modelin uydurma yapmasını açıkça yasaklar. Bu faz SALT
// iki gerçek boşluğu kapatır: (1) üstteki tanıtım metni "sunar/karşılaştırma" değil ürün
// ilkesindeki "açıklar" diliyle güncellendi, (2) gerçek AI'ın (backend) serbest metin cevabı
// ekranda artık İSTEMCİ TARAFINDA (backend'in sistem promptuna uyup uymamasından bağımsız)
// "Yapay zekâ açıklaması — kesin tavsiye değildir" etiketiyle şablon/deterministik
// cevaplardan görsel olarak ayrıştırılıyor (source:'ai' + renderAiChatLog). Ayrıca birkaç örnek
// soru zaten var olan motorlara (answerTopSpendingCategory/answerOverallStatus/
// answerEmergencyFund) yönlendirilerek eklendi — YENİ bir hesaplama/motor İCAT EDİLMEDİ. Hiçbir
// finansal motor, Ana Sayfa, Ayarlar, Yatırım veya Sesle Ekle bu fazda değiştirilmedi.
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
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
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
      persistent.goals = s.goals || [];
      setTab(s.tab || 'coach');
      render();
    }, setup);
  }
  return { page, pageErrors };
}

const SCENARIO = { income: 120000, expenses: 40000, expenseRows: [{ id: 'e1', category: 'Kira', amount: 40000, fixed: true }], assets: 200000, debts: [{ id: 'd1', category: 'ihtiyac', note: 'İhtiyaç Kredisi', balance: 60000, rate: 3.5, minPayment: 5000, extraPayment: 0, currency: 'TRY' }] };

test('FAZ3.17-1: the coach receives the current financial context (buildAICoachContext reflects live state)', async () => {
  const { page, pageErrors } = await newSession({ ...SCENARIO, tab: 'coach' });
  const ctx = await page.evaluate(() => buildAICoachContext());
  await page.close();
  assert.equal(ctx.financialSnapshot.monthlyIncome, 120000, 'context must reflect the actual current income');
  assert.equal(ctx.financialSnapshot.monthlyExpenses, 40000, 'context must reflect the actual current expenses');
  assert.equal(ctx.financialSnapshot.liquidAssets, 200000, 'context must reflect the actual current liquid assets');
  assert.ok(ctx.debts.length >= 1, 'context must include the existing debt');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.17-2: deterministic financial values in the context match the canonical engines (no parallel/duplicate formula)', async () => {
  const { page, pageErrors } = await newSession({ ...SCENARIO, tab: 'coach' });
  const check = await page.evaluate(() => {
    const ctx = buildAICoachContext();
    const canonicalCashFlow = computeCashFlowSummary({
      income: totalIncome(), expenses: cashOutSpent(), debtPayments: monthlyDebtPayments(), remainingDays: daysLeft,
    }).remaining;
    const canonicalNetWorth = computeNetWorth({ assets: totalAssets(), totalDebt: totalDebtTL() });
    const cap = getAffordCapacityInfo();
    return {
      ctxCashFlow: ctx.financialSnapshot.monthlyCashFlow,
      canonicalCashFlow: Math.round(canonicalCashFlow),
      ctxNetWorth: ctx.financialSnapshot.netWorth,
      canonicalNetWorth: Math.round(canonicalNetWorth),
      ctxCapacity: ctx.affordability.availableMonthlyCapacity,
      canonicalCapacity: Math.round(cap.safeMonthlyCapacity),
      ctxBalance: ctx.currentMonth.balance,
    };
  });
  await page.close();
  assert.equal(check.ctxCashFlow, check.canonicalCashFlow, 'context cash flow must equal the canonical computeCashFlowSummary() result, not a re-derived copy');
  assert.equal(check.ctxNetWorth, check.canonicalNetWorth, 'context net worth must equal the canonical computeNetWorth() result');
  assert.equal(check.ctxCapacity, check.canonicalCapacity, 'context affordability capacity must equal the canonical getAffordCapacityInfo() result');
  assert.equal(check.ctxBalance, check.ctxCashFlow, 'currentMonth.balance must match financialSnapshot.monthlyCashFlow (no second, contradicting formula)');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.17-3: the coach does not fabricate missing financial values (empty state stays null/zero, never guessed)', async () => {
  const { page, pageErrors } = await newSession({ income: 0, expenses: 0, assets: 0, debts: [], tab: 'coach', goals: [{ id: 'g1', typeKey: 'diger', customName: 'Test', targetAmount: 100000 }] });
  const check = await page.evaluate(() => {
    const ctx = buildAICoachContext();
    // Hiçbir tutar (Alabilir miyim? niyeti) algılanmayan bir soru için precomputed BOŞ kalmalı —
    // affordability/decision alanları UYDURULMAMALI.
    const precomputedNoAmount = buildAICoachPrecomputed('Param hakkında ne düşünüyorsun?');
    return {
      monthlyIncome: ctx.financialSnapshot.monthlyIncome,
      goalMonthsLeft: ctx.goals[0] ? ctx.goals[0].monthsLeft : undefined,
      hasAffordability: Object.prototype.hasOwnProperty.call(precomputedNoAmount, 'affordability'),
      hasDecision: Object.prototype.hasOwnProperty.call(precomputedNoAmount, 'decision'),
    };
  });
  await page.close();
  assert.equal(check.monthlyIncome, 0, 'with no income entered, the context must report 0, never an invented/guessed figure');
  assert.equal(check.goalMonthsLeft, null, 'a goal with no target date must report monthsLeft as null, never a fabricated number');
  assert.equal(check.hasAffordability, false, 'without a detected amount, precomputed.affordability must not be fabricated/present');
  assert.equal(check.hasDecision, false, 'without a detected amount, precomputed.decision must not be fabricated/present');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.17-4: coach copy does not imply investment advice or an authoritative advisor persona', async () => {
  assert.ok(appHtmlSource.includes("'ai-koc-not': {tr:'Finans Koçuna sor. Gerçek verilerine bakarak sana senaryoları ve hesaplamaları açıklar — kararı sen verirsin."), 'the top-level coach message must use the "explains scenarios/calculations, you decide" framing');
  assert.ok(!/Finans Koçuna sor\. Gerçek verilerine bakarak sana senaryolar ve kar[şs]ıla[şs]tırmalar sunar/.test(appHtmlSource), 'the older, less precise "offers scenarios/comparisons" framing must no longer be present');
  // Sistem promptu (backend'e giden ipucu) yatırım tavsiyesi vermeyi, hesap uydurmayı ve
  // motorla çelişmeyi açıkça yasaklamalı.
  assert.ok(appHtmlSource.includes('Verilmeyen hiçbir finansal bilgiyi uydurma'), 'the system prompt hint must forbid fabricating financial data');
  assert.ok(appHtmlSource.includes('ASLA üretme'), 'the system prompt hint must forbid producing a contradicting number/result');
  // İstemci tarafı ayrım etiketi: gerçek AI'ın serbest cevabı "tavsiye değildir" diye işaretlenmeli.
  assert.ok(appHtmlSource.includes('Yapay zekâ açıklaması — kesin tavsiye değildir'), 'real AI-path answers must carry a client-rendered "not financial advice" tag, independent of backend compliance');
  assert.ok(appHtmlSource.includes("source:'ai'"), 'the real AI-path answer must be tagged so the UI can distinguish it from the deterministic/template answer');
});

test('FAZ3.17-5: Home remains unchanged (still the frozen 6-section structure, in order)', async () => {
  const { page, pageErrors } = await newSession({ ...SCENARIO, tab: 'home' });
  const order = await page.evaluate(() => Array.from(
    document.querySelectorAll('.tab-panel[data-tab="home"] [data-section]')
  ).map(el => el.dataset.section));
  await page.close();
  const kept = ['finansal-durum', 'bugunun-gorevi', 'ring', 'bu-ay-plan', 'bugun-bilmen-gerekenler', 'afford-teaser'];
  const indices = kept.map(sec => order.indexOf(sec));
  assert.ok(indices.every(i => i >= 0), `all 6 Home sections must still be present, got: ${JSON.stringify(order)}`);
  for (let i = 1; i < indices.length; i++) {
    assert.ok(indices[i - 1] < indices[i], 'Home section order must be unchanged');
  }
  assert.equal(order[indices[indices.length - 1]], 'afford-teaser', 'Home must still end at "afford-teaser" (Alabilir miyim?)');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.17-6: no protected financial engine/constant was changed by this phase', async () => {
  const protectedNames = [
    'function runDecisionEngineV2(', 'function runGoalCashAllocationEngine(',
    'function runMonthlyGoalCashAllocationLive(', 'function computeGoalInfo(',
    'function buildMonthlySnapshot(', 'function computeCashFlowSummary(',
    'function getAffordCapacityInfo(', 'function assessCardAffordability(',
    'function getFinancialAlerts(', 'function computePriorityPlan(',
    'function _planKur(', 'function ensureTodaysMoneyTask(', 'function upgradeStalePersistedMoneyTask(',
  ];
  for (const sig of protectedNames) {
    assert.ok(appHtmlSource.includes(sig), `protected function signature must still be present verbatim: ${sig}`);
  }
  assert.ok(appHtmlSource.includes('const RISK_PROFILES'), 'RISK_PROFILES constant must still be present');

  const { page, pageErrors } = await newSession({ ...SCENARIO, tab: 'coach' });
  const check = await page.evaluate(() => {
    const canonical = runMonthlyGoalCashAllocationLive();
    return { distributableCash: canonical.distributableCash };
  });
  await page.close();
  assert.equal(check.distributableCash, 75000, 'protected engine output for this scenario must be unchanged by a copy/UX-only fix');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});
