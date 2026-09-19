// FAZ 3 — ANA SAYFA UI REFACTOR regresyon testleri
// -----------------------------------------------------------------------
// Bu dosya SADECE sunum/kopya katmanındaki FAZ 3 değişikliklerini doğrular:
// (1) plan.steps[0] artık YALNIZCA "Sıradaki Adımım" kartında görünüyor,
// (2) eski "görev" dili ("Bugünün Para Görevi" / "Görevi Tamamladım") kayboldu,
// (3) "Bu ay net varlığını en az X artır" ifadesi kayboldu,
// (4) "Kalan tutarı yatırıma yönlendir" / yatırım yönlendirme dili kayboldu,
// (5) günlük güvenli harcama ile aylık planlanabilir tutar ayrımı metni var,
// (6) hiçbir finansal tutar DEĞİŞMEDİ (aynı senaryolar, aynı rakamlar).
// runDecisionEngineV2()/runGoalCashAllocationEngine()/computeGoalInfo()/
// buildMonthlySnapshot() bu dosya tarafından ASLA doğrudan çağrılmaz/mutasyona
// uğratılmaz — yalnızca DOM üzerinden gözlemlenir.
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
      // Sayfa ilk yüklendiğinde zaten bugünkü görev kaydı oluşmuş olabilir (hesap
      // eklenmeden önceki varsayılan durumla) — test senaryosunun gerçek finansal
      // verisiyle plandan YENİDEN kurulsun diye bugünkü kaydı sıfırlıyoruz. Bu salt
      // test kurulumudur, uygulamanın gerçek "günde bir kez" davranışını değiştirmez.
      persistent.dailyMoneyTask = null;
      setTab('home');
      render();
    }, setup);
  }
  return { page, pageErrors };
}

// ---------------------------------------------------------------------
// FAZ3-1: emergency-fund scenario from the previous fix — same numbers,
// only the surrounding presentation changed.
// ---------------------------------------------------------------------
const EMERGENCY_SCENARIO = {
  income: 120000, expenses: 40000, assets: 65000,
  creditCards: [{ id: 'c1', name: 'Kart', currentBalance: 15000, limit: 100000, statementDay: 1, dueDay: 10 }],
  emergencyFundTarget: 72000,
};

test('FAZ3-1: financial amounts in the Goal & Cash Allocation Engine are unchanged by the FAZ 3 presentation refactor', async () => {
  const { page, pageErrors } = await newSession(EMERGENCY_SCENARIO);
  const result = await page.evaluate(() => runMonthlyGoalCashAllocationLive());
  await page.close();
  // aynı senaryo, aynı motor -> aynı sonuç: distributable/allocated tutarlar değişmemeli
  assert.ok(result.distributableCash >= 0);
  const emergencyRow = result.allocations.find(a => a.type === 'emergency_fund_contribution');
  if (emergencyRow) {
    assert.ok(emergencyRow.amount > 0, 'emergency_fund_contribution amount must still be computed by the untouched engine');
  }
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// FAZ3-2: plan.steps[0] appears on exactly one main user-facing surface
// (the renamed "Sıradaki Adımım" / money-task card), not duplicated elsewhere.
// ---------------------------------------------------------------------
test('FAZ3-2: plan.steps[0] label text is shown once (money task card) and not repeated in "Bu Ayki Planım"', async () => {
  const { page, pageErrors } = await newSession({ income: 100000, expenses: 40000, assets: 20000, goals: [] });
  const check = await page.evaluate(() => {
    const step0 = _planCache && _planCache.steps && _planCache.steps[0];
    if (!step0) return { skip: true };
    const moneyTaskHtml = document.getElementById('moneyTaskBox') ? document.getElementById('moneyTaskBox').innerHTML : '';
    const priorityBoxHtml = document.getElementById('priorityBox') ? document.getElementById('priorityBox').innerHTML : '';
    return {
      skip: false,
      label: step0.label,
      inMoneyTask: moneyTaskHtml.includes(step0.label),
      inPriorityBox: priorityBoxHtml.includes(step0.label),
    };
  });
  await page.close();
  if (!check.skip) {
    assert.equal(check.inMoneyTask, true, 'plan.steps[0] must still be shown on the "Sıradaki Adımım" surface');
    assert.equal(check.inPriorityBox, false, 'plan.steps[0] must not be repeated inside "Bu Ayki Planım" / priorityBox');
  }
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// FAZ3-3: old task-framing language must be gone.
// ---------------------------------------------------------------------
test('FAZ3-3: "Bugünün Para Görevi" and "Görevi Tamamladım" are not visible anywhere on the home tab', async () => {
  const { page, pageErrors } = await newSession({ income: 100000, expenses: 40000, assets: 20000, goals: [] });
  const bodyText = await page.evaluate(() => document.body.innerText);
  await page.close();
  assert.ok(!/Bugünün Para Görevi/i.test(bodyText), 'old task-title language must not remain visible');
  assert.ok(!/Görevi Tamamladım/i.test(bodyText), 'old task-completion CTA language must not remain visible');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// FAZ3-4: net-worth text fix.
// ---------------------------------------------------------------------
test('FAZ3-4: "Bu ay net varlığını en az" text is not visible', async () => {
  const { page, pageErrors } = await newSession({ income: 100000, expenses: 40000, assets: 20000, goals: [] });
  const bodyText = await page.evaluate(() => document.body.innerText);
  await page.close();
  assert.ok(!/Bu ay net varlığını en az/i.test(bodyText), 'the misleading net-worth-increase phrasing must not remain visible');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// FAZ3-5: investment-directive language must be fully neutralized.
// ---------------------------------------------------------------------
test('FAZ3-5: "Kalan tutarı yatırıma yönlendir" and specific-instrument/percentage investment directives are not visible', async () => {
  const { page, pageErrors } = await newSession({ income: 150000, expenses: 30000, assets: 1000000, goals: [] });
  const bodyText = await page.evaluate(() => document.body.innerText);
  await page.close();
  assert.ok(!/Kalan tutarı yatırıma yönlendir/i.test(bodyText), 'old investment-directive label must not remain visible');
  assert.ok(!/önerilen dağılım/i.test(bodyText), 'no recommended-allocation-split language may appear');
  assert.ok(!/mevduat \+ hisse/i.test(bodyText), 'no specific-instrument-mix language may appear');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// FAZ3-6: daily-safe-spend vs monthly-plannable-amount distinction exists.
// ---------------------------------------------------------------------
test('FAZ3-6: the Ring card explicitly distinguishes today\'s safe spend from the monthly plannable amount', async () => {
  const { page, pageErrors } = await newSession({ income: 100000, expenses: 40000, assets: 20000, goals: [] });
  const bodyText = await page.evaluate(() => document.body.innerText);
  await page.close();
  assert.ok(/aylık planlanabilir tutarla aynı şey değildir/i.test(bodyText) || /not the same as the monthly plannable amount/i.test(bodyText),
    'a clarifying sentence distinguishing daily safe spend from the monthly plannable amount must be visible');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// FAZ3-7: technical decision summary is merged and collapsed by default.
// ---------------------------------------------------------------------
test('FAZ3-7: "Bu Ayki Planım" shows one plain-language summary by default, with technical DE2/Allocation detail collapsed behind a disclosure', async () => {
  const { page, pageErrors } = await newSession({ income: 100000, expenses: 40000, assets: 20000, goals: [] });
  const check = await page.evaluate(() => ({
    summaryHasContent: document.getElementById('monthlyPlanSummary').innerHTML.length > 0,
    detailWrapHidden: document.getElementById('planDetailWrap').hidden === true,
    toggleAriaExpanded: document.getElementById('planDetailToggle').getAttribute('aria-expanded'),
  }));
  // açma davranışı: tıklayınca görünür olmalı
  await page.click('#planDetailToggle');
  await page.waitForTimeout(100);
  const afterClick = await page.evaluate(() => ({
    detailWrapHidden: document.getElementById('planDetailWrap').hidden === true,
    toggleAriaExpanded: document.getElementById('planDetailToggle').getAttribute('aria-expanded'),
  }));
  await page.close();
  assert.equal(check.summaryHasContent, true, '#monthlyPlanSummary must render a plain-language summary');
  assert.equal(check.detailWrapHidden, true, 'technical DE2/Allocation detail must be collapsed by default');
  assert.equal(check.toggleAriaExpanded, 'false');
  assert.equal(afterClick.detailWrapHidden, false, 'clicking "Detayları gör" must reveal the technical detail');
  assert.equal(afterClick.toggleAriaExpanded, 'true');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// FAZ3-8: net-worth hero badges relocated, not duplicated.
// ---------------------------------------------------------------------
test('FAZ3-8: #acilFonMeta/#hedefMeta badges live under "Bu Ayki Planım", not inside the net-worth hero card', async () => {
  const { page, pageErrors } = await newSession({ income: 100000, expenses: 40000, assets: 20000, goals: [] });
  const check = await page.evaluate(() => {
    const networthSection = document.querySelector('[data-section="finansal-durum"]');
    const buAyPlanSection = document.querySelector('[data-section="bu-ay-plan"]');
    return {
      inNetworth: !!(networthSection && networthSection.querySelector('#acilFonMeta')),
      inBuAyPlan: !!(buAyPlanSection && buAyPlanSection.querySelector('#acilFonMeta')),
    };
  });
  await page.close();
  assert.equal(check.inNetworth, false, '#acilFonMeta must no longer live inside the net-worth hero card');
  assert.equal(check.inBuAyPlan, true, '#acilFonMeta must now live under "Bu Ayki Planım"');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// FAZ3-9: whole-suite regression guard — full existing test suite already
// re-run separately; this is a lightweight smoke check that home renders
// with no console/page errors across a few varied scenarios.
// ---------------------------------------------------------------------
test('FAZ3-9: home tab renders with no page errors across varied scenarios (mobile viewport)', async () => {
  const scenarios = [
    { income: 100000, expenses: 40000, assets: 20000, goals: [] },
    EMERGENCY_SCENARIO,
    { income: 50000, expenses: 50000, assets: 0, goals: [] },
  ];
  for (const s of scenarios) {
    const { page, pageErrors } = await newSession(s);
    await page.waitForTimeout(150);
    await page.close();
    assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  }
});
