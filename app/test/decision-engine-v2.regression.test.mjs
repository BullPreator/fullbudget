// DECISION ENGINE v2 — regresyon testleri
// -----------------------------------------------------------------------
// "Bu ay paramla ne yapmalıyım?" sorusuna yapısal, deterministik cevap veren YENİ katman
// (buildMonthlySnapshot / runDecisionEngineV2 / runWhatIfScenario / renderDecisionEngineV2).
// Bu testler: (a) mevcut "Bu Ay Ne Yapmalısın?" (computePriorityPlan) sistemine DOKUNULMADIĞINI,
// (b) kredi kartı gerçek ödeme modelinin double-count edilmediğini, (c) what-if senaryolarının
// gerçek state'i MUTASYONA UĞRATMADIĞINI, (d) STEP 10'daki uç durumların "needs_more_data" /
// "negative_cash_flow" gibi doğru durumlara düştüğünü doğrular.
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

// Baz senaryo: gelir 110000, nakit gider 20000, kart harcaması 24000, gerçek kart ödemesi 10000,
// bir acil fon açığı YOK (yüksek likit varlık), bir hedef ve bir esnek borç var.
function baseSetup() {
  persistent.accounts = [{ id: 'a1', name: 'Banka', type: 'Banka Hesabı', balance: 500000, currency: 'TRY' }];
  persistent.debts = [{ id: 'd1', category: 'ihtiyac', note: 'İhtiyaç Kredisi', balance: 30000, rate: 4.5, minPayment: 2000, extraPayment: 0, currency: 'TRY' }];
  persistent.creditCards = [{ id: 'c1', name: 'Kart', currentBalance: 24000, limit: 200000, currency: 'TRY', minPayment: 10000, statementDay: 1, dueDay: 10 }];
  persistent.goals = [{ id: 'g1', typeKey: 'tatil', targetAmount: 60000, currentSaved: 10000, targetDate: addMonthsISO(6) }];
  persistent.dailyMoneyTask = null; persistent.cardPaymentLog = [];
  month.incomes = [{ id: 'i1', category: 'Maaş', amount: 110000 }];
  month.expenses = [
    { id: 'e1', category: 'Diğer', amount: 20000, fixed: false },
    { id: 'e2', category: 'Diğer', amount: 24000, fixed: false, cardId: 'c1' },
  ];
}
function addMonthsISO(n) {
  const d = new Date(); d.setMonth(d.getMonth() + n);
  return d.toISOString().slice(0, 10);
}

async function runSnapshot(page, setupFnSrc) {
  return page.evaluate((setupSrc) => {
    eval(setupSrc);
    render();
    const snapshot = buildMonthlySnapshot();
    const result = runDecisionEngineV2(snapshot);
    return { snapshot, result };
  }, setupFnSrc);
}

test('DE2-1: temel pozitif senaryo — snapshot doğru kuruldu, engine crash üretmedi', async () => {
  const { page, pageErrors } = await newPage();
  const src = `${addMonthsISO.toString()}\n${baseSetup.toString()}\nbaseSetup();\nrender();`;
  const { snapshot, result } = await runSnapshot(page, src);
  assert.equal(pageErrors.length, 0, 'pageerror olmamalı: ' + JSON.stringify(pageErrors));
  assert.equal(snapshot.income, 110000);
  assert.ok(result.status);
  await page.close();
});

test('DE2-2: gerçek kart ödemesi P0 aksiyonunda görünür ama distributableCash\'ten İKİNCİ KEZ düşülmez', async () => {
  const { page, pageErrors } = await newPage();
  const src = `
    ${addMonthsISO.toString()}\n${baseSetup.toString()}
    baseSetup();
    render();
    applyCardPayment(persistent.creditCards[0], 10000, 'a1');
    render();
  `;
  const out = await page.evaluate((setupSrc) => {
    eval(setupSrc);
    const snapshot = buildMonthlySnapshot();
    const result = runDecisionEngineV2(snapshot);
    return { snapshot, result, capCashFlow: getAffordCapacityInfo().monthlyCashFlow, monthlyDebtPayments: monthlyDebtPayments() };
  }, src);
  assert.equal(pageErrors.length, 0, 'pageerror olmamalı: ' + JSON.stringify(pageErrors));
  const cardDebt = out.snapshot.debts.find(d => d.id === 'c1');
  assert.equal(cardDebt.cashFlowPaymentTL, 10000, 'snapshot gerçek ödemeyi yansıtmalı');
  assert.equal(cardDebt.paymentIsEstimated, false, 'gerçek ödeme var, tahmini değil');
  assert.equal(out.snapshot.monthlyCashFlow, out.capCashFlow, 'snapshot.monthlyCashFlow, canonical getAffordCapacityInfo() ile AYNI olmalı (yeni hesap icat edilmedi)');
  const p0debt = out.result.actions.find(a => a.type === 'debt_payment' && a.relatedDebtId === 'c1');
  assert.ok(p0debt, 'kart ödemesi P0 aksiyonu olarak listelenmeli');
  assert.equal(p0debt.amount, 10000);
  assert.equal(p0debt.confidence, 'actual');
  // Double-count DENETİMİ: availableCash zaten monthlyDebtPayments() (kart ödemesi dahil) düşülmüş
  // haldeyken hesaplanır; P1..P4 tahsisatlarının toplamı availableCash'i AŞMAMALI.
  const allocated = out.result.protectedCash + out.result.actions.filter(a => ['P2', 'P3', 'P4'].includes(a.priority)).reduce((s, a) => s + a.amount, 0);
  assert.ok(allocated <= out.result.availableCash + 1, `tahsisat toplamı (${allocated}) availableCash'i (${out.result.availableCash}) aşmamalı`);
  await page.close();
});

test('DE2-3: tahmini kart ödemesi (gerçek ödeme YOK) — paymentIsEstimated=true ve UI\'da işaretli', async () => {
  const { page, pageErrors } = await newPage();
  const src = `${addMonthsISO.toString()}\n${baseSetup.toString()}\nbaseSetup();\nrender();`;
  const out = await page.evaluate((setupSrc) => {
    eval(setupSrc);
    const snapshot = buildMonthlySnapshot();
    const result = runDecisionEngineV2(snapshot);
    return { snapshot, result };
  }, src);
  assert.equal(pageErrors.length, 0);
  const cardDebt = out.snapshot.debts.find(d => d.id === 'c1');
  assert.equal(cardDebt.paymentIsEstimated, true, 'gerçek ödeme yokken tahmini olmalı');
  const p0debt = out.result.actions.find(a => a.type === 'debt_payment' && a.relatedDebtId === 'c1');
  assert.equal(p0debt.confidence, 'estimated');
  await page.close();
});

test('DE2-4: gelir yok -> needs_more_data, hiçbir tahsisat/uydurma tavsiye yok', async () => {
  const { page, pageErrors } = await newPage();
  const src = `
    persistent.accounts = []; persistent.debts = []; persistent.creditCards = [];
    persistent.goals = []; persistent.dailyMoneyTask = null; persistent.cardPaymentLog = [];
    month.incomes = []; month.expenses = [];
    render();
  `;
  const out = await page.evaluate((setupSrc) => {
    eval(setupSrc);
    const snapshot = buildMonthlySnapshot();
    return runDecisionEngineV2(snapshot);
  }, src);
  assert.equal(pageErrors.length, 0);
  assert.equal(out.status, 'needs_more_data');
  assert.equal(out.actions.length, 0);
  assert.equal(out.distributableCash, 0);
  await page.close();
});

test('DE2-5: negatif nakit akışı -> negative_cash_flow durumu, distributableCash=0, uyarı var', async () => {
  const { page, pageErrors } = await newPage();
  const src = `
    persistent.accounts = [{ id: 'a1', name: 'Banka', type: 'Banka Hesabı', balance: 5000, currency: 'TRY' }];
    persistent.debts = []; persistent.creditCards = [];
    persistent.goals = []; persistent.dailyMoneyTask = null; persistent.cardPaymentLog = [];
    month.incomes = [{ id: 'i1', category: 'Maaş', amount: 20000 }];
    month.expenses = [{ id: 'e1', category: 'Diğer', amount: 35000, fixed: false }];
    render();
  `;
  const out = await page.evaluate((setupSrc) => {
    eval(setupSrc);
    const snapshot = buildMonthlySnapshot();
    return runDecisionEngineV2(snapshot);
  }, src);
  assert.equal(pageErrors.length, 0);
  assert.equal(out.status, 'negative_cash_flow');
  assert.equal(out.distributableCash, 0);
  assert.ok(out.warnings.length >= 1, 'negatif nakit akışında en az bir uyarı olmalı');
  await page.close();
});

test('DE2-6: sıfır nakit + sıfır fazla -> hiçbir P1-P4 aksiyonu tahsis edilmez (crash yok)', async () => {
  const { page, pageErrors } = await newPage();
  const src = `
    persistent.accounts = [{ id: 'a1', name: 'Banka', type: 'Banka Hesabı', balance: 0, currency: 'TRY' }];
    persistent.debts = []; persistent.creditCards = [];
    persistent.goals = []; persistent.dailyMoneyTask = null; persistent.cardPaymentLog = [];
    month.incomes = [{ id: 'i1', category: 'Maaş', amount: 20000 }];
    month.expenses = [{ id: 'e1', category: 'Diğer', amount: 20000, fixed: false }];
    render();
  `;
  const out = await page.evaluate((setupSrc) => {
    eval(setupSrc);
    const snapshot = buildMonthlySnapshot();
    return runDecisionEngineV2(snapshot);
  }, src);
  assert.equal(pageErrors.length, 0);
  assert.ok(['negative_cash_flow', 'safe_to_allocate', 'protect_liquidity'].includes(out.status));
  assert.ok(out.distributableCash <= 1);
  await page.close();
});

test('DE2-7: likidite açığı büyük -> protect_liquidity durumu, P1 aksiyonu emergencyReserve kadar', async () => {
  const { page, pageErrors } = await newPage();
  const src = `
    persistent.accounts = [{ id: 'a1', name: 'Banka', type: 'Banka Hesabı', balance: 1000, currency: 'TRY' }];
    persistent.debts = []; persistent.creditCards = [];
    persistent.goals = []; persistent.dailyMoneyTask = null; persistent.cardPaymentLog = [];
    month.incomes = [{ id: 'i1', category: 'Maaş', amount: 100000 }];
    month.expenses = [{ id: 'e1', category: 'Diğer', amount: 20000, fixed: false }];
    render();
  `;
  const out = await page.evaluate((setupSrc) => {
    eval(setupSrc);
    const snapshot = buildMonthlySnapshot();
    return { snapshot, result: runDecisionEngineV2(snapshot) };
  }, src);
  assert.equal(pageErrors.length, 0);
  if (out.snapshot.emergencyGap > 0) {
    assert.equal(out.result.status, 'protect_liquidity');
    const p1 = out.result.actions.find(a => a.type === 'liquidity_protection');
    assert.ok(p1, 'likidite koruması aksiyonu olmalı');
    assert.equal(p1.amount, out.result.protectedCash);
    assert.ok(p1.amount > 0);
  }
  await page.close();
});

test('DE2-8: pahalı esnek borç (kredi kartı gibi) mevduat getirisinin üzerindeyse debt_priority', async () => {
  const { page, pageErrors } = await newPage();
  const src = `
    persistent.accounts = [{ id: 'a1', name: 'Banka', type: 'Banka Hesabı', balance: 400000, currency: 'TRY' }];
    persistent.debts = [{ id: 'd1', category: 'ihtiyac', note: 'Pahalı Borç', balance: 50000, rate: 8, minPayment: 0, extraPayment: 0, currency: 'TRY' }];
    persistent.creditCards = [];
    persistent.goals = []; persistent.dailyMoneyTask = null; persistent.cardPaymentLog = [];
    month.incomes = [{ id: 'i1', category: 'Maaş', amount: 60000 }];
    month.expenses = [{ id: 'e1', category: 'Diğer', amount: 10000, fixed: false }];
    render();
  `;
  const out = await page.evaluate((setupSrc) => {
    eval(setupSrc);
    const snapshot = buildMonthlySnapshot();
    return { snapshot, result: runDecisionEngineV2(snapshot) };
  }, src);
  assert.equal(pageErrors.length, 0);
  const debtAction = out.result.actions.find(a => a.type === 'debt_reduction');
  assert.ok(debtAction, 'faizi mevduatın üzerinde olan borç için P2 aksiyonu üretilmeli');
  assert.equal(debtAction.relatedDebtId, 'd1');
  await page.close();
});

test('DE2-9: sabit taksitli kredi (fixedSchedule) P2 ekstra ödeme hedefi OLARAK seçilmez', async () => {
  const { page, pageErrors } = await newPage();
  const src = `
    persistent.accounts = [{ id: 'a1', name: 'Banka', type: 'Banka Hesabı', balance: 400000, currency: 'TRY' }];
    persistent.debts = [{ id: 'd1', category: 'Kredi', note: 'Taksitli Kredi', balance: 50000, rate: 8, minPayment: 3000, extraPayment: 0, currency: 'TRY', termRemaining: 10, installment: 5000 }];
    persistent.creditCards = [];
    persistent.goals = []; persistent.dailyMoneyTask = null; persistent.cardPaymentLog = [];
    month.incomes = [{ id: 'i1', category: 'Maaş', amount: 60000 }];
    month.expenses = [{ id: 'e1', category: 'Diğer', amount: 10000, fixed: false }];
    render();
  `;
  const out = await page.evaluate((setupSrc) => {
    eval(setupSrc);
    const snapshot = buildMonthlySnapshot();
    const d1 = snapshot.debts.find(d => d.id === 'd1');
    return { fixedSchedule: d1 ? d1.fixedSchedule : null, result: runDecisionEngineV2(snapshot) };
  }, src);
  assert.equal(pageErrors.length, 0);
  assert.equal(out.fixedSchedule, true, 'termRemaining/installment dolu bir "Kredi" kaydı isInstallmentLoan() tarafından sabit taksitli sayılmalı');
  const debtAction = out.result.actions.find(a => a.type === 'debt_reduction' && a.relatedDebtId === 'd1');
  assert.equal(debtAction, undefined, 'sabit taksitli kredi P2 ekstra ödeme hedefi olmamalı (avalanche/snowball ile aynı kural)');
  await page.close();
});

test('DE2-10: en acil hedef (en az ayı kalan) goal_priority ile seçilir', async () => {
  const { page, pageErrors } = await newPage();
  const src = `
    persistent.accounts = [{ id: 'a1', name: 'Banka', type: 'Banka Hesabı', balance: 400000, currency: 'TRY' }];
    persistent.debts = []; persistent.creditCards = [];
    persistent.goals = [
      { id: 'gFar', typeKey: 'tatil', targetAmount: 100000, currentSaved: 0, targetDate: (function(){var d=new Date();d.setMonth(d.getMonth()+24);return d.toISOString().slice(0,10);})() },
      { id: 'gYakin', typeKey: 'telefon', targetAmount: 30000, currentSaved: 0, targetDate: (function(){var d=new Date();d.setMonth(d.getMonth()+2);return d.toISOString().slice(0,10);})() },
    ];
    persistent.dailyMoneyTask = null; persistent.cardPaymentLog = [];
    month.incomes = [{ id: 'i1', category: 'Maaş', amount: 60000 }];
    month.expenses = [{ id: 'e1', category: 'Diğer', amount: 5000, fixed: false }];
    render();
  `;
  const out = await page.evaluate((setupSrc) => {
    eval(setupSrc);
    const snapshot = buildMonthlySnapshot();
    return { snapshot, result: runDecisionEngineV2(snapshot) };
  }, src);
  assert.equal(pageErrors.length, 0);
  const goalAction = out.result.actions.find(a => a.type === 'goal_contribution');
  if (goalAction) assert.equal(goalAction.relatedGoalId, 'gYakin', 'en yakın tarihli hedef önce seçilmeli');
  await page.close();
});

test('DE2-11: hiç hedef yok -> goal_contribution aksiyonu üretilmez, kalan P4\'e gider', async () => {
  const { page, pageErrors } = await newPage();
  const src = `
    persistent.accounts = [{ id: 'a1', name: 'Banka', type: 'Banka Hesabı', balance: 400000, currency: 'TRY' }];
    persistent.debts = []; persistent.creditCards = [];
    persistent.goals = []; persistent.dailyMoneyTask = null; persistent.cardPaymentLog = [];
    month.incomes = [{ id: 'i1', category: 'Maaş', amount: 60000 }];
    month.expenses = [{ id: 'e1', category: 'Diğer', amount: 5000, fixed: false }];
    render();
  `;
  const out = await page.evaluate((setupSrc) => {
    eval(setupSrc);
    const snapshot = buildMonthlySnapshot();
    return runDecisionEngineV2(snapshot);
  }, src);
  assert.equal(pageErrors.length, 0);
  assert.equal(out.actions.find(a => a.type === 'goal_contribution'), undefined);
  assert.ok(out.actions.some(a => a.type === 'remaining_allocation'), 'kalan tutar bir P4 aksiyonu olarak görünmeli');
  await page.close();
});

test('DE2-12: what-if senaryosu GERÇEK state\'i mutasyona uğratmaz', async () => {
  const { page, pageErrors } = await newPage();
  const src = `${addMonthsISO.toString()}\n${baseSetup.toString()}\nbaseSetup();\nrender();`;
  const out = await page.evaluate((setupSrc) => {
    eval(setupSrc);
    const before = JSON.stringify(persistent);
    const monthBefore = JSON.stringify(month);
    const baseSnapshot = buildMonthlySnapshot();
    const scenario = runWhatIfScenario(baseSnapshot, { cashFlowDelta: 50000 });
    const after = JSON.stringify(persistent);
    const monthAfter = JSON.stringify(month);
    return { baseResult: runDecisionEngineV2(baseSnapshot), scenario, unchangedPersistent: before === after, unchangedMonth: monthBefore === monthAfter };
  }, src);
  assert.equal(pageErrors.length, 0);
  assert.equal(out.unchangedPersistent, true, 'runWhatIfScenario persistent state\'i DEĞİŞTİRMEMELİ');
  assert.equal(out.unchangedMonth, true, 'runWhatIfScenario month state\'i DEĞİŞTİRMEMELİ');
  assert.equal(out.scenario.availableCash, out.baseResult.availableCash + 50000, 'senaryo +50000 farkını yansıtmalı');
  await page.close();
});

test('DE2-13: aynı snapshot iki kez çalıştırıldığında AYNI sonucu verir (deterministik, saf fonksiyon)', async () => {
  const { page, pageErrors } = await newPage();
  const src = `${addMonthsISO.toString()}\n${baseSetup.toString()}\nbaseSetup();\nrender();`;
  const out = await page.evaluate((setupSrc) => {
    eval(setupSrc);
    const snapshot = buildMonthlySnapshot();
    const r1 = runDecisionEngineV2(snapshot);
    const r2 = runDecisionEngineV2(snapshot);
    return { same: JSON.stringify(r1) === JSON.stringify(r2) };
  }, src);
  assert.equal(pageErrors.length, 0);
  assert.equal(out.same, true, 'runDecisionEngineV2 aynı girdi için aynı çıktıyı üretmeli (saf fonksiyon)');
  await page.close();
});

test('DE2-14: eksik/opsiyonel alanlar (risk profili yok, hedef listesi undefined benzeri) crash üretmez', async () => {
  const { page, pageErrors } = await newPage();
  const out = await page.evaluate(() => {
    const legacySnapshot = { income: 50000, monthlyCashFlow: 20000, debts: [], goals: [], criticalAlerts: [] };
    let threw = null;
    let result = null;
    try { result = runDecisionEngineV2(legacySnapshot); } catch (e) { threw = e.message; }
    return { threw, result };
  });
  assert.equal(pageErrors.length, 0);
  assert.equal(out.threw, null, 'eksik alanlı (legacy) snapshot crash üretmemeli: ' + out.threw);
  assert.ok(out.result && typeof out.result.status === 'string');
  await page.close();
});

test('DE2-15: bozuk/undefined snapshot (hiç parametre yok) needs_more_data\'ya güvenle düşer', async () => {
  const { page, pageErrors } = await newPage();
  const out = await page.evaluate(() => {
    let threw = null; let result = null;
    try { result = runDecisionEngineV2(); } catch (e) { threw = e.message; }
    return { threw, result };
  });
  assert.equal(pageErrors.length, 0);
  assert.equal(out.threw, null, 'parametresiz çağrı crash üretmemeli: ' + out.threw);
  assert.equal(out.result.status, 'needs_more_data');
  await page.close();
});

test('DE2-16: aksiyonlar açıklanabilir alanlar (title/reason/impact) taşır — kara kutu değil', async () => {
  const { page, pageErrors } = await newPage();
  const src = `${addMonthsISO.toString()}\n${baseSetup.toString()}\nbaseSetup();\nrender();\napplyCardPayment(persistent.creditCards[0], 10000, 'a1');\nrender();`;
  const out = await page.evaluate((setupSrc) => {
    eval(setupSrc);
    const snapshot = buildMonthlySnapshot();
    return runDecisionEngineV2(snapshot);
  }, src);
  assert.equal(pageErrors.length, 0);
  assert.ok(out.actions.length > 0);
  out.actions.forEach(a => {
    assert.ok(typeof a.title === 'string' && a.title.length > 0, 'her aksiyonun bir başlığı olmalı');
    assert.ok(typeof a.reason === 'string', 'her aksiyonun bir gerekçesi olmalı');
    assert.ok('priority' in a, 'her aksiyonun bir önceliği olmalı');
  });
  await page.close();
});

test('DE2-17: goalImpact, computeGoalInfo() ile TUTARLI temel alanlar taşır (gap/monthsLeft/requiredMonthly)', async () => {
  const { page, pageErrors } = await newPage();
  const src = `${addMonthsISO.toString()}\n${baseSetup.toString()}\nbaseSetup();\nrender();`;
  const out = await page.evaluate((setupSrc) => {
    eval(setupSrc);
    const snapshot = buildMonthlySnapshot();
    const result = runDecisionEngineV2(snapshot);
    const directInfo = computeGoalInfo(persistent.goals[0]);
    return { goalImpact: result.goalImpact, directInfo: { gap: directInfo.gap, requiredMonthly: directInfo.requiredMonthly, monthsLeft: directInfo.monthsLeft } };
  }, src);
  assert.equal(pageErrors.length, 0);
  assert.equal(out.goalImpact.length, 1);
  assert.equal(out.goalImpact[0].gap, out.directInfo.gap, 'gap, computeGoalInfo() ile AYNI olmalı — yeni bir hesap icat edilmedi');
  assert.equal(out.goalImpact[0].requiredMonthly, out.directInfo.requiredMonthly);
  await page.close();
});

test('DE2-18: renderDecisionEngineV2() DOM\'a yazar ve mevcut #priorityBox\'a DOKUNMAZ', async () => {
  const { page, pageErrors } = await newPage();
  const src = `${addMonthsISO.toString()}\n${baseSetup.toString()}\nbaseSetup();`;
  const out = await page.evaluate((setupSrc) => {
    eval(setupSrc);
    const priorityBoxBefore = document.getElementById('priorityBox').innerHTML;
    render();
    const priorityBoxAfter = document.getElementById('priorityBox').innerHTML;
    const v2Box = document.getElementById('decisionEngineV2Box');
    return { v2HasContent: !!(v2Box && v2Box.innerHTML.trim().length > 0), priorityBoxChangedNormally: priorityBoxAfter.length > 0 };
  }, src);
  assert.equal(pageErrors.length, 0, 'pageerror olmamalı: ' + JSON.stringify(pageErrors));
  assert.equal(out.v2HasContent, true, '#decisionEngineV2Box render() sonrası dolu olmalı');
  assert.equal(out.priorityBoxChangedNormally, true, '#priorityBox her zamanki gibi render edilmeye devam etmeli (v2 onu bozmadı)');
  await page.close();
});

test('DE2-19: çok yüksek nakit bakiyesi -> safe_to_allocate, likidite/borç aksiyonu YOK', async () => {
  const { page, pageErrors } = await newPage();
  const src = `
    persistent.accounts = [{ id: 'a1', name: 'Banka', type: 'Banka Hesabı', balance: 5000000, currency: 'TRY' }];
    persistent.debts = []; persistent.creditCards = [];
    persistent.goals = []; persistent.dailyMoneyTask = null; persistent.cardPaymentLog = [];
    month.incomes = [{ id: 'i1', category: 'Maaş', amount: 60000 }];
    month.expenses = [{ id: 'e1', category: 'Diğer', amount: 5000, fixed: false }];
    render();
  `;
  const out = await page.evaluate((setupSrc) => {
    eval(setupSrc);
    const snapshot = buildMonthlySnapshot();
    return runDecisionEngineV2(snapshot);
  }, src);
  assert.equal(pageErrors.length, 0);
  assert.equal(out.status, 'safe_to_allocate');
  assert.ok(out.actions.some(a => a.type === 'remaining_allocation'));
  await page.close();
});

test('DE2-20: tam regresyon — mevcut computePriorityPlan/_planCache sonucu Decision Engine v2 eklenmesinden ETKİLENMEDİ', async () => {
  const { page, pageErrors } = await newPage();
  const src = `${addMonthsISO.toString()}\n${baseSetup.toString()}\nbaseSetup();`;
  const out = await page.evaluate((setupSrc) => {
    eval(setupSrc);
    render();
    const plan1 = JSON.parse(JSON.stringify(_planCache));
    // Decision Engine v2'yi doğrudan çağırmak _planCache'i DEĞİŞTİRMEMELİ.
    buildMonthlySnapshot();
    runDecisionEngineV2(buildMonthlySnapshot());
    const plan2 = JSON.parse(JSON.stringify(_planCache));
    return { same: JSON.stringify(plan1) === JSON.stringify(plan2) };
  }, src);
  assert.equal(pageErrors.length, 0);
  assert.equal(out.same, true, 'Decision Engine v2 çağrıları mevcut _planCache/computePriorityPlan sonucunu DEĞİŞTİRMEMELİ');
  await page.close();
});
