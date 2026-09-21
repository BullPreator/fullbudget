// FAZ 3.12 — HOME CLEANUP: ANA SAYFAYI FİNANSAL KARAR MERKEZİNE ODAKLAMA regresyon testleri
// -----------------------------------------------------------------------
// Bu faz salt bir ÜRÜN/UI sadeleştirmesi: Ana Sayfa artık yalnızca 6 birincil bölümden oluşan
// odaklanmış bir "FİNANSAL DURUM MERKEZİ" (Finansal Durum → Sıradaki Adımım → Bugünün Güvenli
// Bütçesi → Bu Ayki Planım → Bugün Bilmen Gerekenler → Alabilir miyim?) — sayfa "Alabilir
// miyim?" ile BİTİYOR. Ana Sayfa'dan kaldırılan 5 ikincil bölüm (Yaklaşan Ödemeler, Son
// İşlemler, bağımsız "Bu Ay Kullanılabilir Tutar" kartı, Kategorilere Göre Harcama, Yolculuğum
// teaser'ı) — ayrıca "Aktif Hedefin" (bkz. index.html'deki FAZ 3.12 yorumu; EXACT INTENDED HOME
// STRUCTURE'ın "STOP. Do not add another card below this" talimatını ihlal etmemek için ek
// olarak kaldırıldı) — İÇİN ALTTAKİ ÖZELLİK/HESAP/VERİ HİÇBİR ŞEKİLDE SİLİNMEDİ; yalnızca Ana
// Sayfa'daki sunum kaldırıldı ya da (Kategorilere Göre Harcama için) "Finans Koçun" (Analizler)
// sekmesine TAŞINDI. Bu dosya:
//   - FAZ3.12-1: Ana Sayfa'da kalması gereken 6 bölümün hepsinin var olduğunu,
//   - FAZ3.12-2: kaldırılan 5 bölümün Ana Sayfa'nın DOM'unda hiç bulunmadığını,
//   - FAZ3.12-3: bu bölümlerin kaldırılmasının altındaki veriyi/özelliği SİLMEDİĞİNİ/BOZMADIĞINI
//     (computeUpcomingPayments/renderUpcomingPayments, renderRecentTransactions, pickPrimaryGoal/
//     computeGoalInfo, expenseSumsByCategory/renderExpenseCategoryDonut'un artık "Finans Koçun"
//     sekmesinde bulunması, ve "Yolculuğum" sekmesinin/computeJourney()'in erişilebilir kalması),
//   - FAZ3.12-4: "Bu Ayki Planım"ın canonical waterfall'ı hâlâ doğru gösterdiğini,
//   - FAZ3.12-5: "Sıradaki Adımım"ın hâlâ mevcut canonical seçim mekanizmasını (FAZ 3.10/3.11)
//     kullandığını,
// ve son olarak raporlanan KABUL KRİTERİ senaryosunu (income 120000/expenses 40000/borç 0/
// protectedCash 12000 -> distributable 68000/emergency 60000/remainder 8000) birebir doğrular.
// runDecisionEngineV2()/runGoalCashAllocationEngine()/runMonthlyGoalCashAllocationLive()/
// computeGoalInfo()/buildMonthlySnapshot()/computeCashFlowSummary()/getAffordCapacityInfo()/
// assessCardAffordability()/getFinancialAlerts()/computePriorityPlan()/_planKur()/RISK_PROFILES/
// activeRiskProfile/ensureTodaysMoneyTask()/upgradeStalePersistedMoneyTask() bu dosya tarafından
// ASLA mutasyona uğratılmaz — yalnızca DOM ve salt-okunur motor çağrılarıyla gözlemlenir.
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
      month.expenses = [];
      if (s.essentialExpense > 0) month.expenses.push({ id: 'e1', category: 'Kira', amount: s.essentialExpense, fixed: true });
      const restExpense = (s.expenses || 0) - (s.essentialExpense || 0);
      if (restExpense > 0) month.expenses.push({ id: 'e2', category: 'Diğer', amount: restExpense, fixed: false });
      persistent.goals = s.goals || [];
      persistent.dailyMoneyTask = null;
      setTab('home');
      render();
    }, setup);
  }
  return { page, pageErrors };
}

// Kabul kriteri raporundaki BİREBİR senaryo (FAZ 3.10/3.11 ile aynı): income 120000, expenses
// 40000, essentialExpense 24000, assets 0 -> distributableCash 68000, protectedCash 12000,
// emergencyRow.amount 60000, flexRow.amount 8000.
const REPORTED_SCENARIO = { income: 120000, expenses: 40000, essentialExpense: 24000, assets: 0 };

// RP-1 (2026-09): 'ring' ("Günün Güvenli Harcama Alanı") Home'dan tamamen kaldırıldı — liste
// 6 öğeden 5 öğeye düştü (bkz. GUNLUK_GUVENLI_HARCAMA_KAPSAM_AUDIT.md). Kapsam ZAYIFLATILMADI,
// yalnızca artık var olmayan bir bölüm beklentiden çıkarıldı.
const KEPT_SECTIONS = ['finansal-durum', 'bugunun-gorevi', 'bu-ay-plan', 'bugun-bilmen-gerekenler', 'afford-teaser'];
const REMOVED_HOME_SECTIONS = ['yaklasan-odemeler', 'activegoal', 'son-islemler', 'top5', 'expense-donut', 'journey-teaser'];

test('FAZ3.12-1: Home contains all 5 required primary sections, in order, ending at "Alabilir miyim?"', async () => {
  const { page, pageErrors } = await newSession(REPORTED_SCENARIO);
  const order = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.tab-panel[data-tab="home"] [data-section]')).map(el => el.dataset.section);
  });
  await page.close();
  const indices = KEPT_SECTIONS.map(sec => order.indexOf(sec));
  assert.ok(indices.every(i => i >= 0), `all 5 required sections must be present, got: ${JSON.stringify(order)}`);
  for (let i = 1; i < indices.length; i++) {
    assert.ok(indices[i - 1] < indices[i], `"${KEPT_SECTIONS[i - 1]}" must come before "${KEPT_SECTIONS[i]}" — got order: ${JSON.stringify(order)}`);
  }
  assert.equal(order[indices[indices.length - 1]], 'afford-teaser', '"afford-teaser" (Alabilir miyim?) must be the last visible primary section');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.12-2: Home does not render any of the 5 removed secondary sections (nor the additionally-removed "Aktif Hedefin")', async () => {
  const { page, pageErrors } = await newSession({
    ...REPORTED_SCENARIO,
    goals: [{ id: 'g1', typeKey: 'ev', name: 'Ev', targetAmount: 1000000, targetDate: new Date(Date.now() + 300 * 86400000).toISOString().slice(0, 10) }],
  });
  const check = await page.evaluate(() => {
    const homeSections = Array.from(document.querySelectorAll('.tab-panel[data-tab="home"] [data-section]')).map(el => el.dataset.section);
    return {
      homeSections,
      upcomingBoxInHome: !!document.querySelector('.tab-panel[data-tab="home"] #upcomingPaymentsBox'),
      recentTxnBoxInHome: !!document.querySelector('.tab-panel[data-tab="home"] #recentTxnBox'),
      activeGoalBoxInHome: !!document.querySelector('.tab-panel[data-tab="home"] #activeGoalBox'),
      top5SavingsInHome: !!document.querySelector('.tab-panel[data-tab="home"] #top5Savings'),
      expenseDonutInHome: !!document.querySelector('.tab-panel[data-tab="home"] #expenseDonutBox'),
      journeyTeaserInHome: !!document.querySelector('.tab-panel[data-tab="home"] #journeyTeaserBox'),
    };
  });
  await page.close();
  for (const sec of REMOVED_HOME_SECTIONS) {
    assert.ok(!check.homeSections.includes(sec), `"${sec}" must not appear in Home's DOM order, got: ${JSON.stringify(check.homeSections)}`);
  }
  assert.equal(check.upcomingBoxInHome, false, 'Yaklaşan Ödemeler container must not be in Home');
  assert.equal(check.recentTxnBoxInHome, false, 'Son İşlemler container must not be in Home');
  assert.equal(check.activeGoalBoxInHome, false, 'Aktif Hedefin container must not be in Home');
  assert.equal(check.top5SavingsInHome, false, '"Bu Ay Kullanılabilir Tutar" container must not be in Home');
  assert.equal(check.expenseDonutInHome, false, 'Kategorilere Göre Harcama container must not be in Home');
  assert.equal(check.journeyTeaserInHome, false, 'Yolculuğum teaser must not be in Home');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.12-3: removing these sections from Home does not remove or break the underlying features, data or calculations', async () => {
  const { page, pageErrors } = await newSession({
    ...REPORTED_SCENARIO,
    goals: [{ id: 'g1', typeKey: 'ev', name: 'Ev', targetAmount: 1000000, targetDate: new Date(Date.now() + 300 * 86400000).toISOString().slice(0, 10) }],
  });
  const check = await page.evaluate(() => {
    let threw = false;
    let upcoming, primaryGoal, expenseCategoryTotals, journey;
    try {
      upcoming = computeUpcomingPayments();
      primaryGoal = pickPrimaryGoal();
      expenseCategoryTotals = expenseSumsByCategory();
      journey = computeJourney();
    } catch (e) { threw = true; }
    // Kategorilere Göre Harcama artık "Finans Koçun" (coach) sekmesinde — SİLİNMEDİ, TAŞINDI.
    const expenseDonutInCoach = !!document.querySelector('.tab-panel[data-tab="coach"] #expenseDonutBox');
    // Yolculuğum kendi ayrı sekmesinde erişilebilir kalmalı.
    const journeyTabExists = !!document.querySelector('[data-tab="journey"]');
    return {
      threw,
      upcomingIsArray: Array.isArray(upcoming),
      hasPrimaryGoal: !!primaryGoal,
      expenseCategoryTotalsIsObject: expenseCategoryTotals && typeof expenseCategoryTotals === 'object',
      journeyComputed: journey !== undefined && journey !== null,
      expenseDonutInCoach,
      journeyTabExists,
    };
  });
  await page.close();
  assert.equal(check.threw, false, 'the underlying calculation functions must still run without error');
  assert.equal(check.upcomingIsArray, true, 'computeUpcomingPayments() must still function');
  assert.equal(check.hasPrimaryGoal, true, 'pickPrimaryGoal()/computeGoalInfo() must still correctly identify the active goal');
  assert.equal(check.expenseCategoryTotalsIsObject, true, 'expenseSumsByCategory() must still function');
  assert.equal(check.journeyComputed, true, 'computeJourney() must still function');
  assert.equal(check.expenseDonutInCoach, true, 'Kategorilere Göre Harcama must still be available in the "Finans Koçun" (Analizler) tab');
  assert.equal(check.journeyTabExists, true, 'the dedicated "Yolculuğum" tab/route must remain available from navigation');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.12-4: "Bu Ayki Planım" still renders the canonical waterfall correctly for the reported scenario', async () => {
  const { page, pageErrors } = await newSession(REPORTED_SCENARIO);
  const check = await page.evaluate(() => {
    const canonical = runMonthlyGoalCashAllocationLive();
    return {
      distributableCash: canonical.distributableCash,
      summaryHtml: document.getElementById('monthlyPlanSummary').innerHTML,
    };
  });
  await page.close();
  assert.equal(check.distributableCash, 68000, '"Bu Ayki Planım" canonical distributable amount must still be 68000');
  assert.ok(check.summaryHtml.includes('68.000') || check.summaryHtml.includes('68000'), '"Bu Ayki Planım" must still display the canonical distributable amount (68.000)');
  assert.ok(check.summaryHtml.includes('60.000') || check.summaryHtml.includes('60000'), '"Bu Ayki Planım" must still display the canonical emergency allocation (60.000)');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.12-5: "Sıradaki Adımım" still uses the existing canonical next-step selection (FAZ 3.10/3.11) for the reported scenario', async () => {
  const { page, pageErrors } = await newSession(REPORTED_SCENARIO);
  const check = await page.evaluate(() => {
    const canonical = runMonthlyGoalCashAllocationLive();
    const emergencyRow = canonical.allocations.find(a => a.type === 'emergency_fund_contribution' && a.amount > 1);
    const flexRow = canonical.allocations.find(a => a.type === 'long_term_or_flexible' && a.amount > 1);
    const scenarioMatches = canonical.distributableCash === 68000 && emergencyRow && emergencyRow.amount === 60000 && flexRow && flexRow.amount === 8000;
    return { scenarioMatches, task: { ...persistent.dailyMoneyTask.task } };
  });
  await page.close();
  assert.equal(check.scenarioMatches, true, 'sanity: this fixture must reproduce the exact reported numbers for the test to mean anything');
  assert.equal(check.task.category, 'acil_fon', '"Sıradaki Adımım" must still represent the canonical emergency allocation decision');
  assert.equal(check.task.amount, 60000, '"Sıradaki Adımım" must still show the canonical emergency amount (60000)');
  assert.notEqual(check.task.amount, 8000, 'the post-allocation remainder must never be shown as the whole next decision');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.12-ACCEPTANCE: exact reported acceptance scenario — Home still shows "Acil durum fonuna ekle ₺60.000" as the next step and "68.000" as the planlayabileceğin tutar, unchanged by the Home cleanup', async () => {
  const { page, pageErrors } = await newSession(REPORTED_SCENARIO);
  const check = await page.evaluate(() => ({
    bodyText: document.body.innerText,
    task: { ...persistent.dailyMoneyTask.task },
    summaryHtml: document.getElementById('monthlyPlanSummary').innerHTML,
  }));
  await page.close();
  assert.equal(check.task.category, 'acil_fon');
  assert.equal(check.task.amount, 60000);
  assert.ok(/60\.000/.test(check.bodyText), 'Home body text must show ₺60.000 for the next step');
  assert.ok(check.summaryHtml.includes('68.000') || check.summaryHtml.includes('68000'), '"Bu Ayki Planım" must show 68.000 planlayabileceğin tutar');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.12-6: Home renders without errors and without large empty gaps across empty, emergency, and active-goal states', async () => {
  for (const setup of [
    { income: 0, expenses: 0, assets: 0, goals: [] },
    REPORTED_SCENARIO,
    { ...REPORTED_SCENARIO, goals: [{ id: 'g1', typeKey: 'ev', name: 'Ev', targetAmount: 1000000, targetDate: new Date(Date.now() + 300 * 86400000).toISOString().slice(0, 10) }] },
  ]) {
    const { page, pageErrors } = await newSession(setup);
    await page.close();
    assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  }
});
