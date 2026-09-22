// FAZ 3.11 — KALICI (PERSIST EDİLMİŞ) GÖREVİN CANONICAL'A KARŞI BAYATLAMASI DÜZELTMESİ
// -----------------------------------------------------------------------
// KÖK NEDEN (özet — tam açıklama app/index.html'deki upgradeStalePersistedMoneyTask()'ın
// üstündeki FAZ 3.11 yorumunda): FAZ 3.10, pickTodaysStepReconciled()'ı (canonical öncelik
// sırasına göre doğru kategoriyi seçen mekanizma) yalnızca bir görev İLK KEZ kurulurken çağırıyordu
// (ensureTodaysMoneyTask'ın `!rec.task` dalı). Ama persistent.dailyMoneyTask GÜN İÇİNDE BİR KEZ
// kurulup persist edilir; sonraki HER render'da AYNI kayıt döndürülür ve `!rec.task` dalı bir daha
// hiç çalışmaz. Zaten var olan bir görev için yalnızca reconcilePersistedEmergencyTask() çalışıyordu
// — o da SADECE görevin KENDİ (değişmeyen) kategorisi için canonical satırı arar, yani TUTARI
// günceller ama KATEGORİYİ asla yeniden değerlendirmez. Sonuç: testler (FAZ 3.10) her zaman TAZE
// (`!rec.task`) bir durumdan başladığı için 237/237 geçiyordu, ama gerçek tarayıcıda ÖNCEDEN
// (ör. bu düzeltmeden önce, ya da acil fon ihtiyacı doğmadan önceki bir günde/render'da) 'yatirim'
// kategorisiyle kurulup persist edilmiş bir görev, canonical sonradan daha öncelikli bir tahsisat
// (ör. ₺60.000 acil fon) istemeye başlasa BİLE sonsuza dek eski kategoriyi göstermeye devam
// ediyordu — bu, YANLIŞ bir hesaplama değil, ZATEN KURULMUŞ bir görevin kimliğinin (kategorisinin)
// bir daha hiç yeniden değerlendirilmemesinden kaynaklanan bir YAŞAM DÖNGÜSÜ hatasıydı (kök neden:
// A/stale-persisted-state + C/yeni seçici yalnızca oluşturma anında çağrılıyor, sonraki render'larda
// ASLA).
//
// DÜZELTME: upgradeStalePersistedMoneyTask(), pickTodaysStepReconciled'ın ZATEN kullandığı AYNI
// canonicalAllocationRankOfStep/findHigherPriorityCanonicalStep mekanizmasını, artık HER render'da
// persist edilmiş 'pending' görev için de çalıştırır. YENİ BİR HESAP YOK, localStorage/kullanıcı
// verisi SİLİNMEZ — yalnızca sunum katmanındaki günün görevi, halihazırda var olan aynı
// reconciliation deseniyle (dismiss/complete'in zaten yaptığı gibi id/createdAt yenileyerek)
// güncellenir.
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
      month.expenses = [];
      if (s.essentialExpense > 0) month.expenses.push({ id: 'e1', category: 'Kira', amount: s.essentialExpense, fixed: true });
      const restExpense = (s.expenses || 0) - (s.essentialExpense || 0);
      if (restExpense > 0) month.expenses.push({ id: 'e2', category: 'Diğer', amount: restExpense, fixed: false });
      persistent.goals = s.goals || [];
      persistent.dailyMoneyTask = s.staleTask
        ? { date: new Date().toISOString().slice(0, 10), handledSignatures: [], task: s.staleTask }
        : null;
      setTab('home');
      render();
    }, setup);
  }
  return { page, pageErrors };
}

// Rapordaki BİREBİR senaryo: income 120000, expenses 40000, borç ödemesi 0, korunan likidite
// 12000 -> canonical dağıtılabilir 68000, acil fon tahsisatı 60000, kalan 8000.
const REPORTED_SCENARIO = { income: 120000, expenses: 40000, essentialExpense: 24000, assets: 0 };

const STALE_YATIRIM_TASK = {
  id: 'stale-task-id',
  title: 'Planlanabilir tutar',
  description: 'Bu ay daha fazla acil borç/likidite/hedef ihtiyacı yok. Yatırmak istersen bakabilirsin.',
  impact: 'Bu ay yaklaşık ₺8.000 tutar planlanabilir.',
  category: 'yatirim', priority: 'low', status: 'pending',
  createdAt: new Date(Date.now() - 3600000).toISOString(), completedAt: null,
  amount: 8000, ik: 'artis', signature: 'artis::Planlanabilir tutar',
};

test('FAZ3.11-1: an old persisted "Planlanabilir tutar" task (created before the emergency need existed, or before this fix) is upgraded to the canonical emergency allocation on the very next render — reproducing the exact reported browser bug', async () => {
  const { page, pageErrors } = await newSession({ ...REPORTED_SCENARIO, staleTask: STALE_YATIRIM_TASK });
  const check = await page.evaluate(() => {
    const canonical = runMonthlyGoalCashAllocationLive();
    const emergencyRow = canonical.allocations.find(a => a.type === 'emergency_fund_contribution' && a.amount > 1);
    return {
      distributableCash: canonical.distributableCash,
      canonicalEmergencyAmount: emergencyRow ? emergencyRow.amount : null,
      task: { ...persistent.dailyMoneyTask.task },
    };
  });
  await page.close();
  assert.equal(check.distributableCash, 68000, 'sanity: canonical distributable must be 68000 for this to reproduce the reported scenario');
  assert.equal(check.canonicalEmergencyAmount, 60000, 'sanity: canonical must still want a 60000 emergency allocation');
  assert.notEqual(check.task.id, 'stale-task-id', 'a genuinely different decision (category changed) must be reflected as a new task, the same way dismiss/complete already do');
  assert.equal(check.task.category, 'acil_fon', 'the stale flexible-remainder task must be upgraded to the canonical emergency allocation, not left showing the old category forever');
  assert.equal(check.task.amount, 60000);
  assert.notEqual(check.task.title, 'Planlanabilir tutar');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.11-2: once the correct top-priority task is showing, repeated renders (no user action) never regenerate its identity — no thrashing', async () => {
  const { page, pageErrors } = await newSession(REPORTED_SCENARIO);
  const check = await page.evaluate(() => {
    const idAfterCreate = persistent.dailyMoneyTask.task.id;
    render(); render(); render();
    const idAfterMultipleRenders = persistent.dailyMoneyTask.task.id;
    return { idAfterCreate, idAfterMultipleRenders, category: persistent.dailyMoneyTask.task.category, amount: persistent.dailyMoneyTask.task.amount };
  });
  await page.close();
  assert.equal(check.category, 'acil_fon');
  assert.equal(check.amount, 60000);
  assert.equal(check.idAfterCreate, check.idAfterMultipleRenders, 'repeated renders with no data change and no user action must not regenerate the task (its id must stay stable)');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.11-3: after a genuine dismissal correctly lands on the flexible remainder (nothing higher-priority left unhandled), further renders keep showing it stably — the upgrade never re-fights a deliberate user dismissal', async () => {
  const { page, pageErrors } = await newSession(REPORTED_SCENARIO);
  const check = await page.evaluate(() => {
    dismissMoneyTask(); // acil fon adımını kullanıcı bilerek atladı
    const idAfterDismiss = persistent.dailyMoneyTask.task.id;
    render(); render();
    const idAfterMoreRenders = persistent.dailyMoneyTask.task.id;
    return {
      idStable: idAfterDismiss === idAfterMoreRenders,
      task: { ...persistent.dailyMoneyTask.task },
    };
  });
  await page.close();
  assert.equal(check.task.category, 'yatirim');
  assert.equal(check.task.amount, 8000);
  assert.equal(check.idStable, true, 'a correctly-resolved lower-priority task (after deliberate dismissal) must not be regenerated on subsequent renders');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.11-4: a COMPLETED stale task is never touched by the upgrade — historical/finished decisions are frozen', async () => {
  const completedStaleTask = { ...STALE_YATIRIM_TASK, status: 'completed', completedAt: new Date().toISOString() };
  const { page, pageErrors } = await newSession({ ...REPORTED_SCENARIO, staleTask: completedStaleTask });
  const check = await page.evaluate(() => ({ ...persistent.dailyMoneyTask.task }));
  await page.close();
  assert.equal(check.id, 'stale-task-id', 'a completed task must never be replaced/upgraded, even if canonical now wants a different allocation');
  assert.equal(check.category, 'yatirim');
  assert.equal(check.amount, 8000);
  assert.equal(check.status, 'completed');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.11-5: a stale persisted task in a critical/non-canonical category (e.g. an expensive flexible-debt payoff) is never "upgraded" away — it keeps its priority exactly as before this fix', async () => {
  const staleCriticalTask = {
    id: 'stale-critical-id', title: 'Nakit Avans borcuna ekstra ödeme yap',
    description: 'Aylık faizi mevduat getirisinin üzerinde.', impact: 'irrelevant',
    category: 'borc', priority: 'critical', status: 'pending',
    createdAt: new Date(Date.now() - 3600000).toISOString(), completedAt: null,
    amount: 40000, ik: 'kritik', signature: 'kritik::Nakit Avans borcuna ekstra ödeme yap',
  };
  const { page, pageErrors } = await newSession({
    ...REPORTED_SCENARIO,
    debts: [{ id: 'd1', category: 'Nakit Avans', balance: 500000, currency: 'TRY', rate: 8, fixedSchedule: false }],
    staleTask: staleCriticalTask,
  });
  const check = await page.evaluate(() => ({ ...persistent.dailyMoneyTask.task }));
  await page.close();
  assert.equal(check.id, 'stale-critical-id', 'a critical/urgent task that canonical does not model must never be preempted by the upgrade mechanism');
  assert.equal(check.ik, 'kritik');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});
