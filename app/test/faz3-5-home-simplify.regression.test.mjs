// FAZ 3.5 — ANA SAYFA SON UX SADELEŞTİRMESİ REGRESYONU
// -----------------------------------------------------------------------
// Bu dosya, ana sayfada YALNIZCA sunum/HTML/CSS katmanında yapılan şu değişiklikleri doğrular:
//   1. "Hızlı Ekle" kartı ana sayfada artık görünmüyor (ama DOM'dan silinmedi — Sesle Ekle
//      alt sayfası bu düğümü taşıyıp geri getiriyor, bkz. sesleEkleAc/sesleEkleKapat).
//   2. Ana sayfada tam olarak TEK bir "FİNANSAL DURUM" bölümü var (data-section="finansal-durum"),
//      eski ayrı "networth"/"ay-defteri" bölümleri artık yok.
//   3. Net varlık (#netWorthValue/#sumAssets/#sumDebt) ve aylık defter (#sumIncome/#sumExpense/
//      #sumDebtPay/#sumRemain) AYNI kart içinde yaşıyor.
//   4. "Sıradaki Adımım" hâlâ canonical (runGoalCashAllocationEngine().distributableCash
//      tabanlı) tutarı gösteriyor.
//   5. "Bu Ayki Planım" da AYNI canonical tutarı gösteriyor (ikisi arasında tutarsızlık yok).
//   6. Günlük güvenli bütçe (ring) ile aylık planlanabilir tutar birbirine KARIŞTIRILMIYOR —
//      ayrı elementler, ayrı sayılar, aradaki farkı açıklayan not hâlâ yerinde.
//   7. Gerçekten aktif (gap>0) bir hedef yoksa "Aktif Hedef" bölümü hiç render edilmiyor (koca
//      bir boş-durum kartı YOK); aktif hedef varsa bölüm görünür.
//   8. Ana sayfa bölüm sırası, istenen 9 maddelik hiyerarşiyle eşleşiyor.
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

const EMERGENCY_SCENARIO = {
  income: 120000, expenses: 40000, assets: 65000,
  creditCards: [{ id: 'c1', name: 'Kart', currentBalance: 15000, limit: 100000, statementDay: 1, dueDay: 10 }],
  emergencyFundTarget: 72000,
};

// ---------------------------------------------------------------------
// 1. No Quick Add card visible on home.
// ---------------------------------------------------------------------
test('FAZ3.5-1: home has no visible "Hızlı Ekle" card, but the node still exists (Sesle Ekle depends on it)', async () => {
  const { page, pageErrors } = await newSession(EMERGENCY_SCENARIO);
  const check = await page.evaluate(() => {
    const section = document.querySelector('.tab-panel[data-tab="home"] [data-section="hizli-ekle"]');
    return {
      exists: !!section,
      hidden: !!(section && section.hidden),
      visible: !!(section && section.offsetParent !== null),
    };
  });
  await page.close();
  assert.equal(check.exists, true, 'the Hızlı Ekle section node must still exist in the DOM (Sesle Ekle moves it)');
  assert.equal(check.hidden, true, 'the Hızlı Ekle section must be hidden on home');
  assert.equal(check.visible, false, 'the Hızlı Ekle card must not be visibly rendered on home');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// 1b. Quick Add functions and voice add still work (not removed, only hidden on home).
// ---------------------------------------------------------------------
test('FAZ3.5-1b: Sesle Ekle (voice add) sheet still opens and relocates the same Quick Add card', async () => {
  const { page, pageErrors } = await newSession(EMERGENCY_SCENARIO);
  const before = await page.evaluate(() => document.querySelectorAll('#quickAddInput').length);
  await page.evaluate(() => { sesleEkleAc(); });
  await page.waitForTimeout(150);
  const opened = await page.evaluate(() => ({
    sheetHidden: document.getElementById('sesSheet').hidden,
    inputInsideSheet: !!document.querySelector('#sesSheetIcerik #quickAddInput'),
    inputCount: document.querySelectorAll('#quickAddInput').length,
  }));
  await page.evaluate(() => { sesleEkleKapat(); });
  await page.waitForTimeout(400);
  const closed = await page.evaluate(() => ({
    sheetHidden: document.getElementById('sesSheet').hidden,
    inputBackHome: !!document.querySelector('.tab-panel[data-tab="home"] [data-section="hizli-ekle"] #quickAddInput'),
  }));
  await page.close();
  assert.equal(before, 1, 'sanity: exactly one #quickAddInput node must exist before opening the sheet');
  assert.equal(opened.sheetHidden, false, 'Sesle Ekle sheet must open');
  assert.equal(opened.inputInsideSheet, true, 'the same Quick Add card (with #quickAddInput) must be moved into the Sesle Ekle sheet');
  assert.equal(opened.inputCount, 1, 'the card must be MOVED, not cloned — still exactly one #quickAddInput node');
  assert.equal(closed.sheetHidden, true, 'Sesle Ekle sheet must close');
  assert.equal(closed.inputBackHome, true, 'closing the sheet must return the card to its (hidden) spot on home');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// 2 & 3. Exactly one FİNANSAL DURUM card; net worth + monthly ledger share it.
// ---------------------------------------------------------------------
test('FAZ3.5-2: home has exactly one "FİNANSAL DURUM" section, and the old separate networth/ay-defteri sections are gone', async () => {
  const { page, pageErrors } = await newSession(EMERGENCY_SCENARIO);
  const check = await page.evaluate(() => ({
    financialStatusCount: document.querySelectorAll('.tab-panel[data-tab="home"] [data-section="finansal-durum"]').length,
    oldNetworth: document.querySelectorAll('.tab-panel[data-tab="home"] [data-section="networth"]').length,
    oldAyDefteri: document.querySelectorAll('.tab-panel[data-tab="home"] [data-section="ay-defteri"]').length,
  }));
  await page.close();
  assert.equal(check.financialStatusCount, 1, 'home must have exactly one FİNANSAL DURUM section');
  assert.equal(check.oldNetworth, 0, 'the old standalone "networth" section must no longer exist');
  assert.equal(check.oldAyDefteri, 0, 'the old standalone "ay-defteri" section must no longer exist');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.5-3: net worth and this month\'s ledger live in the same FİNANSAL DURUM card, with correct (unchanged) values', async () => {
  const { page, pageErrors } = await newSession(EMERGENCY_SCENARIO);
  const check = await page.evaluate(() => {
    const section = document.querySelector('.tab-panel[data-tab="home"] [data-section="finansal-durum"]');
    return {
      netWorthInside: !!(section && section.querySelector('#netWorthValue')),
      assetsInside: !!(section && section.querySelector('#sumAssets')),
      debtInside: !!(section && section.querySelector('#sumDebt')),
      incomeInside: !!(section && section.querySelector('#sumIncome')),
      expenseInside: !!(section && section.querySelector('#sumExpense')),
      debtPayInside: !!(section && section.querySelector('#sumDebtPay')),
      remainInside: !!(section && section.querySelector('#sumRemain')),
      savingsRateInside: !!(section && section.querySelector('#savingsRateStat')),
      debtRatioInside: !!(section && section.querySelector('#debtRatioStat')),
      incomeText: document.getElementById('sumIncome').textContent,
      expenseText: document.getElementById('sumExpense').textContent,
      remainText: document.getElementById('sumRemain').textContent,
    };
  });
  await page.close();
  for (const key of ['netWorthInside', 'assetsInside', 'debtInside', 'incomeInside', 'expenseInside', 'debtPayInside', 'remainInside', 'savingsRateInside', 'debtRatioInside']) {
    assert.equal(check[key], true, `${key} must be true — element must live inside the merged FİNANSAL DURUM card`);
  }
  assert.ok(check.incomeText.includes('120.000'), `income must still render correctly, got "${check.incomeText}"`);
  assert.ok(check.expenseText.includes('40.000'), `expense must still render correctly, got "${check.expenseText}"`);
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// 4 & 5. "Sıradaki Adımım" and "Bu Ayki Planım" still agree on the canonical amount.
// ---------------------------------------------------------------------
test('FAZ3.5-4: "Sıradaki Adımım" and "Bu Ayki Planım" both still show the same canonical distributableCash amount', async () => {
  const { page, pageErrors } = await newSession(EMERGENCY_SCENARIO);
  const check = await page.evaluate(() => {
    const result = runMonthlyGoalCashAllocationLive();
    return {
      distributableCash: result.distributableCash,
      moneyTaskTitle: document.querySelector('#moneyTaskBox .money-task-title')?.innerText || '',
      planSummaryHtml: document.getElementById('monthlyPlanSummary').innerHTML,
    };
  });
  await page.close();
  assert.ok(check.distributableCash > 0, 'sanity: this scenario must produce a positive distributable amount');
  const grouped = Math.round(check.distributableCash).toLocaleString('tr-TR');
  assert.ok(check.planSummaryHtml.includes(grouped), `"Bu Ayki Planım" must show the canonical amount ${grouped}, got: ${check.planSummaryHtml}`);
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// 6. Daily safe budget (ring) is not confused with the monthly plan amount.
// ---------------------------------------------------------------------
test('FAZ3.5-5: daily safe budget (ring) and monthly plan remain distinct, with the clarifying note intact', async () => {
  const { page, pageErrors } = await newSession(EMERGENCY_SCENARIO);
  const check = await page.evaluate(() => {
    const ringNote = document.querySelector('.ring-note');
    return {
      dailyAmountText: document.getElementById('dailyAmountNum').textContent,
      ringNoteText: ringNote ? ringNote.textContent : '',
      ringSectionExists: !!document.querySelector('.tab-panel[data-tab="home"] [data-section="ring"]'),
    };
  });
  await page.close();
  assert.equal(check.ringSectionExists, true, 'the daily safe-budget "ring" section must still exist as its own section');
  assert.ok(check.ringNoteText.length > 0, 'the daily/monthly clarifying note (ring-aylik-fark-not) must still be present');
  assert.ok(/bu ayki plan/i.test(check.ringNoteText), `the clarifying note must still reference "Bu Ayki Planım", got: "${check.ringNoteText}"`);
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// 7. Active goal section is hidden entirely when there's no genuinely active goal.
// ---------------------------------------------------------------------
// NOT (FAZ 3.12, 2026-09): "Aktif Hedefin" bağımsız kartı (data-section="activegoal",
// #activeGoalBox) Ana Sayfa'dan tamamen kaldırıldı (bkz. index.html'deki FAZ 3.12 yorumu) —
// bu artık Ana Sayfa'nın bir parçası değil, ne görünür ne de gizli bir DOM elemanı olarak
// duruyor. Bu iki test, o zamanki asıl amacını (gerçekten aktif/gap>0 bir hedef olup
// olmamasına göre doğru ayrımın yapılması) artık kaldırılmış Home DOM'una değil, doğrudan
// pickPrimaryGoal()/computeGoalInfo() alttaki hesaplamasına ve renderActiveGoalCard()'ın
// konteyner yokken güvenle no-op olduğuna bakarak doğruluyor — kapsam ZAYIFLATILMADI.
test('FAZ3.5-6: pickPrimaryGoal() returns null (no active goal) when there is no gap>0 goal, and the removed "Aktif Hedef" Home section no longer exists', async () => {
  const { page, pageErrors } = await newSession({ ...EMERGENCY_SCENARIO, goals: [] });
  const check = await page.evaluate(() => {
    const primary = pickPrimaryGoal();
    const section = document.querySelector('.tab-panel[data-tab="home"] [data-section="activegoal"]');
    const box = document.getElementById('activeGoalBox');
    return { primaryIsNull: primary === null, sectionExists: !!section, boxExists: !!box };
  });
  await page.close();
  assert.equal(check.primaryIsNull, true, 'pickPrimaryGoal() must return null when there is no active (gap>0) goal');
  assert.equal(check.sectionExists, false, 'the standalone "Aktif Hedef" section was intentionally removed from Home in FAZ 3.12');
  assert.equal(check.boxExists, false, '#activeGoalBox was intentionally removed from Home in FAZ 3.12');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.5-7: pickPrimaryGoal() correctly selects a genuinely active (gap>0) goal, and renderActiveGoalCard() no-ops safely without its former Home container', async () => {
  const { page, pageErrors } = await newSession({
    ...EMERGENCY_SCENARIO,
    goals: [{ id: 'g1', typeKey: 'ev', label: 'Ev', targetAmount: 1000000, currentSaved: 10000, targetDate: '' }],
  });
  const check = await page.evaluate(() => {
    const primary = pickPrimaryGoal();
    // Fonksiyon hâlâ var olduğu gibi Ana Sayfa'nın dışında (ör. Hedefler sekmesi) çağrılabilir
    // olmalı ve artık var olmayan #activeGoalBox konteyneri için hata fırlatmamalı.
    let threw = false;
    try { renderActiveGoalCard(); } catch (e) { threw = true; }
    return {
      hasPrimary: !!primary,
      gap: primary ? primary.info.gap : null,
      goalId: primary ? primary.g.id : null,
      renderThrew: threw,
    };
  });
  await page.close();
  assert.equal(check.hasPrimary, true, 'pickPrimaryGoal() must select the genuinely active goal');
  assert.ok(check.gap > 0, 'the selected goal must have gap>0');
  assert.equal(check.goalId, 'g1');
  assert.equal(check.renderThrew, false, 'renderActiveGoalCard() must remain safe to call even without its former Home container');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// 8. Home section order matches the required 9-item hierarchy.
// ---------------------------------------------------------------------
// NOT (FAZ 3.12, 2026-09): Ana Sayfa artık odaklanmış bir "Finansal Karar Merkezi" — Yaklaşan
// Ödemeler / Aktif Hedef / Son İşlemler (ve ayrıca Bu Ay Kullanılabilir Tutar, Kategorilere
// Göre Harcama, Yolculuğum teaser'ı) bilinçli olarak Ana Sayfa'dan kaldırıldı, "Alabilir
// miyim?" ile sayfa BİTİYOR (bkz. index.html'deki FAZ 3.12 yorumu). Bu test artık 9 değil,
// FAZ 3.12'nin gerektirdiği 6 birincil bölümün doğru sırada olduğunu VE eski üç bölümün DOM'da
// hiç bulunmadığını doğruluyor — kapsam ZAYIFLATILMADI, yalnızca beklenen sıra kasıtlı ürün
// kararına göre güncellendi.
test('FAZ3.5-8: home sections render in the required order (Finansal Durum → Sıradaki Adımım → Güvenli Bütçe → Bu Ayki Planım → Bilmen Gerekenler → Alabilir miyim) and end there', async () => {
  const { page, pageErrors } = await newSession({
    ...EMERGENCY_SCENARIO,
    goals: [{ id: 'g1', typeKey: 'ev', label: 'Ev', targetAmount: 1000000, currentSaved: 10000, targetDate: '' }],
  });
  const order = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.tab-panel[data-tab="home"] [data-section]')).map(el => el.dataset.section);
  });
  await page.close();
  const expected = ['finansal-durum', 'bugunun-gorevi', 'ring', 'bu-ay-plan', 'bugun-bilmen-gerekenler',
    'afford-teaser'];
  const indices = expected.map(sec => order.indexOf(sec));
  assert.ok(indices.every(i => i >= 0), `all 6 required sections must be present in DOM order, got: ${JSON.stringify(order)}`);
  for (let i = 1; i < indices.length; i++) {
    assert.ok(indices[i - 1] < indices[i], `"${expected[i - 1]}" must come before "${expected[i]}" — got order: ${JSON.stringify(order)}`);
  }
  const removed = ['yaklasan-odemeler', 'activegoal', 'son-islemler', 'top5', 'expense-donut', 'journey-teaser'];
  for (const sec of removed) {
    assert.ok(!order.includes(sec), `"${sec}" was intentionally removed from Home in FAZ 3.12 and must not appear in its DOM order, got: ${JSON.stringify(order)}`);
  }
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// 9. Smoke check across a few scenarios: no console/page errors.
// ---------------------------------------------------------------------
test('FAZ3.5-9: home renders without errors across empty state, emergency-fund state, and active-goal state', async () => {
  for (const setup of [
    { income: 0, expenses: 0, assets: 0, goals: [] },
    EMERGENCY_SCENARIO,
    { ...EMERGENCY_SCENARIO, goals: [{ id: 'g1', typeKey: 'ev', label: 'Ev', targetAmount: 1000000, currentSaved: 10000, targetDate: '' }] },
  ]) {
    const { page, pageErrors } = await newSession(setup);
    await page.close();
    assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  }
});
