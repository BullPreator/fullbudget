// AI COACH / PRIORITY PLAN / AFFORD CAPACITY - P0 & P1 audit regresyon testleri
// -----------------------------------------------------------------------
// Amaç: finans denetimi (2026-09-17) sırasında bulunan iki gerçek hatayı
// (P0: buildAICoachContext'in AYNI ay için ÇELİŞEN iki nakit akışı rakamı
// üretmesi; P1: "Gelirimi Artır" hedefinin computePriorityPlan tarafından
// yanlışlıkla bir tasarruf hedefi gibi işlenmesi) kalıcı olarak regresyona
// karşı korumak, ve tek-kaynak (single-source-of-truth) migrasyonunun
// (buildAICoachContext, getAffordCapacityInfo artık computeCashFlowSummary
// çağırıyor) bozulmadığını doğrulamak.
//
// Yöntem farkı (finance-core.test.mjs / state-normalization.test.mjs'e göre):
// buildAICoachContext/computePriorityPlan/getAffordCapacityInfo, FINANCE-CORE
// bloğundaki saf fonksiyonların aksine onlarca DOM'a ve global uygulama
// durumuna (persistent, month, render(), totalIncome(), computeGoalInfo(),
// allDebts(), MARKET_DATA, GOAL_TYPES, ...) bağımlıdır. Bunları node:vm
// içinde izole çalıştırmak, tüm bu bağımlılık grafiğini elle yeniden inşa
// etmeyi (yani mantığı fiilen kopyalamayı) gerektirirdi - tam da bu dosyanın
// amaçladığı "gerçek kaynaktan test" ilkesini bozar. Bunun yerine gerçek
// app/index.html dosyasını gerçek bir Chromium sayfasında (Playwright)
// çalıştırıp, tarayıcı içinde GERÇEK fonksiyonları çağırıyoruz. Test edilen
// kod yine %100 index.html'in kendisidir; elle kopyalanmış/çatallanmış bir
// mantık YOKTUR.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..', '..'); // repo kökü (app/ ve app/index.html'i içerir)

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

async function newSession() {
  const page = await browser.newPage({ viewport: { width: 430, height: 1600 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  // Onboarding/auth overlaylerini kapat (uygulamanın ilk açılış akışı).
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
  return { page, pageErrors };
}

async function scenario(sc) {
  const { page, pageErrors } = await newSession();
  const r = await page.evaluate((sc) => {
    persistent.accounts = sc.assets ? [{ id: 'a1', name: 'Banka', type: 'Banka Hesabı', balance: sc.assets, currency: 'TRY' }] : [];
    persistent.debts = sc.debt ? [{ id: 'd1', category: 'Diğer', balance: sc.debt, minPayment: sc.minPayment || 0, extraPayment: 0, rate: 0 }] : [];
    persistent.creditCards = [];
    month.incomes = sc.income > 0 ? [{ id: 'i1', category: 'Maaş', amount: sc.income }] : [];
    month.expenses = sc.expenses > 0 ? [{ id: 'e1', category: 'Diğer', amount: sc.expenses }] : [];
    persistent.goals = sc.goals || [];
    persistent.dailyMoneyTask = null;
    let renderErr = null;
    try { render(); } catch (e) { renderErr = e.message + ' :: ' + (e.stack || ''); }
    const coach = buildAICoachContext();
    const cap = getAffordCapacityInfo();
    const plan = _planCache ? _planCache.steps.map((s) => ({ ik: s.ik, label: s.label, amount: s.amount, goalId: s.goalId })) : null;
    const task = persistent.dailyMoneyTask && persistent.dailyMoneyTask.task;
    return {
      renderErr,
      coachFinancialSnapshot: coach.financialSnapshot,
      coachCurrentMonth: coach.currentMonth,
      capMonthlyCashFlow: cap.monthlyCashFlow,
      planSteps: plan,
      moneyTask: task ? { title: task.title, category: task.category, goalId: task.goalId, amount: task.amount } : null,
    };
  }, sc);
  await page.close();
  return { r, pageErrors };
}

// ------------------------------------------------------------------
// P0 - kullanıcının verdiği tam senaryo: income=50000, expenses=40000,
// debtPayments=30000 -> beklenen monthlyCashFlow=-20000, ve AI'a giden
// HER "bu ay kalan para" alanı bu değerle AYNI olmalı (currentMonth.balance
// dahil - eskiden borç ödemesini hiç düşmüyordu).
// ------------------------------------------------------------------
test('P0: income=50000, expenses=40000, debtPayments=30000 -> monthlyCashFlow=-20000 (AI context alanları çelişmiyor)', async () => {
  const { r, pageErrors } = await scenario({ income: 50000, expenses: 40000, debt: 1000000, minPayment: 30000 });
  assert.equal(r.renderErr, null, r.renderErr);
  assert.equal(r.coachFinancialSnapshot.monthlyCashFlow, -20000);
  assert.equal(r.coachCurrentMonth.balance, -20000, 'currentMonth.balance financialSnapshot.monthlyCashFlow ile ÇELİŞMEMELİ');
  assert.equal(r.coachCurrentMonth.balance, r.coachFinancialSnapshot.monthlyCashFlow);
  assert.equal(r.capMonthlyCashFlow, -20000, 'getAffordCapacityInfo de aynı canonical değeri vermeli (SSOT)');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('P0: income=100000, expenses=40000, debtPayments=10000 -> monthlyCashFlow=50000 (AI context alanları çelişmiyor)', async () => {
  const { r, pageErrors } = await scenario({ income: 100000, expenses: 40000, debt: 1000000, minPayment: 10000 });
  assert.equal(r.renderErr, null, r.renderErr);
  assert.equal(r.coachFinancialSnapshot.monthlyCashFlow, 50000);
  assert.equal(r.coachCurrentMonth.balance, 50000);
  assert.equal(r.coachCurrentMonth.balance, r.coachFinancialSnapshot.monthlyCashFlow);
  assert.equal(r.capMonthlyCashFlow, 50000);
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ------------------------------------------------------------------
// A-I kapsam matrisi (buildAICoachContext / computePriorityPlan / getAffordCapacityInfo)
// ------------------------------------------------------------------
test('A: income>expenses, borç ödemesi yok', async () => {
  const { r } = await scenario({ income: 80000, expenses: 30000, debt: 0 });
  assert.equal(r.coachFinancialSnapshot.monthlyCashFlow, 50000);
  assert.equal(r.coachCurrentMonth.balance, 50000);
  assert.equal(r.capMonthlyCashFlow, 50000);
});

test('B: income>expenses, borç ödemesi var', async () => {
  const { r } = await scenario({ income: 80000, expenses: 30000, debt: 500000, minPayment: 15000 });
  assert.equal(r.coachFinancialSnapshot.monthlyCashFlow, 35000);
  assert.equal(r.coachCurrentMonth.balance, 35000);
  assert.equal(r.capMonthlyCashFlow, 35000);
});

test('C: expenses>income', async () => {
  const { r } = await scenario({ income: 30000, expenses: 50000, debt: 0 });
  assert.equal(r.coachFinancialSnapshot.monthlyCashFlow, -20000);
  assert.equal(r.coachCurrentMonth.balance, -20000);
});

test('D: borç ödemesi income>expenses olsa da negatif nakit akışına sebep oluyor', async () => {
  const { r } = await scenario({ income: 40000, expenses: 30000, debt: 500000, minPayment: 20000 });
  assert.equal(r.coachFinancialSnapshot.monthlyCashFlow, -10000);
  assert.equal(r.coachCurrentMonth.balance, -10000);
});

test('E: sıfır gelir - render hatasız, tüm cash-flow alanları finite', async () => {
  const { r, pageErrors } = await scenario({ income: 0, expenses: 10000, debt: 0 });
  assert.equal(r.renderErr, null, r.renderErr);
  assert.ok(Number.isFinite(r.coachFinancialSnapshot.monthlyCashFlow));
  assert.ok(Number.isFinite(r.coachCurrentMonth.balance));
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ------------------------------------------------------------------
// P1 - "Gelirimi Artır" hedefi bir tasarruf hedefi DEĞİLDİR: computePriorityPlan
// bu hedef için "ayır" adımı ÜRETMEMELİ, ve Daily Money Task bu hedefe para
// ayırmayı önermemeli.
// ------------------------------------------------------------------
test('F: "Gelirimi Artır" hedefi savings-allocation adımı üretmiyor, Money Task tetiklemiyor', async () => {
  const { r, pageErrors } = await scenario({
    income: 60000, expenses: 30000, debt: 0,
    goals: [{ id: 'g_gelir', typeKey: 'gelirartir', name: 'Gelirimi Artır', targetAmount: 100000, createdAt: new Date().toISOString() }],
  });
  assert.equal(r.renderErr, null, r.renderErr);
  const hedefStep = r.planSteps ? r.planSteps.find((s) => s.ik === 'hedef') : undefined;
  assert.equal(hedefStep, undefined, `"Gelirimi Artır" için hedef adımı üretilmemeli, üretilen: ${JSON.stringify(hedefStep)}`);
  assert.ok(!r.moneyTask || r.moneyTask.goalId !== 'g_gelir', 'Money Task "Gelirimi Artır" hedefine para ayırmayı önermemeli');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('G: normal (diger tipi) bir hedef HÂLÂ allocation adımı üretiyor (P1 fix\'in yan etkisi yok)', async () => {
  const { r } = await scenario({
    income: 60000, expenses: 20000, debt: 0,
    goals: [{ id: 'g_normal', typeKey: 'diger', name: 'Araba', targetAmount: 200000, targetDate: new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10), createdAt: new Date().toISOString() }],
  });
  assert.equal(r.renderErr, null, r.renderErr);
  const hedefStep = r.planSteps ? r.planSteps.find((s) => s.ik === 'hedef') : undefined;
  assert.ok(hedefStep, 'Normal hedef için "hedef" adımı üretilmeliydi');
});

test('H: birden fazla hedef - "hedef" adımı SADECE normal hedefi seçiyor, "Gelirimi Artır"ı değil', async () => {
  const { r } = await scenario({
    income: 60000, expenses: 20000, debt: 0,
    goals: [
      { id: 'g_gelir2', typeKey: 'gelirartir', name: 'Gelirimi Artır', targetAmount: 150000, createdAt: new Date().toISOString() },
      { id: 'g_normal2', typeKey: 'diger', name: 'Tatil', targetAmount: 50000, targetDate: new Date(Date.now() + 180 * 86400000).toISOString().slice(0, 10), createdAt: new Date().toISOString() },
    ],
  });
  assert.equal(r.renderErr, null, r.renderErr);
  const hedefStep = r.planSteps ? r.planSteps.find((s) => s.ik === 'hedef') : undefined;
  assert.ok(hedefStep, 'Normal hedef için bir "hedef" adımı olmalıydı');
  assert.equal(hedefStep.goalId, 'g_normal2', '"hedef" adımı "Gelirimi Artır" hedefini DEĞİL, normal hedefi seçmeliydi');
});

test('I: AI context sayısal tutarlılık - 3 kaynak (financialSnapshot, currentMonth, getAffordCapacityInfo) hemfikir', async () => {
  const { r } = await scenario({ income: 120000, expenses: 55000, debt: 800000, minPayment: 25000 });
  const expected = 120000 - 55000 - 25000; // 40000
  assert.equal(r.coachFinancialSnapshot.monthlyCashFlow, expected);
  assert.equal(r.coachCurrentMonth.balance, expected);
  assert.equal(r.capMonthlyCashFlow, expected);
});

// ------------------------------------------------------------------
// Regresyon: Money Task + AI Coach entegrasyonunun gerçek (önceden var olan)
// bir senaryoda (M1 birleşme testinden alınan rakamlar) hâlâ doğru çalıştığını
// doğrular - P0/P1 fix'lerinin var olan davranışı bozmadığını gösterir.
// ------------------------------------------------------------------
test('regresyon: gerçek uygulama senaryosu (gelir=110000, gider=44067, borçsuz ödeme) hâlâ doğru', async () => {
  const { r, pageErrors } = await scenario({ income: 110000, expenses: 44067, debt: 243184, minPayment: 0, assets: 500000 });
  assert.equal(r.renderErr, null, r.renderErr);
  assert.equal(r.coachFinancialSnapshot.monthlyCashFlow, 65933);
  assert.equal(r.coachCurrentMonth.balance, 65933);
  assert.equal(r.capMonthlyCashFlow, 65933);
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});
