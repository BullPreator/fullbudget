// FİNANSAL GERÇEKLİK (A→Z denetimi) — INVARIANT TABANLI regresyon testleri
// -----------------------------------------------------------------------
// Bu dosya örnek-çıktı testi DEĞİL, INVARIANT testidir: aynı finansal gerçeğin uygulamanın
// HER katmanında (Finance Core, UI/DOM, Decision Engine, satın alma senaryoları, AI Coach
// context'i, skor) AYNI değeri üretmesini doğrular. Amaç, gelecekte bir ekranın kendi başına
// yeniden hesap yapıp diğerinden farklı bir sayı göstermesini ERKENDEN yakalamak.
//
// Denetimde bulunan ve burada kilitlenen KÖK NEDEN (P0): kartla finanse edilen harcama nakit
// akışından düşülüyor ve nakit karşılığının monthlyDebtPayments() içinde sayıldığı varsayılıyordu.
// `cardId` gerçekte var olmayan bir karta işaret ettiğinde (kart silinmiş, veri içe aktarılmış
// ya da kart hiç eklenmemiş) tutar HİÇBİR YERDE sayılmıyordu; para finansal gerçeklikten yok
// oluyor ve tek bir sayıdan beslenen TÜM ekranlar (kalan, tasarruf oranı, güvenli günlük harcama,
// güvenli kapasite, Money Task, satın alma senaryosu, skor, AI context) birlikte şişiyordu.
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
    } catch (e) { res.writeHead(404); res.end('not found'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}/app/index.html`;
  browser = await chromium.launch({ args: ['--no-sandbox'] });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise((r) => server.close(r));
});

// scenario: {income, expenses, expensesOnCard, cardExists, debtPayments, debtBalance, assets, goals, usdDebt, usdRate}
async function session(scenario) {
  const page = await browser.newPage({ viewport: { width: 430, height: 1600 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  for (const [ov, btn] of [['#onboardingOverlay', '#onboardSkipBtn'], ['#authOverlay', '#authGuestBtn']]) {
    const dl = Date.now() + 8000;
    while (Date.now() < dl) {
      const shown = await page.evaluate((s) => {
        const e = document.querySelector(s); return !!(e && e.classList.contains('show'));
      }, ov).catch(() => false);
      if (shown) { const b = await page.$(btn); if (b) { await b.click({ force: true }).catch(() => {}); await page.waitForTimeout(300); break; } }
      await page.waitForTimeout(150);
    }
  }
  if (scenario) {
    await page.evaluate((s) => {
      persistent.accounts = s.assets > 0 ? [{ id: 'a1', name: 'Banka', type: 'Banka Hesabı', balance: s.assets, currency: 'TRY' }] : [];
      persistent.debts = [];
      if (s.debtBalance > 0) persistent.debts.push({ id: 'd1', category: 'Diğer', balance: s.debtBalance, minPayment: s.debtPayments || 0, rate: 0, currency: 'TRY' });
      if (s.usdDebt > 0) persistent.debts.push({ id: 'd2', category: 'Diğer', balance: s.usdDebt, minPayment: 0, rate: 0, currency: 'USD' });
      persistent.creditCards = s.cardExists
        ? [{ id: 'c1', name: 'Kart', currentBalance: s.expensesOnCard || 0, currency: 'TRY', minPaymentPct: 20, statementDay: 1, dueDay: 10 }]
        : [];
      persistent.goals = s.goals || [];
      persistent.dailyMoneyTask = null;
      month.incomes = s.income > 0 ? [{ id: 'i1', category: 'Maaş', amount: s.income }] : [];
      month.expenses = [];
      if (s.expenses > 0) month.expenses.push({ id: 'e1', category: 'Diğer', amount: s.expenses, fixed: false });
      if (s.expensesOnCard > 0) month.expenses.push({ id: 'e2', category: 'Diğer', amount: s.expensesOnCard, fixed: false, cardId: s.cardExists ? 'c1' : 'GHOST_CARD' });
      render();
    }, scenario);
  }
  return { page, pageErrors };
}

const SCEN_A = { income: 110000, expenses: 44067, expensesOnCard: 0, debtPayments: 0, debtBalance: 243657, assets: 500000 };

// ---------------------------------------------------------------------
// INVARIANT 1 — netWorth === assets − debt, HER katmanda aynı
// ---------------------------------------------------------------------
test('INV1: netWorth = assets - debt ve tüm katmanlar (Finance Core / DOM / AI context) aynı değeri verir', async () => {
  const { page, pageErrors } = await session(SCEN_A);
  await page.waitForTimeout(1200); // animateNumberTo tamamlansın
  const r = await page.evaluate(() => ({
    core: computeNetWorth({ assets: totalAssets(), totalDebt: totalDebtTL() }),
    assets: totalAssets(), debt: totalDebtTL(),
    dom: document.getElementById('netWorthValue').textContent.trim(),
    ai: buildAICoachContext().financialSnapshot.netWorth,
    aiAssets: buildAICoachContext().financialSnapshot.totalAssets,
    aiLiquid: buildAICoachContext().financialSnapshot.liquidAssets,
    aiDebt: buildAICoachContext().financialSnapshot.totalDebt,
  }));
  assert.equal(r.core, r.assets - r.debt, 'net varlık formülü bozulmuş');
  assert.equal(r.core, 256343);
  assert.ok(r.dom.includes('256.343'), `DOM net varlık farklı: ${r.dom}`);
  assert.equal(r.ai, 256343, 'AI context net varlığı Finance Core ile aynı olmalı');
  // AI'nin likit varlığı TOPLAM varlık sanıp yanlış bir net varlık türetmemesi için ikisi de verilir.
  assert.equal(r.aiAssets, 500000, 'AI context toplam varlığı kanonik değerle aynı olmalı');
  assert.equal(r.ai, r.aiAssets - r.aiDebt, 'AI context içindeki net varlık kendi alanlarıyla tutarlı olmalı');
  assert.equal(typeof r.aiLiquid, 'number');
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// INVARIANT 2/3 — SENARYO A: freeCashFlow ve savingsRate, tüm katmanlarda aynı
// ---------------------------------------------------------------------
test('INV2/INV3 (SENARYO A): freeCashFlow=65933 ve savingsRate≈59.94 — Finance Core, DOM, afford kapasitesi ve AI context aynı', async () => {
  const { page, pageErrors } = await session(SCEN_A);
  const r = await page.evaluate(() => {
    const cf = computeCashFlowSummary({ income: totalIncome(), expenses: cashOutSpent(), debtPayments: monthlyDebtPayments(), remainingDays: daysLeft });
    return {
      remaining: cf.remaining, savingsRate: cf.savingsRate, available: cf.savingsRateAvailable,
      domKalan: document.getElementById('sumRemain').textContent.trim(),
      domSavings: document.getElementById('savingsRateStat').textContent.trim(),
      cap: getAffordCapacityInfo().monthlyCashFlow,
      ai: buildAICoachContext().financialSnapshot.monthlyCashFlow,
      aiMonth: buildAICoachContext().currentMonth.balance,
      cacheFlow: _cashFlowCache,
    };
  });
  assert.equal(r.remaining, 65933);
  assert.ok(Math.abs(r.savingsRate - 59.94) < 0.01, `savingsRate: ${r.savingsRate}`);
  assert.equal(r.available, true);
  assert.ok(r.domKalan.includes('65.933'), `DOM Kalan: ${r.domKalan}`);
  assert.ok(r.domSavings.includes('59'), `DOM tasarruf oranı: ${r.domSavings}`);
  assert.equal(r.cap, 65933, 'afford kapasitesi aynı nakit akışını kullanmalı');
  assert.equal(r.ai, 65933, 'AI snapshot aynı nakit akışını kullanmalı');
  assert.equal(r.aiMonth, 65933, 'AI currentMonth.balance aynı olmalı');
  assert.equal(r.cacheFlow, 65933);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// P0 REGRESYON — sahipsiz (orphan) cardId parayı yok EDEMEZ
// ---------------------------------------------------------------------
test('P0: var olmayan bir karta bağlı harcama nakit akışından YOK OLAMAZ (kalan 110.000 değil 65.933 olmalı)', async () => {
  const { page, pageErrors } = await session({
    income: 110000, expenses: 0, expensesOnCard: 44067, cardExists: false,
    debtPayments: 0, debtBalance: 243657, assets: 500000,
  });
  const r = await page.evaluate(() => ({
    cashOut: cashOutSpent(), cardFunded: cardFundedSpent(), orphan: orphanCardSpent(),
    debtPay: monthlyDebtPayments(),
    domKalan: document.getElementById('sumRemain').textContent.trim(),
    domSavings: document.getElementById('savingsRateStat').textContent.trim(),
    domDaily: document.getElementById('dailyAmountNum').textContent.trim(),
    cap: getAffordCapacityInfo().monthlyCashFlow,
    safeCap: getAffordCapacityInfo().safeMonthlyCapacity,
    ai: buildAICoachContext().financialSnapshot.monthlyCashFlow,
    postPurchase: calculatePurchaseScenario({ price: 2000000, downPayment: 500000, months: 18, ratePct: 0 }).now.monthlyFreeCashAfter,
  }));
  assert.equal(r.cardFunded, 0, 'var olmayan kart "kartla finanse edilmiş" sayılmamalı');
  assert.equal(r.orphan, 44067, 'sahipsiz kart harcaması teşhis alanında görünmeli');
  assert.equal(r.cashOut, 44067, 'tutar nakit çıkışı olarak sayılmalı');
  assert.ok(r.domKalan.includes('65.933'), `Kalan yanlış: ${r.domKalan}`);
  assert.ok(!r.domSavings.includes('100'), `tasarruf oranı %100 gösterilemez: ${r.domSavings}`);
  assert.equal(r.cap, 65933);
  assert.equal(r.ai, 65933, 'AI context de şişmiş nakit akışını görmemeli');
  assert.ok(Math.abs(r.postPurchase - (-17400.33)) < 1, `satın alma sonrası nakit akışı: ${r.postPurchase}`);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// Çift sayım koruması KORUNUYOR + dört satır artık birbiriyle çelişmiyor
// ---------------------------------------------------------------------
test('GERÇEK kart: çift sayım koruması korunur VE "Ayın Defteri" satırları birbiriyle uyumlu hale gelir', async () => {
  const { page, pageErrors } = await session({
    income: 110000, expenses: 0, expensesOnCard: 44067, cardExists: true,
    debtPayments: 0, debtBalance: 0, assets: 500000,
  });
  const r = await page.evaluate(() => ({
    cashOut: cashOutSpent(), cardFunded: cardFundedSpent(), orphan: orphanCardSpent(),
    rowShown: document.getElementById('sumCardFundedRow').style.display !== 'none',
    rowValue: document.getElementById('sumCardFunded').textContent.trim(),
    gider: document.getElementById('sumExpense').textContent.trim(),
    kalan: document.getElementById('sumRemain').textContent.trim(),
  }));
  assert.equal(r.cashOut, 0, 'gerçek kartta çift sayım koruması bozulmamalı');
  assert.equal(r.cardFunded, 44067);
  assert.equal(r.orphan, 0);
  assert.equal(r.rowShown, true, 'kartla ödenen kısım AÇIKÇA gösterilmeli (yoksa satırlar çelişir)');
  assert.ok(r.rowValue.includes('44.067'), r.rowValue);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// SENARYO B / D — borç ödemesi ve negatif ay: tek değer, tüm katmanlar
// ---------------------------------------------------------------------
test('SENARYO B: borç ödemesi dahil freeCashFlow=-20000 ve tüm katmanlar aynı değeri gösterir', async () => {
  const { page, pageErrors } = await session({ income: 50000, expenses: 40000, expensesOnCard: 0, debtPayments: 30000, debtBalance: 300000, assets: 0 });
  const r = await page.evaluate(() => ({
    core: computeCashFlowSummary({ income: totalIncome(), expenses: cashOutSpent(), debtPayments: monthlyDebtPayments(), remainingDays: daysLeft }).remaining,
    dom: document.getElementById('sumRemain').textContent.trim(),
    cap: getAffordCapacityInfo().monthlyCashFlow,
    ai: buildAICoachContext().financialSnapshot.monthlyCashFlow,
    safeDaily: document.getElementById('dailyAmountNum').textContent.trim(),
  }));
  assert.equal(r.core, -20000);
  assert.ok(r.dom.includes('-') && r.dom.includes('20.000'), `DOM: ${r.dom}`);
  assert.equal(r.cap, -20000);
  assert.equal(r.ai, -20000);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('SENARYO D: negatif ay (-30000) hiçbir ekranda POZİTİF tasarruf olarak gösterilemez (INV15)', async () => {
  const { page, pageErrors } = await session({ income: 50000, expenses: 70000, expensesOnCard: 0, debtPayments: 10000, debtBalance: 100000, assets: 0 });
  const r = await page.evaluate(() => ({
    core: computeCashFlowSummary({ income: totalIncome(), expenses: cashOutSpent(), debtPayments: monthlyDebtPayments(), remainingDays: daysLeft }),
    dom: document.getElementById('sumRemain').textContent.trim(),
    domSavings: document.getElementById('savingsRateStat').textContent.trim(),
    safeDaily: document.getElementById('dailyAmountNum').textContent.trim(),
  }));
  assert.equal(r.core.remaining, -30000);
  assert.ok(r.core.savingsRate < 0, 'negatif ayda tasarruf oranı negatif olmalı');
  assert.ok(r.dom.startsWith('-'), `Kalan negatif gösterilmeli: ${r.dom}`);
  assert.ok(r.domSavings.includes('-'), `tasarruf oranı negatif gösterilmeli: ${r.domSavings}`);
  assert.equal(r.core.safeDailySpend, 0, 'açık varken güvenli günlük harcama 0 olmalı');
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// SENARYO C / INVARIANT 11 — "veri yok" ≠ "0"
// ---------------------------------------------------------------------
test('SENARYO C (gelir 0): tasarruf oranı UYDURMA %0 değil "veri yok" olmalı, açık ise dürüstçe gösterilmeli', async () => {
  const { page, pageErrors } = await session({ income: 0, expenses: 44067, expensesOnCard: 0, debtPayments: 0, debtBalance: 0, assets: 0 });
  const r = await page.evaluate(() => ({
    available: computeCashFlowSummary({ income: 0, expenses: 44067, debtPayments: 0, remainingDays: 13 }).savingsRateAvailable,
    rateValue: computeCashFlowSummary({ income: 0, expenses: 44067, debtPayments: 0, remainingDays: 13 }).savingsRate,
    domSavings: document.getElementById('savingsRateStat').textContent.trim(),
    domKalan: document.getElementById('sumRemain').textContent.trim(),
  }));
  assert.equal(r.available, false, 'gelir yokken tasarruf oranı ÖLÇÜLEMEZ olarak işaretlenmeli');
  assert.equal(r.rateValue, 0, 'geriye dönük sözleşme korunmalı (sayı hâlâ 0 döner)');
  assert.ok(/veri yok|no data/.test(r.domSavings), `UI "%0" göstermemeli: ${r.domSavings}`);
  assert.ok(r.domKalan.startsWith('-'), `açık dürüstçe gösterilmeli: ${r.domKalan}`);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('SENARYO H/I (INV11): ölçülemeyen skor boyutları "veri yok" der, 0/50 UYDURMAZ ve ağırlıklar normalize edilir', async () => {
  const { page, pageErrors } = await session(SCEN_A); // hedef yok, yatırım varlığı yok
  const r = await page.evaluate(() => ({
    text: document.getElementById('scoreBox').textContent.replace(/\s+/g, ' '),
  }));
  assert.ok(/Hedef ilerlemesi\s*veri yok/.test(r.text), `hedef yoksa UYDURMA 50 gösterilemez: ${r.text.slice(0, 300)}`);
  assert.ok(/normalize/.test(r.text), 'ağırlıkların normalize edildiği kullanıcıya açıkça söylenmeli');
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// INVARIANT 7 — borç ANAPARA ödemesi net varlığı ARTIRMAZ
// ---------------------------------------------------------------------
test('INV7: borç ödemesi bir bilanço transferidir — Money Task "net varlığını X güçlendirir" DİYEMEZ', async () => {
  const { page, pageErrors } = await session(SCEN_A);
  const r = await page.evaluate(() => {
    const t = persistent.dailyMoneyTask && persistent.dailyMoneyTask.task;
    // Matematiksel invariant: anapara transferi net varlığı değiştirmez.
    const before = computeNetWorth({ assets: totalAssets(), totalDebt: totalDebtTL() });
    const pay = 27500;
    const after = computeNetWorth({ assets: totalAssets() - pay, totalDebt: totalDebtTL() - pay });
    return { impact: t && t.impact, category: t && t.category, before, after };
  });
  assert.equal(r.after, r.before, 'anapara transferi net varlığı DEĞİŞTİRMEMELİ (matematiksel invariant)');
  assert.ok(r.impact, 'Money Task üretilmedi');
  if (r.category === 'borc') {
    assert.ok(!/net varlığını yaklaşık .*güçlendirebilir/.test(r.impact),
      `borç adımı net varlık artışı İDDİA EDEMEZ: ${r.impact}`);
    assert.ok(/transfer/i.test(r.impact), `borç adımı transfer olduğunu açıklamalı: ${r.impact}`);
  }
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// SENARYO E/F + INVARIANT 4/5/6 — satın alma ve finansman matematiği
// ---------------------------------------------------------------------
test('SENARYO E (INV4): 18 ay / 0 faiz — aylık yük 83.333,33 ve satın alma SONRASI nakit akışı 65.933\'ten KÜÇÜK olmalı (≈ -17.400)', async () => {
  const { page, pageErrors } = await session(SCEN_A);
  const r = await page.evaluate(() => {
    const cap = getAffordCapacityInfo();
    const scen = calculatePurchaseScenario({ price: 2000000, downPayment: 500000, months: 18, ratePct: 0 });
    const d = runDecisionEngine({ type: 'purchase', purchase: {
      category: 'araba', price: 2000000, downPayment: 500000, currentSaved: 0,
      financing: { months: 18, ratePct: 0 }, recurringMonthlyCost: 0, targetDateStr: null, goalId: null } });
    return { pre: cap.monthlyCashFlow, burden: scen.now.monthlyBurden, post: scen.now.monthlyFreeCashAfter,
             level: scen.now.safety.level, decision: d.answerCategory, decisionCash: d.cashFlowAfterDecision, safe: d.safe };
  });
  assert.ok(Math.abs(r.burden - 83333.33) < 0.5, `aylık yük: ${r.burden}`);
  assert.ok(r.post < r.pre, 'INV4: pozitif taahhüt sonrası nakit akışı ARTAMAZ');
  assert.ok(Math.abs(r.post - (-17400.33)) < 1, `satın alma sonrası: ${r.post}`);
  assert.equal(r.decision, 'no_unsafe', 'nakit akışı negatife düşen senaryo güvenli sayılamaz');
  assert.equal(r.safe, false);
  assert.ok(Math.abs(r.decisionCash - (-17400.33)) < 1, 'Decision Engine ve senaryo motoru AYNI değeri vermeli');
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('SENARYO F (INV5/INV6): banka finansmanı 1.5M @4,5%/24ay — aylık ≈103.481, toplam ≡ aylık×24, peşinat ÇİFT SAYILMAZ', async () => {
  const { page, pageErrors } = await session(SCEN_A);
  const r = await page.evaluate(() => {
    const loan = computeLoanFinancing(1500000, 4.5, 24);
    const d = runDecisionEngine({ type: 'purchase', purchase: {
      category: 'araba', price: 2000000, downPayment: 500000, currentSaved: 0,
      financing: { months: 24, ratePct: 4.5 }, recurringMonthlyCost: 0, targetDateStr: null, goalId: null } });
    const scen = calculatePurchaseScenario({ price: 2000000, downPayment: 500000, months: 24, ratePct: 4.5 });
    return { loan, d: { cat: d.answerCategory, cash: d.cashFlowAfterDecision },
             instTotal: scen.installment.totalCost, principal: scen.installment.principal, down: scen.installment.downPayment };
  });
  assert.ok(Math.abs(r.loan.monthlyBurden - 103480.54) < 1, `aylık taksit: ${r.loan.monthlyBurden}`);
  // INV5: finansman toplamı ≡ aylık ödeme × vade (sabit taksitli kredi)
  assert.ok(Math.abs(r.loan.totalCost - r.loan.monthlyBurden * 24) < 0.01, 'INV5 bozuldu: toplam ≠ aylık × vade');
  assert.ok(Math.abs(r.loan.totalCost - 2483533.08) < 1, `toplam: ${r.loan.totalCost}`);
  // INV6: peşinat yalnızca BİR KEZ sayılır — anapara = fiyat − peşinat, toplam nakit = peşinat + finansman
  assert.equal(r.principal, 1500000, 'anapara = fiyat - peşinat olmalı');
  assert.ok(Math.abs(r.instTotal - (r.down + r.loan.totalCost)) < 1, 'INV6: peşinat çift sayılmış olabilir');
  assert.equal(r.d.cat, 'no_unsafe');
  assert.ok(Math.abs(r.d.cash - (-37547.54)) < 1, `finansman sonrası nakit akışı: ${r.d.cash}`);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('INV5 (tasarruf finansmanı): Math.ceil ile yukarı yuvarlanan vadede SON TAKSİDİN KISMİ olduğu açıkça yazılır', async () => {
  const { page, pageErrors } = await session(SCEN_A);
  const r = await page.evaluate(async () => {
    const org = computeSavingsOrgFinancing(1500000, 12, 62500); // 1.680.000 / 62.500 = 26,88 -> 27 ay
    setTab('goals');
    openAdHocAffordEntry();
    document.getElementById('adHocPrice').value = '2000000';
    document.getElementById('adHocDownPayment').value = '500000';
    document.getElementById('adHocSubmitBtn').click();
    await new Promise((res) => setTimeout(res, 80));
    document.getElementById('affordOrgFee').value = '12';
    document.getElementById('affordOrgMonthly').value = '62500';
    document.getElementById('affordOrgMonthly').dispatchEvent(new Event('input'));
    await new Promise((res) => setTimeout(res, 80));
    return { org, orgText: document.getElementById('affordOrgResult').textContent.replace(/\s+/g, ' ') };
  });
  assert.equal(r.org.months, 27);
  assert.equal(r.org.totalCost, 1680000);
  // Matematik doğru ama 27 × 62.500 = 1.687.500 ≠ 1.680.000 olduğu için kısmi son taksit AÇIKLANMALI.
  assert.ok(r.org.monthlyBurden * r.org.months > r.org.totalCost, 'yukarı yuvarlama varsayımı değişmiş');
  assert.ok(/Son taksit kısmidir|last installment is partial/.test(r.orgText),
    `kısmi son taksit açıklanmalı: ${r.orgText.slice(0, 200)}`);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// INVARIANT 8/9/10 — karar taksonomisi, paylaşım kartı ve AI tutarlılığı
// ---------------------------------------------------------------------
test('INV8/INV9/INV10: karar kategorisi ↔ etiket ↔ paylaşım kartı ↔ AI context TEK kaynaktan gelir', async () => {
  const { page, pageErrors } = await session(SCEN_A);
  const r = await page.evaluate(async () => {
    setTab('goals');
    openAdHocAffordEntry();
    document.getElementById('adHocPrice').value = '2000000';
    document.getElementById('adHocDownPayment').value = '500000';
    document.getElementById('adHocSubmitBtn').click();
    await new Promise((res) => setTimeout(res, 80));
    const cat = affordLastResult.decision.answerCategory;
    const badge = document.getElementById('decisionCategoryBadge').textContent.trim();
    const expectedLabel = decisionCategoryLabel(cat, affordLastResult.decision.affordabilityDate, false);
    // Paylaşım kartı metinlerini yakala
    const proto = CanvasRenderingContext2D.prototype;
    const orig = proto.fillText;
    const texts = [];
    proto.fillText = function (t, ...rest) { texts.push(String(t)); return orig.apply(this, [t, ...rest]); };
    try { drawAffordShareCard(affordLastResult, false); } finally { proto.fillText = orig; }
    return { cat, badge, expectedLabel, etaUI: affordEtaState(affordLastResult, false).text, texts,
             aiCash: buildAICoachContext().financialSnapshot.monthlyCashFlow, coreCash: _cashFlowCache };
  });
  assert.ok(['yes_today', 'yes_on_date', 'yes_with_condition', 'yes_delays_goals', 'no_unsafe'].includes(r.cat));
  assert.equal(r.badge, r.expectedLabel, 'INV8: gösterilen etiket kategoriyle birebir eşleşmeli');
  assert.ok(r.texts.includes(r.etaUI), 'INV9: paylaşım kartı ETA durumu görünür UI ile AYNI olmalı');
  assert.ok(r.texts.includes('Satın Alma Kararı'), 'paylaşım kartı ürün-yüzü terimi korunmalı');
  assert.ok(!r.texts.some((t) => /Ad-hoc/i.test(t)), 'kullanıcıya "Ad-hoc" terimi gösterilemez');
  assert.equal(r.aiCash, r.coreCash, 'INV10: AI context ile Finance Core aynı nakit akışını kullanmalı');
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// INVARIANT 12/13 — sayısal tip güvenliği ve deterministik kur çevrimi
// ---------------------------------------------------------------------
test('INV12: string olarak girilen tutarlar STRING BİRLEŞTİRME yapmaz (numeric normalizasyon)', async () => {
  const { page, pageErrors } = await session(null);
  const r = await page.evaluate(() => {
    // Bozuk/string veri normalizasyondan geçmeli: "50000" + "6000" = 56000 (asla "500006000")
    month.incomes = [{ id: 'i1', category: 'Maaş', amount: '50000' }, { id: 'i2', category: 'Ek', amount: '6000' }];
    month.expenses = [{ id: 'e1', category: 'Diğer', amount: '1000', fixed: false }];
    month = normalizeMonthFinancialFields(month);
    render();
    return { income: totalIncome(), spent: totalSpent(), typeIncome: typeof totalIncome(), kalan: _cashFlowCache };
  });
  assert.equal(r.typeIncome, 'number');
  assert.equal(r.income, 56000, `string birleştirme olmuş olabilir: ${r.income}`);
  assert.equal(r.spent, 1000);
  assert.equal(r.kalan, 55000);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('INV13 (SENARYO G): aynı tutar+kur için çevrim DETERMİNİSTİKTİR ve USD borcu TL borcuna doğru yansır', async () => {
  const { page, pageErrors } = await session(null);
  const r = await page.evaluate(() => {
    const a = convertToTRY(5000, 'USD');
    const b = convertToTRY(5000, 'USD');
    const rate = EXCHANGE_RATES.USD;
    persistent.accounts = []; persistent.creditCards = [];
    persistent.debts = [{ id: 'd2', category: 'Diğer', balance: 5000, minPayment: 0, rate: 0, currency: 'USD' }];
    month.incomes = [{ id: 'i1', category: 'Maaş', amount: 110000 }];
    month.expenses = [{ id: 'e1', category: 'Diğer', amount: 44067, fixed: false }];
    render();
    return { a, b, rate, debtTL: totalDebtTL(), unknown: convertToTRY(100, 'XYZ') };
  });
  assert.equal(r.a, r.b, 'INV13: aynı girdi aynı sonucu vermeli');
  assert.ok(Math.abs(r.a - 5000 * r.rate) < 0.01, 'çevrim tutar × kur olmalı');
  assert.ok(Math.abs(r.debtTL - 5000 * r.rate) < 1, `USD borcu TL'ye doğru çevrilmeli: ${r.debtTL} (kur ${r.rate})`);
  assert.equal(r.unknown, 100, 'bilinmeyen para birimi güvenli fallback ile dönmeli');
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// INVARIANT 14 (SENARYO J) — ay verisi başka aya SIZMAZ
// ---------------------------------------------------------------------
test('INV14 (SENARYO J): bu ayın toplamları yalnızca bu ayın kaydından gelir — başka ayın anahtarı sızmaz', async () => {
  const { page, pageErrors } = await session(null);
  const r = await page.evaluate(() => {
    // Geçen ayın kaydını ayrı bir anahtara yaz; bu ayın toplamlarını etkilememeli.
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevKey = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
    try {
      localStorage.setItem(`budget:${prevKey}`, JSON.stringify({
        incomes: [{ id: 'px', category: 'Maaş', amount: 999999 }],
        expenses: [{ id: 'py', category: 'Diğer', amount: 888888, fixed: false }],
        goal: { type: 'save', amount: 0 },
      }));
    } catch (e) { /* storage kapalıysa test yine anlamlı */ }
    month.incomes = [{ id: 'i1', category: 'Maaş', amount: 110000 }];
    month.expenses = [{ id: 'e1', category: 'Diğer', amount: 44067, fixed: false }];
    render();
    return { income: totalIncome(), spent: totalSpent(), kalan: _cashFlowCache,
             thisKey: monthKey, prevKey, separateKeys: MONTH_KEY !== `budget:${prevKey}` };
  });
  assert.equal(r.separateKeys, true, 'aylar ayrı depolama anahtarlarında tutulmalı');
  assert.equal(r.income, 110000, `başka ayın geliri sızmış: ${r.income}`);
  assert.equal(r.spent, 44067, `başka ayın gideri sızmış: ${r.spent}`);
  assert.equal(r.kalan, 65933);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// Güvenli günlük harcama TEK kaynaktan gelir (ekran ile koç aynı sayıyı söyler)
// ---------------------------------------------------------------------
test('TEK KAYNAK: güvenli günlük harcama, ana ekran ile AI Coach cevabında AYNI değerden türetilir', async () => {
  const { page, pageErrors } = await session(SCEN_A);
  const r = await page.evaluate(() => {
    const cf = computeCashFlowSummary({
      income: totalIncome(), expenses: cashOutSpent(), debtPayments: monthlyDebtPayments(),
      remainingDays: daysLeft,
      remainingFixedEstimate: Math.max(0, (history.length ? history[history.length - 1].fixedExpense || 0 : 0) - totalFixedExpense()),
    });
    return { core: cf.safeDailySpend, dom: document.getElementById('dailyAmountNum').textContent.trim(),
             coach: answerHowMuchCanISpend() };
  });
  // DOM ve koç metni aynı çekirdek değerden türemeli (biçimlendirme farkı olabilir, rakam aynı).
  const fmtNum = Math.round(r.core).toLocaleString('tr-TR');
  assert.ok(r.dom.includes(fmtNum.split(',')[0]) || r.dom.includes(String(Math.round(r.core))),
    `DOM güvenli günlük (${r.dom}) çekirdek değerle (${r.core}) uyuşmuyor`);
  assert.ok(r.coach.includes(fmtNum) || r.coach.includes(String(Math.round(r.core))),
    `koç cevabı (${r.coach.slice(0, 160)}) çekirdek değerle (${r.core}) uyuşmuyor`);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});
