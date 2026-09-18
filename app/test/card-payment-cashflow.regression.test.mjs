// KREDİ KARTI GERÇEK ÖDEME MODELİ — regresyon testleri (P1)
// -----------------------------------------------------------------------
// Bulgu (read-only audit): monthlyDebtPayments() kartlar için card.minPayment KONFİGÜRASYONUNU
// kullanıyordu — bu ay gerçekten applyCardPayment() ile ödeme yapılmış olsa bile "Kalan"/Tasarruf
// Oranı/Güvenli Harcama/Decision Engine/AI Coach/Money Task bundan HABERSİZ kalıyordu (gerçek
// banka hesabı bakiyesi düşüyor, ama nakit akışı anlatısı bunu hiç yansıtmıyordu).
//
// Düzeltme: applyCardPayment() artık (iade hariç) ay bazlı bir günlüğe (persistent.cardPaymentLog)
// yazıyor; allDebts() kartlar için "bu ay gerçek ödeme var mı?" diye bakıyor, varsa onu, yoksa
// minPayment TAHMİNİNİ kullanıyor (cashFlowPaymentTL + paymentIsEstimated). Borç ödeme
// PLANLARINI besleyen paymentTL (avalanche/snowball/simulatePayoff) BİLEREK dokunulmadan kaldı.
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

async function newPage() {
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
  return { page, pageErrors };
}

// income 110000 / cash expense 20000 / card spending 24000, card starting balance = spending
function baseSetup() {
  persistent.accounts = [{ id: 'a1', name: 'Banka', type: 'Banka Hesabı', balance: 500000, currency: 'TRY' }];
  persistent.debts = [];
  persistent.creditCards = [{ id: 'c1', name: 'Kart', currentBalance: 24000, limit: 200000, currency: 'TRY', minPayment: 10000, statementDay: 1, dueDay: 10 }];
  persistent.goals = []; persistent.dailyMoneyTask = null; persistent.cardPaymentLog = [];
  month.incomes = [{ id: 'i1', category: 'Maaş', amount: 110000 }];
  month.expenses = [
    { id: 'e1', category: 'Diğer', amount: 20000, fixed: false },
    { id: 'e2', category: 'Diğer', amount: 24000, fixed: false, cardId: 'c1' },
  ];
}

test('TEST A: real 10000 card payment -> cash flow uses the REAL payment, not minPayment', async () => {
  const { page, pageErrors } = await newPage();
  const out = await page.evaluate((setupSrc) => {
    eval(setupSrc);
    const accBefore = persistent.accounts[0].balance;
    const cardBefore = persistent.creditCards[0].currentBalance;
    const nwBefore = computeNetWorth({ assets: totalAssets(), totalDebt: totalDebtTL() });
    applyCardPayment(persistent.creditCards[0], 10000, 'a1');
    render();
    const nwAfter = computeNetWorth({ assets: totalAssets(), totalDebt: totalDebtTL() });
    return {
      totalSpent: totalSpent(), cashOutSpent: cashOutSpent(),
      debtPay: monthlyDebtPayments(), breakdown: monthlyDebtPaymentsBreakdown(),
      domKalan: document.getElementById('sumRemain').textContent.trim(),
      domSavings: document.getElementById('savingsRateStat').textContent.trim(),
      accBefore, accAfter: persistent.accounts[0].balance,
      cardBefore, cardAfter: persistent.creditCards[0].currentBalance,
      nwBefore, nwAfter,
      aiCashFlow: buildAICoachContext().financialSnapshot.monthlyCashFlow,
      capCashFlow: getAffordCapacityInfo().monthlyCashFlow,
    };
  }, baseSetup.toString() + '\nbaseSetup();');
  assert.equal(out.totalSpent, 44000, 'ekonomik harcama 44.000 olmalı');
  assert.equal(out.cashOutSpent, 20000, 'nakit çıkışı yalnızca nakit gider olmalı');
  assert.equal(out.debtPay, 10000, 'borç ödemesi gerçek ödeme (10.000) olmalı');
  assert.equal(out.breakdown.actual, 10000, 'gerçekleşen ödeme 10.000 olarak raporlanmalı');
  assert.equal(out.breakdown.estimated, 0, 'gerçek ödeme varken tahmini sıfır olmalı (10.000+10.000=20.000 OLMAMALI)');
  assert.ok(out.domKalan.includes('80.000'), `Kalan 80.000 olmalı, geldi: ${out.domKalan}`);
  assert.ok(out.domSavings.includes('72,7') || out.domSavings.includes('72.7'), `Tasarruf oranı ~%72.7 olmalı, geldi: ${out.domSavings}`);
  assert.equal(out.accAfter, out.accBefore - 10000, 'banka hesabı gerçekten 10.000 düşmeli');
  assert.equal(out.cardAfter, out.cardBefore - 10000, 'kart borcu gerçekten 10.000 düşmeli');
  assert.equal(out.nwAfter, out.nwBefore, 'net worth ödeme yüzünden DEĞİŞMEMELİ (transfer)');
  assert.equal(out.aiCashFlow, 80000, 'AI Coach context aynı nakit akışını görmeli');
  assert.equal(out.capCashFlow, 80000, 'Decision Engine kapasitesi aynı nakit akışını görmeli');
  assert.equal(pageErrors.length, 0, `pageerror: ${pageErrors.join(', ')}`);
  await page.close();
});

test('TEST B: no real payment -> minPayment used, explicitly marked ESTIMATED', async () => {
  const { page } = await newPage();
  const out = await page.evaluate((setupSrc) => {
    eval(setupSrc);
    render();
    return {
      debtPay: monthlyDebtPayments(), breakdown: monthlyDebtPaymentsBreakdown(),
      allDebtsRow: allDebts().find(d => d.id === 'c1'),
      estRowShown: document.getElementById('sumDebtPayEstRow').style.display !== 'none',
      estRowVal: document.getElementById('sumDebtPayEst').textContent.trim(),
    };
  }, baseSetup.toString() + '\nbaseSetup();');
  assert.equal(out.debtPay, 10000, 'gerçek ödeme yokken minPayment tahmini kullanılmalı');
  assert.equal(out.breakdown.actual, 0, 'gerçek ödeme yok');
  assert.equal(out.breakdown.estimated, 10000, 'tamamı tahmini olmalı');
  assert.equal(out.allDebtsRow.paymentIsEstimated, true, 'kart satırı tahmini olarak işaretlenmeli');
  assert.equal(out.estRowShown, true, 'UI tahmini satırı göstermeli');
  assert.ok(out.estRowVal.includes('10.000'), `tahmini satır 10.000 göstermeli: ${out.estRowVal}`);
  await page.close();
});

test('TEST C: minPayment=10000, real payment=7000 -> debt payment is 7000, not 17000', async () => {
  const { page } = await newPage();
  const out = await page.evaluate((setupSrc) => {
    eval(setupSrc);
    applyCardPayment(persistent.creditCards[0], 7000, 'a1');
    render();
    return { debtPay: monthlyDebtPayments(), breakdown: monthlyDebtPaymentsBreakdown() };
  }, baseSetup.toString() + '\nbaseSetup();');
  assert.equal(out.debtPay, 7000, `beklenen 7000, geldi ${out.debtPay}`);
  assert.notEqual(out.debtPay, 17000, 'gerçek ödeme ve minPayment toplanmamalı');
  assert.equal(out.breakdown.actual, 7000);
  assert.equal(out.breakdown.estimated, 0);
  await page.close();
});

test('TEST D: minPayment=10000, real payment=15000 -> debt payment is 15000 (real > estimate wins)', async () => {
  const { page } = await newPage();
  const out = await page.evaluate((setupSrc) => {
    eval(setupSrc);
    applyCardPayment(persistent.creditCards[0], 15000, 'a1');
    render();
    return { debtPay: monthlyDebtPayments() };
  }, baseSetup.toString() + '\nbaseSetup();');
  assert.equal(out.debtPay, 15000);
  await page.close();
});

test('TEST E: full payoff (24000 spending, 24000 real payment) -> card debt net change 0, cash flow includes 24000, economic spend unchanged, net worth unaffected by the payment itself', async () => {
  const { page } = await newPage();
  const out = await page.evaluate((setupSrc) => {
    eval(setupSrc);
    const cardStart = 0; // this scenario starts a fresh card cycle
    persistent.creditCards[0].currentBalance = 0;
    month.expenses = [
      { id: 'e1', category: 'Diğer', amount: 20000, fixed: false },
      { id: 'e2', category: 'Diğer', amount: 24000, fixed: false, cardId: 'c1' },
    ];
    persistent.creditCards[0].currentBalance = 24000; // spend increases balance (as the real add-expense flow does)
    const nwBeforePayment = computeNetWorth({ assets: totalAssets(), totalDebt: totalDebtTL() });
    applyCardPayment(persistent.creditCards[0], 24000, 'a1');
    render();
    const nwAfterPayment = computeNetWorth({ assets: totalAssets(), totalDebt: totalDebtTL() });
    return {
      totalSpent: totalSpent(), cardBalance: persistent.creditCards[0].currentBalance,
      debtPay: monthlyDebtPayments(), nwBeforePayment, nwAfterPayment,
    };
  }, baseSetup.toString() + '\nbaseSetup();');
  assert.equal(out.totalSpent, 44000, 'ekonomik harcama değişmemeli');
  assert.equal(out.cardBalance, 0, 'kart borcu net değişimi 0 (24000 harcama - 24000 ödeme)');
  assert.equal(out.debtPay, 24000, 'nakit akışı 24.000 gerçek ödemeyi içermeli');
  assert.equal(out.nwAfterPayment, out.nwBeforePayment, 'ödemenin kendisi net worth değiştirmemeli');
  await page.close();
});

test('TEST F: multiple partial payments in the same month aggregate correctly (4000+6000+2500=12500)', async () => {
  const { page } = await newPage();
  const out = await page.evaluate((setupSrc) => {
    eval(setupSrc);
    applyCardPayment(persistent.creditCards[0], 4000, 'a1');
    applyCardPayment(persistent.creditCards[0], 6000, 'a1');
    applyCardPayment(persistent.creditCards[0], 2500, 'a1');
    render();
    return { debtPay: monthlyDebtPayments(), logCount: persistent.cardPaymentLog.length };
  }, baseSetup.toString() + '\nbaseSetup();');
  assert.equal(out.debtPay, 12500, `beklenen 12500, geldi ${out.debtPay}`);
  assert.equal(out.logCount, 3, 'üç ayrı ödeme kaydı tutulmalı');
  await page.close();
});

test('TEST G: a payment recorded in a DIFFERENT month must not count toward this month\'s cash flow', async () => {
  const { page } = await newPage();
  const out = await page.evaluate((setupSrc) => {
    eval(setupSrc);
    // Başka bir aya ait sahte bir ödeme kaydı enjekte ediyoruz (gerçek akışta bu satırı yalnızca
    // applyCardPayment() o AY çalışırken yazar; burada "başka ayda ödendi" durumunu simüle ediyoruz).
    persistent.cardPaymentLog.push({ id: 'x1', cardId: 'c1', amount: 999999, monthKey: '2000-01', at: '2000-01-01T00:00:00.000Z' });
    render();
    return { debtPay: monthlyDebtPayments(), breakdown: monthlyDebtPaymentsBreakdown() };
  }, baseSetup.toString() + '\nbaseSetup();');
  assert.equal(out.debtPay, 10000, 'başka aya ait kayıt bu ayı etkilememeli, minPayment tahmini geçerli olmalı');
  assert.equal(out.breakdown.estimated, 10000);
  await page.close();
});

test('TEST H: reload/cross-tab — the real-payment log survives normalizePersistentFinancialFields()', async () => {
  const { page } = await newPage();
  const out = await page.evaluate((setupSrc) => {
    eval(setupSrc);
    applyCardPayment(persistent.creditCards[0], 10000, 'a1');
    const normalized = normalizePersistentFinancialFields(JSON.parse(JSON.stringify(persistent)));
    persistent = normalized;
    render();
    return { debtPay: monthlyDebtPayments(), logLen: persistent.cardPaymentLog.length };
  }, baseSetup.toString() + '\nbaseSetup();');
  assert.equal(out.logLen, 1, 'ödeme kaydı normalizasyondan sonra kaybolmamalı');
  assert.equal(out.debtPay, 10000, 'normalizasyon sonrası nakit akışı hâlâ gerçek ödemeyi kullanmalı');
  await page.close();
});

test('TEST I: orphan-card P0 regression must not have returned', async () => {
  const { page, pageErrors } = await newPage();
  const out = await page.evaluate(() => {
    persistent.accounts = [{ id: 'a1', name: 'Banka', type: 'Banka Hesabı', balance: 500000, currency: 'TRY' }];
    persistent.debts = []; persistent.creditCards = []; persistent.goals = []; persistent.dailyMoneyTask = null; persistent.cardPaymentLog = [];
    month.incomes = [{ id: 'i1', category: 'Maaş', amount: 110000 }];
    month.expenses = [{ id: 'e2', category: 'Diğer', amount: 44067, fixed: false, cardId: 'GHOST_CARD' }];
    render();
    return { cashOutSpent: cashOutSpent(), domKalan: document.getElementById('sumRemain').textContent.trim() };
  });
  assert.equal(out.cashOutSpent, 44067, 'sahipsiz cardId hâlâ nakit çıkışı olarak sayılmalı (P0 geri gelmemeli)');
  assert.ok(out.domKalan.includes('65.933'), `Kalan 65.933 olmalı: ${out.domKalan}`);
  assert.equal(pageErrors.length, 0);
  await page.close();
});

test('TEST J: double-count invariant — card spend + its payment in the same month never double-subtracts', async () => {
  const { page } = await newPage();
  const out = await page.evaluate((setupSrc) => {
    eval(setupSrc);
    applyCardPayment(persistent.creditCards[0], 10000, 'a1');
    render();
    // Manuel referans: gelir - (yalnızca NAKİT gider) - (gerçek borç ödemesi) = Kalan
    // 24.000'lik kart harcaması burada NE nakit çıkışında NE de ayrıca "ödeme" olarak iki kez yer almamalı.
    const income = totalIncome();
    const manualExpected = income - cashOutSpent() - monthlyDebtPayments();
    return {
      manualExpected,
      cfSummary: computeCashFlowSummary({ income, expenses: cashOutSpent(), debtPayments: monthlyDebtPayments(), remainingDays: daysLeft }).remaining,
      cardFundedSpent: cardFundedSpent(), cashOutSpent: cashOutSpent(), debtPay: monthlyDebtPayments(),
    };
  }, baseSetup.toString() + '\nbaseSetup();');
  assert.equal(out.manualExpected, 80000);
  assert.equal(out.cfSummary, 80000, 'Finance Core ile manuel hesap birebir aynı olmalı');
  // 24.000 kart harcaması: cashOutSpent'te YOK (20.000'de), debtPay'de de 24.000 olarak YOK (10.000 gerçek ödeme var) -> çift sayım yok.
  assert.equal(out.cashOutSpent, 20000);
  assert.equal(out.debtPay, 10000);
  await page.close();
});

test('Refund does not count as a real cash-flow payment', async () => {
  const { page } = await newPage();
  const out = await page.evaluate((setupSrc) => {
    eval(setupSrc);
    applyCardPayment(persistent.creditCards[0], 5000, '', { countsAsCashPayment: false });
    render();
    return { debtPay: monthlyDebtPayments(), breakdown: monthlyDebtPaymentsBreakdown(), logLen: persistent.cardPaymentLog.length };
  }, baseSetup.toString() + '\nbaseSetup();');
  assert.equal(out.logLen, 0, 'iade günlüğe yazılmamalı');
  assert.equal(out.debtPay, 10000, 'iade sonrası hâlâ minPayment tahmini geçerli olmalı');
  await page.close();
});
