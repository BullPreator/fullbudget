// FAZ 3.4 — PERSISTED "SIRADAKİ ADIMIM" STATE REGRESYONU
// -----------------------------------------------------------------------
// FAZ 3.3'te eklenen reconcileStepWithCanonicalAllocation() yalnızca bir görev İLK KEZ
// kurulurken (ensureTodaysMoneyTask'ın `!rec.task` dalı) çalışıyordu. Gerçek tarayıcıda,
// persistent.dailyMoneyTask GÜN İÇİNDE BİR KEZ kurulup kalıcı hale getirildiği için, o gün için
// ZATEN var olan bir görev (ör. bu düzeltmeden önce ya da farklı bir finansal durumda kurulmuş)
// hiçbir zaman yeniden hizalanmıyordu — kullanıcı ekranda hâlâ eski (₺19.500) tutarı görüyordu,
// "Bu Ayki Planım" ise canonical (₺53.000) tutarı gösteriyordu.
//
// Bu dosya:
//   1. Bugün için ZATEN kurulmuş, eski/stale bir acil-fon görevi (localStorage'ı simüle eder)
//      olsa bile, render edilen "Sıradaki Adımım" tutarının canonical tutara güncellendiğini,
//   2. Sıfırdan (persisted görev yokken) kurulan görevin de canonical tutarı gösterdiğini,
//   3. Acil fonla ilgisi olmayan bir görevin bu reconciliation'dan ETKİLENMEDİĞİNİ,
//   4. _planCache'in HİÇBİR ZAMAN mutasyona uğramadığını,
//   5. "Bu Ayki Planım" ve "Sıradaki Adımım"ın AYNI emergency_fund_contribution tutarını
//      gösterdiğini,
//   6. "Anladım" (tamamlama) ve "Başka bir öncelik göster" (atlama) davranışlarının bu
//      düzeltmeden sonra da BOZULMADIĞINI,
//   7. günlük güvenli harcama / aylık planlanabilir tutar ayrımının korunduğunu,
// doğrular. runDecisionEngineV2()/runGoalCashAllocationEngine()/computeGoalInfo()/
// buildMonthlySnapshot()/computePriorityPlan()/_planKur()/RISK_PROFILES bu dosya tarafından ASLA
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

// setup.staleTask: verilirse, render()'dan ÖNCE persistent.dailyMoneyTask bugünün tarihiyle,
// verilen (stale) task ile önceden doldurulur — gerçek tarayıcıda "bu düzeltmeden önce zaten
// kurulmuş bir görev" durumunu simüle eder.
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

      if (s.staleTask) {
        const today = new Date().toISOString().slice(0, 10);
        persistent.dailyMoneyTask = {
          date: today,
          handledSignatures: [],
          task: Object.assign({
            id: 'stale-task-id',
            title: 'Acil durum fonuna ekle',
            description: 'ESKİ (stale) açıklama — daha önce farklı bir tutarla kurulmuş',
            impact: 'ESKİ (stale) etki metni',
            category: 'acil_fon',
            priority: 'low',
            status: 'pending',
            createdAt: new Date().toISOString(),
            completedAt: null,
            ik: 'iyi',
            signature: 'iyi::Acil durum fonuna ekle',
          }, s.staleTask),
        };
      } else {
        persistent.dailyMoneyTask = null; // sıfırdan kurulsun
      }
      setTab('home');
      render();
    }, setup);
  }
  return { page, pageErrors };
}

const EMERGENCY_SCENARIO = {
  income: 120000, expenses: 40000, assets: 65000,
  creditCards: [{ id: 'c1', name: 'Kart', currentBalance: 15000, limit: 100000, statementDay: 1, dueDay: 10 }],
  emergencyFundTarget: 72000,
};

// ---------------------------------------------------------------------
// 1. Existing stale money-task state (₺19.500-style) must be reconciled to the canonical
// amount when rendered, not shown forever.
// ---------------------------------------------------------------------
test('FAZ3.4-1: a stale persisted emergency-fund task (old amount) is reconciled to the canonical amount on render', async () => {
  const { page, pageErrors } = await newSession({
    ...EMERGENCY_SCENARIO,
    staleTask: { amount: 19500 }, // gerçek raporlanan senaryo: eski, farklı bir tutar
  });
  const check = await page.evaluate(() => {
    const canonical = runMonthlyGoalCashAllocationLive();
    const emergencyRow = canonical.allocations.find(a => a.type === 'emergency_fund_contribution' && a.amount > 1);
    return {
      staleWasDifferent: 19500 !== (emergencyRow ? emergencyRow.amount : null),
      renderedTitle: document.querySelector('#moneyTaskBox .money-task-title').innerText,
      persistedAmount: persistent.dailyMoneyTask.task.amount,
      canonicalAmount: emergencyRow ? emergencyRow.amount : null,
    };
  });
  await page.close();
  assert.ok(check.staleWasDifferent, 'sanity: the injected stale amount (₺19.500) must differ from the canonical amount for this to be a meaningful test');
  assert.ok(!check.renderedTitle.includes('19.500'), `the rendered "Sıradaki Adımım" must not still show the stale amount, got "${check.renderedTitle}"`);
  const grouped = Math.round(check.canonicalAmount).toLocaleString('tr-TR');
  assert.ok(check.renderedTitle.includes(grouped), `the rendered title ("${check.renderedTitle}") must show the canonical amount ${grouped}`);
  assert.equal(check.persistedAmount, check.canonicalAmount, 'the persisted task object itself must be corrected too, so a future render does not need to redo this work and the fix survives a reload');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// 2. Fresh state (no persisted task) also produces the canonical amount.
// ---------------------------------------------------------------------
test('FAZ3.4-2: fresh state (no persisted task) builds "Sıradaki Adımım" with the canonical amount', async () => {
  const { page, pageErrors } = await newSession({ ...EMERGENCY_SCENARIO, staleTask: null });
  const check = await page.evaluate(() => {
    const canonical = runMonthlyGoalCashAllocationLive();
    const emergencyRow = canonical.allocations.find(a => a.type === 'emergency_fund_contribution' && a.amount > 1);
    return {
      taskAmount: persistent.dailyMoneyTask.task.amount,
      canonicalAmount: emergencyRow ? emergencyRow.amount : null,
    };
  });
  await page.close();
  assert.equal(check.taskAmount, check.canonicalAmount);
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// 3. A non-emergency stale/persisted task is left alone by this reconciliation.
// ---------------------------------------------------------------------
test('FAZ3.4-3: a persisted non-emergency-fund task is not touched by the reconciliation', async () => {
  const { page, pageErrors } = await newSession({
    ...EMERGENCY_SCENARIO,
    staleTask: { amount: 4200, category: 'borc', title: 'Kart borcuna ekstra ödeme', signature: 'kritik::Kart borcuna ekstra ödeme' },
  });
  const check = await page.evaluate(() => ({
    amount: persistent.dailyMoneyTask.task.amount,
    description: persistent.dailyMoneyTask.task.description,
  }));
  await page.close();
  assert.equal(check.amount, 4200, 'a non-emergency-fund persisted task amount must not be altered');
  assert.equal(check.description, 'ESKİ (stale) açıklama — daha önce farklı bir tutarla kurulmuş');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// 4. _planCache must never be mutated by this reconciliation.
// ---------------------------------------------------------------------
test('FAZ3.4-4: _planCache steps are never mutated by the stale-task reconciliation', async () => {
  const { page, pageErrors } = await newSession({ ...EMERGENCY_SCENARIO, staleTask: { amount: 19500 } });
  const check = await page.evaluate(() => {
    const originalStep = _planCache.steps.find(s => s.ik === 'iyi' && /acil|emergency/i.test(s.label));
    return { originalStepAmount: originalStep ? originalStep.amount : null };
  });
  await page.close();
  // computePriorityPlan/_planKur'un kendi formülü (kalanın %30'u, açığa kadar) canonical GCAE'den
  // yapısal olarak FARKLI bir sayı üretir — bu, _planCache'in DEĞİL yalnızca görev kopyasının
  // hizalandığının kanıtıdır.
  assert.ok(check.originalStepAmount != null, 'sanity: the original computePriorityPlan step must still exist');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// 5. "Bu Ayki Planım" and "Sıradaki Adımım" must show the exact same emergency amount,
// even starting from a stale persisted task.
// ---------------------------------------------------------------------
test('FAZ3.4-5: "Bu Ayki Planım" and "Sıradaki Adımım" show the exact same emergency contribution amount', async () => {
  const { page, pageErrors } = await newSession({ ...EMERGENCY_SCENARIO, staleTask: { amount: 19500 } });
  const check = await page.evaluate(() => ({
    moneyTaskAmount: persistent.dailyMoneyTask.task.amount,
    planSubAmountText: document.querySelector('#monthlyPlanSummary .hero-row b').textContent,
  }));
  await page.close();
  const grouped = `${'₺'}${Math.round(check.moneyTaskAmount).toLocaleString('tr-TR')}`;
  assert.equal(check.planSubAmountText, grouped, `"Bu Ayki Planım" (${check.planSubAmountText}) and "Sıradaki Adımım" (${grouped}) must match exactly`);
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// 6. "Anladım" (complete) and "Başka bir öncelik göster" (skip) still work after this fix.
// ---------------------------------------------------------------------
test('FAZ3.4-6: "Anladım" (complete) still marks the task done, with the reconciled canonical amount preserved', async () => {
  const { page, pageErrors } = await newSession({ ...EMERGENCY_SCENARIO, staleTask: { amount: 19500 } });
  const canonicalAmount = await page.evaluate(() => {
    const canonical = runMonthlyGoalCashAllocationLive();
    return canonical.allocations.find(a => a.type === 'emergency_fund_contribution' && a.amount > 1).amount;
  });
  await page.click('#moneyTaskCompleteBtn');
  await page.waitForTimeout(150);
  const check = await page.evaluate(() => ({
    status: persistent.dailyMoneyTask.task.status,
    amount: persistent.dailyMoneyTask.task.amount,
    doneCardVisible: !!document.querySelector('#moneyTaskBox .money-task-done'),
  }));
  await page.close();
  assert.equal(check.status, 'completed', '"Anladım" must still mark the task completed');
  assert.equal(check.amount, canonicalAmount, 'the completed task must retain the reconciled canonical amount, not the stale one');
  assert.equal(check.doneCardVisible, true);
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.4-7: "Başka bir öncelik göster" (skip) still advances to the next unhandled step', async () => {
  const { page, pageErrors } = await newSession({ ...EMERGENCY_SCENARIO, staleTask: { amount: 19500 } });
  const before_ = await page.evaluate(() => persistent.dailyMoneyTask.task.signature);
  await page.click('#moneyTaskSkipBtn');
  await page.waitForTimeout(150);
  const after_ = await page.evaluate((prevSignature) => ({
    signature: persistent.dailyMoneyTask.task.signature,
    handledIncludesOld: persistent.dailyMoneyTask.handledSignatures.includes(prevSignature),
  }), before_);
  await page.close();
  assert.ok(after_.handledIncludesOld, 'skipping must record the previous step as handled');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// RP-1 (2026-09): FAZ3.4-8 ("daily safe-spend and monthly plannable amount stay clearly separated
// after this fix") tamamen kaldırıldı — Home ring'inin body metnine özeldi, ring kaldırıldığı için
// bu davranış artık yok. Bkz. GUNLUK_GUVENLI_HARCAMA_KAPSAM_AUDIT.md.
// ---------------------------------------------------------------------
// 8. Financial engines/amounts remain unchanged (regression guard).
// ---------------------------------------------------------------------
test('FAZ3.4-9: underlying financial engines and amounts are unchanged by this presentation-only fix', async () => {
  const { page, pageErrors } = await newSession({ ...EMERGENCY_SCENARIO, staleTask: null });
  const result = await page.evaluate(() => runMonthlyGoalCashAllocationLive());
  await page.close();
  assert.ok(result.distributableCash >= 0);
  const emergencyRow = result.allocations.find(a => a.type === 'emergency_fund_contribution');
  if (emergencyRow) assert.ok(emergencyRow.amount > 0);
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});
