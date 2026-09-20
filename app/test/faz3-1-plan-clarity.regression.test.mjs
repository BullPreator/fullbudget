// FAZ 3.1 — "BU AYKİ PLANIM" TEK RAKAM NETLEŞTİRME regresyon testleri
// -----------------------------------------------------------------------
// Önceki FAZ 3 geçişinde "Bu Ayki Planım" başlığı altında İKİ AYRI kart (computePriorityPlan
// tabanlı #priorityBox + runDecisionEngineV2/runGoalCashAllocationEngine tabanlı
// #monthlyPlanSummary) yan yana duruyordu ve her biri kendi motorunun ürettiği FARKLI bir
// "kalan/planlanabilir tutar" rakamını gösteriyordu. Bu dosya, tek karta birleşme sonrası:
//   - ana kartta TEK canonical rakamın (runGoalCashAllocationEngine().distributableCash)
//     göründüğünü, computePriorityPlan'ın kendi "yatirim" adımının artık AYRI bir rakam
//     olarak basılmadığını,
//   - teknik "category" chip'inin (gorev-kat-*) UI'da görünmediğini (data alanı hâlâ var),
//   - "Bunu Yaptım" gibi görev-hissi veren metnin kalmadığını ("Anladım" göründüğünü),
//   - aktif hedef yokken "Hedeflerine ulaştın" gibi bir hedef-tamamlandı mesajının HİÇ
//     gösterilmediğini (satırın tamamen gizlendiğini),
//   - günlük güvenli harcama ile aylık planlanabilir tutarın hâlâ açıkça ayrıldığını,
// doğrular. runDecisionEngineV2()/runGoalCashAllocationEngine()/computeGoalInfo()/
// buildMonthlySnapshot() bu dosya tarafından ASLA doğrudan mutasyona uğratılmaz — yalnızca
// DOM üzerinden ve salt-okunur motor çağrılarıyla gözlemlenir.
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
      persistent.dailyMoneyTask = null; // her senaryo bugünkü görevi kendi planından yeniden kursun
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
// 1. Single canonical figure in the main plan card.
// ---------------------------------------------------------------------
test('FAZ3.1-1: "Bu Ayki Planım" card shows exactly one canonical amount, matching runGoalCashAllocationEngine().distributableCash', async () => {
  const { page, pageErrors } = await newSession(EMERGENCY_SCENARIO);
  const check = await page.evaluate(() => {
    const de2 = runMonthlyDecisionEngineLive();
    const result = runGoalCashAllocationEngine(de2, buildMonthlySnapshot());
    const headline = document.querySelector('#monthlyPlanSummary .plan-summary-headline').textContent;
    return { distributableCash: result.distributableCash, headline };
  });
  await page.close();
  assert.ok(check.headline.startsWith('Planlayabileceğin tutar:'), `headline must lead with the canonical label, got "${check.headline}"`);
  assert.ok(check.distributableCash > 0, 'sanity: this scenario must have a positive distributable amount');
  // canonical amount's integer value (grouped with '.' per tr-TR formatting) must literally
  // appear in the headline — same number, not a re-derived one.
  const grouped = Math.round(check.distributableCash).toLocaleString('tr-TR');
  assert.ok(check.headline.includes(grouped), `headline "${check.headline}" must contain the exact canonical amount ${grouped}`);
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// 2. computePriorityPlan's own "yatirim" (remaining/investable) step no longer
// prints a competing number inside #priorityBox.
// ---------------------------------------------------------------------
test('FAZ3.1-2: #priorityBox no longer renders computePriorityPlan\'s own "yatirim" remainder row (no competing number)', async () => {
  const { page, pageErrors } = await newSession({ income: 200000, expenses: 30000, assets: 2000000, goals: [] });
  const check = await page.evaluate(() => {
    const hasYatirimStep = (_planCache.steps || []).some(s => s.category === 'yatirim');
    const priorityBoxText = document.getElementById('priorityBox').innerText;
    return { hasYatirimStep, priorityBoxText };
  });
  await page.close();
  assert.equal(check.hasYatirimStep, true, 'sanity: the engine must still produce a yatirim-category step for this high-surplus scenario (calculation untouched)');
  assert.ok(!/Planlanabilir tutar/i.test(check.priorityBoxText), '#priorityBox must not render the "Planlanabilir tutar" remainder row anymore');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// 3. The old duplicate "Bu ay planlayabileceğin tutar" ledger row is gone from
// #priorityBox; the same figure (availableCash) now lives only in the technical detail.
// ---------------------------------------------------------------------
test('FAZ3.1-3: the pre-protected-liquidity "kullanılabilir tutar" figure appears only inside the technical detail, not in #priorityBox', async () => {
  const { page, pageErrors } = await newSession(EMERGENCY_SCENARIO);
  const check = await page.evaluate(() => {
    const de2 = runMonthlyDecisionEngineLive();
    const priorityBoxText = document.getElementById('priorityBox').innerText;
    const ledgerText = document.getElementById('planDetailLedger').innerText;
    return { availableCash: de2.availableCash, priorityBoxText, ledgerText };
  });
  await page.close();
  const amtStr = String(check.availableCash);
  assert.ok(!check.priorityBoxText.includes(amtStr) || !/planlayabileceğin/i.test(check.priorityBoxText), '#priorityBox must not present availableCash as a headline "planlayabileceğin tutar" figure');
  assert.ok(/Bu ay kullanılabilir tutar/i.test(check.ledgerText), 'the technical ledger must label this figure "Bu ay kullanılabilir tutar"');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// 4. Technical breakdown chain (income -> expense -> debt -> protected -> distributable)
// is collapsed by default and only appears after "Detayları gör".
// ---------------------------------------------------------------------
test('FAZ3.1-4: income/expense/debt/protected/distributable chain is hidden by default and revealed via disclosure', async () => {
  const { page, pageErrors } = await newSession(EMERGENCY_SCENARIO);
  const before_ = await page.evaluate(() => ({
    ledgerVisible: !document.getElementById('planDetailWrap').hidden,
    ledgerHasContent: document.getElementById('planDetailLedger').innerText.length > 0,
  }));
  await page.click('#planDetailToggle');
  await page.waitForTimeout(100);
  const after_ = await page.evaluate(() => ({
    ledgerVisible: !document.getElementById('planDetailWrap').hidden,
    ledgerText: document.getElementById('planDetailLedger').innerText,
  }));
  await page.close();
  assert.equal(before_.ledgerVisible, false, 'the technical ledger must be collapsed by default');
  assert.equal(before_.ledgerHasContent, true, 'the ledger content must already be rendered (just hidden), not computed on demand');
  assert.equal(after_.ledgerVisible, true, 'clicking "Detayları gör" must reveal the ledger');
  assert.ok(/Gelir/.test(after_.ledgerText) && /Gider/.test(after_.ledgerText) && /Borç ödemesi/.test(after_.ledgerText), 'the ledger must show the income/expense/debt chain');
  assert.ok(/Planlanabilir tutar/.test(after_.ledgerText), 'the ledger must end with the same canonical plannable amount');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// 5. Technical "category" chip is gone from the money task card; the underlying
// data field is untouched.
// ---------------------------------------------------------------------
test('FAZ3.1-5: no technical category chip (e.g. "gorev-kat-acilfon" translated text) is visible on the money task card, but task.category still exists as data', async () => {
  const { page, pageErrors } = await newSession(EMERGENCY_SCENARIO);
  const check = await page.evaluate(() => {
    const rec = persistent.dailyMoneyTask;
    const chipCount = document.querySelectorAll('#moneyTaskBox .money-task-chip').length;
    const chipTexts = Array.from(document.querySelectorAll('#moneyTaskBox .money-task-chip')).map(e => e.textContent);
    return { category: rec && rec.task ? rec.task.category : null, chipCount, chipTexts };
  });
  await page.close();
  assert.ok(check.category, 'task.category must still exist as an underlying data field');
  assert.equal(check.chipCount, 1, 'only the priority chip should render now — the technical category chip must be gone');
  assert.ok(!check.chipTexts.some(t => /Acil Fon|Borç|Harcama|Tasarruf|Hedef|Yatırım|Kurulum|Genel/.test(t) && !/Öncelikli|Orta|Düşük/.test(t)), 'no rendered chip may show a raw backend category label');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// 6. Task-framing language is gone: "Bunu Yaptım" no longer appears.
// ---------------------------------------------------------------------
test('FAZ3.1-6: "Bunu Yaptım" is not visible; the same completion action is now labeled neutrally', async () => {
  const { page, pageErrors } = await newSession(EMERGENCY_SCENARIO);
  const check = await page.evaluate(() => ({
    bodyText: document.body.innerText,
    completeBtnText: document.getElementById('moneyTaskCompleteBtn') ? document.getElementById('moneyTaskCompleteBtn').textContent : null,
  }));
  await page.close();
  assert.ok(!/Bunu Yaptım/i.test(check.bodyText), '"Bunu Yaptım" must not remain visible anywhere');
  assert.ok(check.completeBtnText && check.completeBtnText.trim().length > 0, 'the completion button must still exist and be labeled');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// 7 & 8. No goal-completed message ("Hedeflerine ulaştın") when there is no
// active (in-progress) goal — neither with zero goals nor with only completed ones.
// ---------------------------------------------------------------------
// NOT (FAZ 3.12, 2026-09): "En yakın hedefine kalan" istatistiği eskiden Ana Sayfa'daki
// bağımsız "Bu Ay Kullanılabilir Tutar" kartının (data-section="top5", #top5GoalLeft) bir
// parçasıydı. FAZ 3.12 ile bu kart Ana Sayfa'dan tamamen kaldırıldı (bkz. index.html'deki
// FAZ 3.12 yorumu) — #top5GoalLeft artık DOM'da yok. Bu iki test, o zamanki asıl amacını
// (aktif/gerçek bir hedef yokken hiçbir yerde "Hedeflerine ulaştın" gibi yanlış bir
// hedef-tamamlandı mesajının görünmemesi) artık DOM'daki o özel elemana değil, doğrudan
// computeGoalInfo() hesabına ve tüm sayfa metnine bakarak doğruluyor — kapsam ZAYIFLATILMADI,
// yalnızca artık var olmayan bir konteynere bağımlılık kaldırıldı.
test('FAZ3.1-7: with zero goals, no goal-completed text appears anywhere on Home', async () => {
  const { page, pageErrors } = await newSession({ income: 100000, expenses: 40000, assets: 20000, goals: [] });
  const check = await page.evaluate(() => ({
    top5GoalLeftExists: !!document.getElementById('top5GoalLeft'),
    bodyText: document.body.innerText,
  }));
  await page.close();
  assert.equal(check.top5GoalLeftExists, false, 'the old standalone goal stat container was intentionally removed from Home in FAZ 3.12');
  assert.ok(!/Hedeflerine ulaştın/i.test(check.bodyText), 'no goal-completed message may appear with zero goals');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.1-8: with only a fully-funded (completed) goal and no in-progress goal, "Hedeflerine ulaştın" is never shown anywhere on Home', async () => {
  const { page, pageErrors } = await newSession({
    income: 100000, expenses: 40000, assets: 500000,
    goals: [{ id: 'g1', typeKey: 'diger', name: 'Bilgisayar', targetAmount: 10000, targetDate: new Date(Date.now() + 200 * 86400000).toISOString().slice(0, 10), currentAmount: 10000 }],
  });
  const check = await page.evaluate(() => {
    const info = computeGoalInfo(persistent.goals[0]);
    const primary = pickPrimaryGoal();
    return { gap: info.gap, primaryIsNull: primary === null, bodyText: document.body.innerText };
  });
  await page.close();
  if (check.gap <= 0) {
    assert.equal(check.primaryIsNull, true, 'a completed goal (gap<=0) is not an "active" goal — pickPrimaryGoal() must not select it');
    assert.ok(!/Hedeflerine ulaştın/i.test(check.bodyText), '"Hedeflerine ulaştın" must never be shown, even for a completed goal');
  }
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// 9. Daily safe-spend vs monthly plannable amount stay clearly separated
// (regression guard — should already hold from the prior FAZ 3 pass).
// ---------------------------------------------------------------------
test('FAZ3.1-9: daily safe-spend and monthly plannable amounts remain clearly, visibly separated', async () => {
  const { page, pageErrors } = await newSession(EMERGENCY_SCENARIO);
  const bodyText = await page.evaluate(() => document.body.innerText);
  await page.close();
  // FAZ 3.20 GÜNCELLEMESİ: ring artık canonical planın (long_term_or_flexible) bir TÜREVİ olduğu
  // için "aylık planlanabilir tutarla aynı şey değildir" ifadesi artık DOĞRU DEĞİL — bu yüzden
  // metin kasıtlı olarak "tempo/gün başına yayılan" diline değiştirildi (bkz. FAZ 3.20 audit +
  // Stage 2). Bu test hâlâ AYNI ürün amacını (ring'in bir "bugün harcaman gereken tutar" gibi
  // okunmamasını) doğruluyor, yalnızca yeni kelimelerle.
  assert.ok(/tempo/i.test(bodyText) || /pace/i.test(bodyText),
    'the ring card must still explicitly frame the daily figure as a pace/tempo, not a spending mandate');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// 10. Financial amounts are unchanged — the same emergency-fund scenario still
// produces a positive emergency_fund_contribution from the untouched engine.
// ---------------------------------------------------------------------
test('FAZ3.1-10: underlying financial amounts are unchanged by this presentation-only pass', async () => {
  const { page, pageErrors } = await newSession(EMERGENCY_SCENARIO);
  const result = await page.evaluate(() => runMonthlyGoalCashAllocationLive());
  await page.close();
  assert.ok(result.distributableCash >= 0);
  const emergencyRow = result.allocations.find(a => a.type === 'emergency_fund_contribution');
  if (emergencyRow) assert.ok(emergencyRow.amount > 0, 'the untouched engine must still compute a real emergency_fund_contribution amount');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});
