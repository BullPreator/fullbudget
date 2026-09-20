// FAZ 3.15 — HOME DESKTOP RESPONSIVE WIDTH FIX regresyon testleri
// -----------------------------------------------------------------------
// Bu faz SALT bir prezantasyon/genişlik düzeltmesi: masaüstünde (>=860px) Ana Sayfa
// (Home) içeriği artık .wrap'ın global 520px sınırı yerine 800px'e kadar genişleyen bir
// sütunda gösteriliyor — YALNIZCA Ana Sayfa aktifken ve YALNIZCA masaüstü media query'si
// içinde (`.wrap:has(> .tab-panel[data-tab="home"].active)`). Mobilde (<860px) davranış
// değişmedi; diğer sekmeler (Gelir/Harcama/Varlıklar/Borçlar/Hedefler/Yolculuğum/
// Araçlar/Yatırım/Finans Koçu/Alabilir miyim?/Hatırlatıcılar/Notlar/Ayarlar) .wrap'ın
// 520px sınırını masaüstünde de aynen korur. Home'un bilgi mimarisi (6 sabit bölüm,
// sırası, kopyası) ve hiçbir finansal motor/hesap/karar mantığı DEĞİŞMEDİ — bu dosya
// yalnızca DOM/CSS gözlemi ve salt-okunur motor çağrılarıyla doğrulama yapar.
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

async function newSession(viewport, setup) {
  const page = await browser.newPage({ viewport });
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
      month.incomes = s.income > 0 ? [{ id: 'i1', category: 'Maaş', amount: s.income }] : [];
      month.expenses = s.expenseRows || [];
      persistent.goals = s.goals || [];
      persistent.dailyMoneyTask = null;
      setTab(s.tab || 'home');
      render();
    }, setup);
  }
  return { page, pageErrors };
}

const SCENARIO = { income: 120000, expenses: 40000, assets: 50000 };
const HOME_KEPT_SECTIONS = ['finansal-durum', 'bugunun-gorevi', 'ring', 'bu-ay-plan', 'bugun-bilmen-gerekenler', 'afford-teaser'];

test('FAZ3.15-1: Home information architecture remains unchanged (still the frozen 6-section structure, in order)', async () => {
  const { page, pageErrors } = await newSession({ width: 1440, height: 1000 }, { ...SCENARIO, tab: 'home' });
  const order = await page.evaluate(() => Array.from(
    document.querySelectorAll('.tab-panel[data-tab="home"] [data-section]')
  ).map(el => el.dataset.section));
  await page.close();
  const indices = HOME_KEPT_SECTIONS.map(sec => order.indexOf(sec));
  assert.ok(indices.every(i => i >= 0), `all 6 Home sections must still be present, got: ${JSON.stringify(order)}`);
  for (let i = 1; i < indices.length; i++) {
    assert.ok(indices[i - 1] < indices[i], 'Home section order must be unchanged');
  }
  assert.equal(order[indices[indices.length - 1]], 'afford-teaser', 'Home must still end at "afford-teaser" (Alabilir miyim?)');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.15-2: mobile Home remains within its existing responsive constraint (.wrap stays at the pre-existing 520px cap below the 860px breakpoint)', async () => {
  const { page, pageErrors } = await newSession({ width: 390, height: 844 }, { ...SCENARIO, tab: 'home' });
  const wrapMaxWidth = await page.evaluate(() => getComputedStyle(document.querySelector('.wrap')).maxWidth);
  await page.close();
  assert.equal(wrapMaxWidth, '520px', 'below the desktop breakpoint, Home\'s .wrap must keep the original 520px cap unchanged');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.15-3: desktop Home receives the wider content constraint (.wrap widens to 800px when Home is the active tab at >=860px)', async () => {
  const { page, pageErrors } = await newSession({ width: 1440, height: 1000 }, { ...SCENARIO, tab: 'home' });
  const check = await page.evaluate(() => {
    const wrap = document.querySelector('.wrap');
    return {
      isHomeActive: document.querySelector('.tab-panel[data-tab="home"]').classList.contains('active'),
      wrapMaxWidth: getComputedStyle(wrap).maxWidth,
    };
  });
  await page.close();
  assert.ok(check.isHomeActive, 'sanity: Home must be the active tab for this check');
  assert.equal(check.wrapMaxWidth, '800px', 'on desktop, with Home active, .wrap must widen to the new 800px content constraint');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.15-4: other pages do not inherit the Home desktop width change (.wrap stays at 520px on desktop for a non-Home tab)', async () => {
  const otherTabs = ['income', 'expenses', 'assets', 'debts', 'goals', 'invest', 'coach', 'settings', 'journey', 'tools', 'reminders', 'notes'];
  const results = [];
  for (const tab of otherTabs) {
    const { page, pageErrors } = await newSession({ width: 1440, height: 1000 }, { ...SCENARIO, tab });
    const check = await page.evaluate((t) => ({
      isTabActive: document.querySelector(`.tab-panel[data-tab="${t}"]`).classList.contains('active'),
      wrapMaxWidth: getComputedStyle(document.querySelector('.wrap')).maxWidth,
    }), tab);
    await page.close();
    assert.equal(pageErrors.length, 0, `${tab}: ${JSON.stringify(pageErrors)}`);
    results.push({ tab, ...check });
  }
  for (const r of results) {
    assert.ok(r.isTabActive, `sanity: ${r.tab} must be the active tab for this check`);
    assert.equal(r.wrapMaxWidth, '520px', `desktop .wrap must stay at the original 520px cap on the "${r.tab}" tab (must not inherit Home's wider column)`);
  }
});

test('FAZ3.15-5: protected financial engines/constants remain untouched by this presentation-only fix', async () => {
  const protectedNames = [
    'function runDecisionEngineV2(', 'function runGoalCashAllocationEngine(',
    'function runMonthlyGoalCashAllocationLive(', 'function computeGoalInfo(',
    'function buildMonthlySnapshot(', 'function computeCashFlowSummary(',
    'function getAffordCapacityInfo(', 'function assessCardAffordability(',
    'function getFinancialAlerts(', 'function computePriorityPlan(',
    'function _planKur(', 'function ensureTodaysMoneyTask(', 'function upgradeStalePersistedMoneyTask(',
  ];
  for (const sig of protectedNames) {
    assert.ok(appHtmlSource.includes(sig), `protected function signature must still be present verbatim: ${sig}`);
  }
  assert.ok(appHtmlSource.includes('const RISK_PROFILES'), 'RISK_PROFILES constant must still be present');

  const { page, pageErrors } = await newSession({ width: 1440, height: 1000 }, { ...SCENARIO, tab: 'home' });
  const check = await page.evaluate(() => {
    const canonical = runMonthlyGoalCashAllocationLive();
    return { distributableCash: canonical.distributableCash };
  });
  await page.close();
  assert.equal(check.distributableCash, 120000, 'protected engine output for this scenario must be unchanged by a pure CSS width fix');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.15-6: existing Home functionality (rendered section content) remains unchanged at the new desktop width', async () => {
  const { page, pageErrors } = await newSession({ width: 1440, height: 1000 }, { ...SCENARIO, tab: 'home' });
  const check = await page.evaluate(() => {
    const panel = document.querySelector('.tab-panel[data-tab="home"]');
    return {
      hasFinansalDurum: !!panel.querySelector('[data-section="finansal-durum"]')?.textContent.trim().length,
      hasBugununGorevi: !!panel.querySelector('[data-section="bugunun-gorevi"]'),
      hasRing: !!panel.querySelector('[data-section="ring"]'),
      hasBuAyPlan: !!panel.querySelector('[data-section="bu-ay-plan"]')?.textContent.trim().length,
      hasBilmenGerekenler: !!panel.querySelector('[data-section="bugun-bilmen-gerekenler"]'),
      hasAffordTeaser: !!panel.querySelector('[data-section="afford-teaser"]')?.textContent.trim().length,
    };
  });
  await page.close();
  assert.ok(check.hasFinansalDurum, 'Finansal Durum must still render content');
  assert.ok(check.hasBugununGorevi, 'Sıradaki Adımım / Bugünün Görevi section must still exist');
  assert.ok(check.hasRing, 'Bugünün Güvenli Bütçesi (ring) section must still exist');
  assert.ok(check.hasBuAyPlan, 'Bu Ayki Planım must still render content');
  assert.ok(check.hasBilmenGerekenler, 'Bugün Bilmen Gerekenler section must still exist');
  assert.ok(check.hasAffordTeaser, 'Alabilir miyim? teaser must still render content');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});
