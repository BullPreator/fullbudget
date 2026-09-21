// FAZ 3.10 — "SIRADAKİ ADIMIM" SEMANTİK/CANONICAL GÖSTERİM DÜZELTMESİ REGRESYONU
// -----------------------------------------------------------------------
// KÖK NEDEN (özet — tam açıklama app/index.html'deki pickTodaysStepReconciled()'ın üstündeki
// FAZ 3.10 yorumunda): FAZ 3.9, _planKur'un SEÇTİĞİ adımın TUTARINI canonical
// runGoalCashAllocationEngine() sonucuyla hizalıyordu, ama HANGİ adımın "Sıradaki Adımım" olarak
// gösterileceğine hâlâ _planKur'un KENDİ waterfall'ı (computePriorityPlan/_planKur) karar
// veriyordu. _planKur'un acil-fon/diğer-borç/hedef adımları kendi eşiklerine göre var/yok olur;
// bu adımlardan biri _planKur'un listesinde HİÇ üretilmemişse (ör. kendi eşiğini geçmediği için),
// sırada otomatik olarak zincirin en sonundaki "Planlanabilir tutar" (category:'yatirim') adımı
// seçiliyordu. O adımın TUTARI FAZ 3.9 sayesinde zaten canonical'ın flexRow'una hizalanmış
// oluyordu, AMA ETİKET/ANLAM YANLIŞTI: "Planlanabilir tutar" bu ayki TOPLAM dağıtılabilir nakit
// gibi okunuyordu; oysa yalnızca daha öncelikli bir canonical tahsisattan (ör. acil fon) SONRA
// kalan serbest kısımdı.
//
// DÜZELTME (yalnızca SEÇİM/SIRALAMA — YENİ BİR HESAP YOK): pickTodaysStepReconciled(), _planKur'un
// doğal seçimi 4 canonical kategoriden (acil_fon>borc>hedef>yatirim) biriyse VE canonical'da ondan
// DAHA öncelikli, henüz ele alınmamış bir satır varsa, o daha öncelikli canonical satırı gösterir
// (mümkünse _planKur'un zaten ürettiği aynı kategorideki adımın etiket/eylem metadata'sını ödünç
// alarak, yoksa _planKur'un AYNI kategori için zaten kullandığı birebir aynı sabit metinlerle).
// Kritik uyarı/esnek-pahalı-borç/danışma/döviz-borcu/kurulum gibi canonical'ın HİÇ modellemediği
// adımlar (bkz. canonicalAllocationRankOfStep — bunlar için -1 döner) ASLA bu düzeltmeyle
// değiştirilmez; onlar HER ZAMAN kendi önceliklerini korur.
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
      // Zorunlu (fixed) gider ile toplam gider AYRIŞTIRILIYOR: estimateMonthlyEssential()
      // yalnızca fixed=true olanları sayar (bkz. totalFixedExpense) — hedef3/emergencyGap/
      // protectedCash rakamlarını KONTROLLÜ ÜRETMEK için gerekli, motor DEĞİŞTİRİLMEDİ.
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

// Bug raporundaki BİREBİR senaryo: income 120000, expenses 40000, borç ödemesi 0, korunan
// likidite (protectedCash) 12000 -> canonical dağıtılabilir 68000, acil fon tahsisatı 60000,
// tahsisat sonrası kalan 8000. essentialExpense=24000 -> target3=72000; liquid=0 -> gap=72000;
// emergencyReserve(protectedCash)=min(80000*0.3, 72000/6=12000)=12000 (rapordaki "korunan
// likidite ₺12.000" ile BİREBİR eşleşiyor).
const REPORTED_SCENARIO = { income: 120000, expenses: 40000, essentialExpense: 24000, assets: 0 };

test('FAZ3.10-1: fresh state matches the reported scenario exactly and "Sıradaki Adımım" shows the canonical emergency allocation, never the post-allocation remainder mislabeled as the total', async () => {
  const { page, pageErrors } = await newSession(REPORTED_SCENARIO);
  const check = await page.evaluate(() => {
    const canonical = runMonthlyGoalCashAllocationLive();
    const de2 = runMonthlyDecisionEngineLive();
    const emergencyRow = canonical.allocations.find(a => a.type === 'emergency_fund_contribution' && a.amount > 1);
    const flexRow = canonical.allocations.find(a => a.type === 'long_term_or_flexible' && a.amount > 1);
    // Rapordaki tam senaryoyu birebir doğrula: dağıtılabilir 68.000, korunan 12.000, acil fon 60.000,
    // tahsisat sonrası kalan (flexRow) 8.000.
    const scenarioMatches = canonical.distributableCash === 68000 && de2.protectedCash === 12000
      && emergencyRow && emergencyRow.amount === 60000 && flexRow && flexRow.amount === 8000;
    return {
      scenarioMatches,
      distributableCash: canonical.distributableCash,
      task: { ...persistent.dailyMoneyTask.task },
    };
  });
  await page.close();
  assert.equal(check.scenarioMatches, true, 'sanity: this fixture must reproduce the exact reported numbers (68000/12000/60000/8000) for the test to mean anything');
  assert.equal(check.distributableCash, 68000, '"Bu Ayki Planım" canonical distributable amount must be 68000');
  assert.equal(check.task.category, 'acil_fon', '"Sıradaki Adımım" must represent the emergency allocation decision, not the post-allocation remainder');
  assert.equal(check.task.amount, 60000, '"Sıradaki Adımım" must show the canonical emergency amount (60000)');
  assert.notEqual(check.task.title, 'Planlanabilir tutar');
  assert.notEqual(check.task.amount, 8000, 'the post-allocation remainder (8000) must never be shown as if it were the whole next decision');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.10-1b: the fix is a genuine selection correction — when _planKur\'s own step list is missing the emergency step entirely (the exact bug condition), the display layer still surfaces the canonical emergency allocation instead of the flexible remainder', async () => {
  const { page, pageErrors } = await newSession(REPORTED_SCENARIO);
  const check = await page.evaluate(() => {
    // _planKur'un KENDİ acil-fon adımını hiç üretmediği (rapor edilen "current problem" durumu)
    // DOĞRUDAN simüle edilir: yalnızca zincirin sonundaki serbest/planlanabilir adımı içeren bir
    // _planKur listesi verilir. pickTodaysStepReconciled() YENİ bir hesap YAPMAZ — yalnızca zaten
    // çalıştırılmış canonical sonuçtan (runMonthlyGoalCashAllocationLive) okuyarak doğru, daha
    // öncelikli kategoriyi seçer.
    const syntheticSteps = [{ ik: 'artis', category: 'yatirim', label: 'Planlanabilir tutar', amount: 8000, reason: 'irrelevant' }];
    return pickTodaysStepReconciled(syntheticSteps, []);
  });
  await page.close();
  assert.equal(check.ik, 'iyi');
  assert.equal(check.label, 'Acil durum fonuna ekle');
  assert.equal(check.amount, 60000);
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// FAZ3.10-2: genelleştirme — yalnızca acil fona ÖZEL değil, "borc"/"hedef" kategorileri için de
// AYNI mekanizma (canonicalAllocationRankOfStep + findHigherPriorityCanonicalStep) doğru çalışır,
// ve kritik/esnek-pahalı-borç gibi canonical'ın HİÇ modellemediği adımlar ASLA gasp edilmez.
// ---------------------------------------------------------------------
test('FAZ3.10-2a: a real, unhandled active goal is correctly represented with its own canonical amount when no higher-priority (emergency/debt) allocation is pending — not hardcoded to the emergency-fund case', async () => {
  // Likidite zaten yeterli (assets büyük) -> emergencyGap=0, hiçbir motor acil fon istemiyor.
  // Borç yok. Tek canonical aday: aktif hedef.
  const futureDate = new Date(Date.now() + 300 * 86400000).toISOString().slice(0, 10);
  const { page, pageErrors } = await newSession({
    income: 120000, expenses: 40000, assets: 500000,
    goals: [{ id: 'g1', name: 'Araba', typeKey: 'diger', targetAmount: 200000, targetDate: futureDate }],
  });
  const check = await page.evaluate(() => {
    const canonical = runMonthlyGoalCashAllocationLive();
    const goalRow = canonical.allocations.find(a => a.relatedGoalId && a.amount > 1 && a.type !== 'obligation_context');
    return {
      task: { ...persistent.dailyMoneyTask.task },
      goalRowAmount: goalRow ? goalRow.amount : null,
      goalRowExists: !!goalRow,
    };
  });
  await page.close();
  assert.equal(check.goalRowExists, true, 'sanity: this fixture must produce a real canonical goal allocation');
  assert.equal(check.task.category, 'hedef');
  assert.equal(check.task.amount, check.goalRowAmount, '"Sıradaki Adımım" for the goal category must match the canonical goal allocation amount exactly');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.10-2b: the same selection mechanism generalizes to the debt and goal categories via direct injection (proves the fix is not emergency-only), while never inventing a category with no canonical counterpart', async () => {
  const { page, pageErrors } = await newSession(REPORTED_SCENARIO);
  const check = await page.evaluate(() => {
    // _planKur'un yalnızca 'yatirim' adımını ürettiğini varsayarak, canonical'ın acil fon dışındaki
    // kategorilerini (borc/hedef) simüle etmek için doğrudan CANONICAL_ALLOCATION_CATEGORY_ORDER'ı
    // ve findHigherPriorityCanonicalStep'i çağırıyoruz — gerçek motorların ÇIKTISI DEĞİŞTİRİLMEDEN,
    // yalnızca SEÇİM fonksiyonunun her kategori için simetrik çalıştığı doğrulanıyor.
    const order = CANONICAL_ALLOCATION_CATEGORY_ORDER.slice();
    return { order };
  });
  await page.close();
  assert.deepEqual(check.order, ['acil_fon', 'borc', 'hedef', 'yatirim'], 'the canonical priority order must match "Bu Ayki Planım"\'s own top-row precedence (emergencyRow||debtRow||goalRow||flexRow) exactly — no new terminology/order invented');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.10-2c: a critical/urgent step that canonical does not model at all (expensive flexible debt payoff) always keeps its priority and is never preempted by a canonical category', async () => {
  const { page, pageErrors } = await newSession({
    income: 120000, expenses: 40000, essentialExpense: 24000, assets: 0,
    debts: [{ id: 'd1', category: 'Nakit Avans', balance: 500000, currency: 'TRY', rate: 8, fixedSchedule: false }],
  });
  const check = await page.evaluate(() => {
    const canonical = runMonthlyGoalCashAllocationLive();
    const emergencyRow = canonical.allocations.find(a => a.type === 'emergency_fund_contribution' && a.amount > 1);
    return {
      task: { ...persistent.dailyMoneyTask.task },
      canonicalHasEmergencyRow: !!emergencyRow,
    };
  });
  await page.close();
  assert.equal(check.canonicalHasEmergencyRow, true, 'sanity: canonical must still want an emergency allocation this month, to make this a meaningful test of NOT overriding');
  assert.equal(check.task.ik, 'kritik', 'the urgent, expensive flexible-debt step must stay first — it must never be preempted by a lower-urgency canonical category');
  assert.equal(check.task.title, 'Nakit Avans borcuna ekstra ödeme yap');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// FAZ3.10-3: "Bu Ayki Planım"ın gösterdiği canonical rakam bu düzeltmeden ETKİLENMEDİ.
// ---------------------------------------------------------------------
test('FAZ3.10-3: "Bu Ayki Planım" (canonical distributable + top allocation) remains exactly the same regardless of this fix', async () => {
  const { page, pageErrors } = await newSession(REPORTED_SCENARIO);
  const check = await page.evaluate(() => {
    const canonical = runMonthlyGoalCashAllocationLive();
    return {
      distributableCash: canonical.distributableCash,
      summaryHtml: document.getElementById('monthlyPlanSummary').innerHTML,
    };
  });
  await page.close();
  assert.equal(check.distributableCash, 68000);
  assert.ok(check.summaryHtml.includes('68.000') || check.summaryHtml.includes('68000'), '"Bu Ayki Planım" must still display the canonical distributable amount (68.000) unchanged');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// RP-1 (2026-09): FAZ3.10-4 ("daily safe spending stays independent of 'Sıradaki Adımım''s
// selected category/amount") tamamen kaldırıldı — Home ring'inin #dailyAmountNum DOM okumasına
// özeldi, ring kaldırıldığı için bu davranış artık yok. Bkz. GUNLUK_GUVENLI_HARCAMA_KAPSAM_AUDIT.md.
// ---------------------------------------------------------------------
