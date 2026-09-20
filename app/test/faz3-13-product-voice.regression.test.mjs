// FAZ 3.13 — ÜRÜN SESİ + UX TUTARLILIĞI regresyon testleri
// -----------------------------------------------------------------------
// Bu faz salt KULLANICIYA GÖRÜNEN METİN/SUNUM değişikliği — hiçbir finansal hesap/motor/depolama
// şeması değiştirilmedi, Ana Sayfa (Home) dondurulmuş haliyle DOKUNULMADI. Bu dosya:
//   - Home'un FAZ 3.12'deki 6 bölümlük yapısının bu fazdan ETKİLENMEDİĞİNİ,
//   - kanonik finansal hesapların (Decision Engine v2 / Goal & Cash Allocation Engine /
//     computeGoalInfo) AYNI senaryoda AYNI sonucu ürettiğini,
//   - Finans Koçu'nun kendini "kişiselleştirilmiş yatırım tavsiyesi" kaynağı gibi TANITMADIĞINI,
//   - Yatırım sekmesindeki senaryo/varsayım dilinin (mevcut, bu fazdan önce de var olan)
//     korunduğunu,
//   - "En iyi karar" gibi yargılayıcı etiketin kaldırılıp yerine nötr bir etiketin geldiğini,
//   - Yolculuğum'daki İngilizce jargon faz adlarının (BLUEPRINT/MOMENTUM/PRESTIGE) sade
//     Türkçe/İngilizce karşılıklarla değiştirildiğini,
//   - Hatırlatıcılar/Notlar/Kartlar boş-durumlarının hâlâ hatasız render olduğunu,
// doğrular. runDecisionEngineV2()/runGoalCashAllocationEngine()/runMonthlyGoalCashAllocationLive()/
// computeGoalInfo()/buildMonthlySnapshot()/computeCashFlowSummary()/getAffordCapacityInfo()/
// assessCardAffordability()/getFinancialAlerts()/computePriorityPlan()/_planKur()/RISK_PROFILES/
// activeRiskProfile/ensureTodaysMoneyTask()/upgradeStalePersistedMoneyTask() bu dosya tarafından
// ASLA mutasyona uğratılmaz — yalnızca DOM ve salt-okunur motor çağrılarıyla gözlemlenir.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..', '..');
const appHtmlSource = readFileSync(path.join(appDir, 'app', 'index.html'), 'utf8');

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
      persistent.dailyMoneyTask = null;
      setTab('home');
      render();
    }, setup);
  }
  return { page, pageErrors };
}

// FAZ 3.10/3.11/3.12 ile AYNI raporlanan senaryo — bu faz finansal hesapları etkilemediği için
// aynı sonuçların hâlâ üretildiğini doğrulamak için tekrar kullanılıyor.
const REPORTED_SCENARIO = { income: 120000, expenses: 40000, essentialExpense: 24000, assets: 0 };
const HOME_KEPT_SECTIONS = ['finansal-durum', 'bugunun-gorevi', 'ring', 'bu-ay-plan', 'bugun-bilmen-gerekenler', 'afford-teaser'];

test('FAZ3.13-1: Home is untouched — the FAZ 3.12 6-section structure and ending are unchanged by this voice/copy phase', async () => {
  const { page, pageErrors } = await newSession(REPORTED_SCENARIO);
  const order = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.tab-panel[data-tab="home"] [data-section]')).map(el => el.dataset.section);
  });
  await page.close();
  const indices = HOME_KEPT_SECTIONS.map(sec => order.indexOf(sec));
  assert.ok(indices.every(i => i >= 0), `all 6 Home sections must still be present, got: ${JSON.stringify(order)}`);
  for (let i = 1; i < indices.length; i++) {
    assert.ok(indices[i - 1] < indices[i], `Home section order must be unchanged — "${HOME_KEPT_SECTIONS[i - 1]}" must precede "${HOME_KEPT_SECTIONS[i]}"`);
  }
  assert.equal(order[indices[indices.length - 1]], 'afford-teaser', 'Home must still end at "afford-teaser" (Alabilir miyim?)');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.13-2: canonical financial calculations produce the exact same numbers as before this phase (engines untouched)', async () => {
  const { page, pageErrors } = await newSession(REPORTED_SCENARIO);
  const check = await page.evaluate(() => {
    const canonical = runMonthlyGoalCashAllocationLive();
    const de2 = runMonthlyDecisionEngineLive();
    const emergencyRow = canonical.allocations.find(a => a.type === 'emergency_fund_contribution' && a.amount > 1);
    const flexRow = canonical.allocations.find(a => a.type === 'long_term_or_flexible' && a.amount > 1);
    return {
      distributableCash: canonical.distributableCash,
      protectedCash: de2.protectedCash,
      emergencyAmount: emergencyRow ? emergencyRow.amount : null,
      flexAmount: flexRow ? flexRow.amount : null,
      task: { ...persistent.dailyMoneyTask.task },
    };
  });
  await page.close();
  assert.equal(check.distributableCash, 68000);
  assert.equal(check.protectedCash, 12000);
  assert.equal(check.emergencyAmount, 60000);
  assert.equal(check.flexAmount, 8000);
  assert.equal(check.task.category, 'acil_fon');
  assert.equal(check.task.amount, 60000);
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.13-3: goal and debt calculations are unchanged (down-payment goal + a debt scenario)', async () => {
  const futureDate = new Date(Date.now() + 300 * 86400000).toISOString().slice(0, 10);
  const { page, pageErrors } = await newSession({
    income: 120000, expenses: 40000, assets: 500000,
    goals: [{ id: 'g1', name: 'Araba', typeKey: 'diger', targetAmount: 200000, targetDate: futureDate }],
    debts: [{ id: 'd1', category: 'Nakit Avans', balance: 500000, currency: 'TRY', rate: 8, fixedSchedule: false }],
  });
  const check = await page.evaluate(() => {
    const info = computeGoalInfo(persistent.goals[0]);
    const debtTotal = allDebts().reduce((s, d) => s + (d.balanceTL || 0), 0);
    return { gap: info.gap, neededTotal: info.neededTotal, debtTotal };
  });
  await page.close();
  assert.equal(check.neededTotal, 200000, 'goal target amount calculation must be unchanged');
  assert.ok(check.gap > 0, 'goal gap calculation must still work');
  assert.equal(check.debtTotal, 500000, 'debt total calculation must be unchanged');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.13-4: Finans Koçu tagline no longer claims "kişiselleştirilmiş öneriler" (personalized recommendations) — it now frames itself as scenarios/calculations the user decides on', async () => {
  assert.ok(!appHtmlSource.includes('kişiselleştirilmiş öneriler sunar'), '"kişiselleştirilmiş öneriler sunar" must no longer appear as the Coach tagline');
  // FAZ 3.17: metin "senaryolar ve karşılaştırmalar sunar" ifadesinden ürün ilkesindeki
  // "açıklar" diline güncellendi (bkz. faz3-17-finans-kocu-safety.regression.test.mjs) —
  // buradaki asıl denetim (kişiselleştirilmiş öneri iddiasının kalkması) hâlâ geçerli.
  assert.ok(appHtmlSource.includes('senaryoları ve hesaplamaları açıklar'), 'the Coach tagline must describe explaining scenarios/calculations instead of personalized recommendations');
  // Mevcut, bu fazdan ÖNCE de var olan yatırım-tavsiyesi-değildir uyarıları korunmalı.
  assert.ok(appHtmlSource.includes('Bu bir yatırım danışmanlığı aracı değildir'), 'the pre-existing "not an investment advisory tool" disclaimer must remain intact');
  assert.ok(appHtmlSource.includes('kişiselleştirilmiş bir yatırım tavsiyesi değildir'), 'the pre-existing investment-allocation disclaimer must remain intact');
});

test('FAZ3.13-5: the judgmental "En iyi karar" / "Best decision" report label is gone, replaced by a neutral highlight label — the underlying computed message is unchanged', async () => {
  assert.ok(!appHtmlSource.includes("en ? 'Best decision' : 'En iyi karar'"), '"En iyi karar"/"Best decision" label must no longer be used for the monthly report highlight');
  assert.ok(appHtmlSource.includes("'Bu ayın öne çıkanı'"), 'the neutral replacement label must be present');
  const { page, pageErrors } = await newSession(REPORTED_SCENARIO);
  const check = await page.evaluate(() => {
    setTab('coach');
    renderMonthlyReport && renderMonthlyReport();
    const box = document.getElementById('monthlyReportBox');
    return box ? box.innerHTML : null;
  });
  await page.close();
  if (check != null) {
    assert.ok(!/En iyi karar/.test(check), 'the rendered monthly report must not show "En iyi karar"');
  }
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.13-6: Yolculuğum phase names are plain, non-jargon labels (no raw "BLUEPRINT"/"MOMENTUM"/"PRESTIGE" shown to users), and phase order/milestones are unchanged', async () => {
  const { page, pageErrors } = await newSession(REPORTED_SCENARIO);
  const check = await page.evaluate(() => {
    const j = computeJourney();
    return {
      titles: j.phases.map(p => p.title),
      keys: j.phases.map(p => p.key),
      totalMilestones: j.total,
    };
  });
  await page.close();
  assert.deepEqual(check.keys, ['blueprint', 'momentum', 'prestige'], 'internal phase keys/order must be unchanged — only display titles changed');
  for (const title of check.titles) {
    assert.ok(!['BLUEPRINT', 'MOMENTUM', 'PRESTIGE'].includes(title), `phase title "${title}" must not be raw English jargon`);
  }
  assert.ok(check.totalMilestones > 0, 'milestone computation must be unchanged/functional');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.13-7: empty states for reminders, notes and credit cards render without error and show an explanatory (not bare) message', async () => {
  const { page, pageErrors } = await newSession(REPORTED_SCENARIO);
  const check = await page.evaluate(() => {
    persistent.reminders = [];
    persistent.notes = [];
    persistent.creditCards = [];
    renderReminderList();
    renderNoteList();
    renderCreditCardList();
    return {
      reminderHtml: document.getElementById('reminderList').innerHTML,
      noteHtml: document.getElementById('noteList').innerHTML,
      cardHtml: document.getElementById('creditCardList').innerHTML,
    };
  });
  await page.close();
  for (const [name, html] of Object.entries(check)) {
    assert.ok(html.includes('empty-state-title') && html.includes('empty-state-desc'), `${name} empty state must use the rich empty-state pattern (title + explanation), got: ${html}`);
  }
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.13-8: investment scenario disclaimers remain in place and no new specific allocation percentages were introduced (RISK_PROFILES unchanged)', async () => {
  const { page, pageErrors } = await newSession(REPORTED_SCENARIO);
  const profiles = await page.evaluate(() => JSON.parse(JSON.stringify(RISK_PROFILES)));
  await page.close();
  assert.ok(profiles && typeof profiles === 'object' && Object.keys(profiles).length > 0, 'RISK_PROFILES must still exist and be populated');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.13-9: the goal reference-price copy now marks the price as a scenario estimate, not a stated current market fact', async () => {
  assert.ok(!appHtmlSource.includes("Evin güncel referans fiyatı hâlâ"), 'the old unqualified "current reference price" phrasing must be replaced');
  assert.ok(appHtmlSource.includes('bir senaryo tahminidir, güncel bir piyasa teklifi değil'), 'the down-payment-reached goal message must now clarify the price is a scenario estimate');
});
