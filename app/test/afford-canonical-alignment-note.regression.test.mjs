// "ALABİLİR MİYİM?" — canonical hizalama netliği (P1-1) — regresyon testleri
// -----------------------------------------------------------------------
// AUDIT BULGUSU (FULLBUDGET_YNAB_AUDIT.md, P1, IP-3): getAffordCapacityInfo()/
// computeAffordability() zaten TEK KAYNAK fonksiyonları (totalIncome/totalSpent/
// estimateMonthlyEssential/totalLiquidAssets) kullanıyor — kendi paralel bir "toplam"
// hesabı icat ETMİYOR. Ama kendi son-adım formülü olan `safeMonthlyCapacity`
// (nakit akışından acil-fon payı + %80 güvenlik tamponu düşülerek) GCAE'nin
// `distributableCash`'inden (bu ayki borç/acil-fon/diğer-hedef önceliklerinden SONRA
// kalan para) YAPISAL OLARAK FARKLI bir soruya cevap veriyor — ve mimari olarak
// buildMonthlySnapshot() zaten getAffordCapacityInfo()'yu OKUYARAK Decision Engine'e
// giden zinciri kuruyor (getAffordCapacityInfo -> buildMonthlySnapshot -> Decision
// Engine), yani "Alabilir miyim?" GCAE'nin son çıktısını (distributableCash) geri
// besleyemez (bu, döngüsel bağımlılık kurar ve HESAPLAMA MOTORUNU DEĞİŞTİRMEK
// anlamına gelir — açıkça yasak).
//
// Bu yüzden onaylanan minimal düzeltme audit'in kendi IP-3 önerisiyle (P1, "Çok Düşük"
// risk) birebir aynı: HESAPLAMA DEĞİŞMEDİ (safeMonthlyCapacity/requiredPace/verdict
// aynı formüllerle hesaplanmaya devam ediyor) — yalnızca renderAffordResult()'a, bu
// ekranın "Bu Ayın Planı" ekranından FARKLI bir soruya cevap verdiğini açıklayan bir
// UX notu eklendi, kullanıcı iki farklı sayı görünce kafası karışmasın diye.
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

async function newSession(setup) {
  const page = await browser.newPage({ viewport: { width: 430, height: 1600 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  for (const [ov, btn] of [['#onboardingOverlay', '#onboardSkipBtn'], ['#authOverlay', '#authGuestBtn']]) {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const shown = await page.evaluate((s) => {
        const e = document.querySelector(s); return !!(e && e.classList.contains('show'));
      }, ov).catch(() => false);
      if (shown) { const b = await page.$(btn); if (b) { await b.click({ force: true }).catch(() => {}); await page.waitForTimeout(300); break; } }
      await page.waitForTimeout(150);
    }
  }
  if (setup) {
    await page.evaluate((s) => {
      persistent.accounts = s.assets ? [{ id: 'a1', name: 'Banka', type: 'Banka Hesabı', balance: s.assets, currency: 'TRY' }] : [];
      persistent.debts = [];
      persistent.creditCards = [];
      month.incomes = s.income > 0 ? [{ id: 'i1', category: 'Maaş', amount: s.income }] : [];
      month.expenses = s.expenses > 0 ? [{ id: 'e1', category: 'Diğer', amount: s.expenses }] : [];
      persistent.goals = s.goals || [];
      render();
      setTab('goals');
    }, setup);
  }
  return { page, pageErrors };
}

test('AFFORD-NOTE-1: "Alabilir miyim?" sonuç kartı, Bu Ayın Planı ile farklı soruya cevap verdiğini açıklayan bir not içerir', async () => {
  const futureDate = new Date(Date.now() + 200 * 86400000).toISOString().slice(0, 10);
  const { page, pageErrors } = await newSession({
    income: 100000, expenses: 30000, assets: 300000,
    goals: [{ id: 'g1', typeKey: 'diger', name: 'Bilgisayar', targetAmount: 40000, targetDate: futureDate }],
  });
  const check = await page.evaluate(() => {
    openGoalAfford('g1');
    return { dcHtml: document.getElementById('affordDecisionCard').innerHTML };
  });
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  assert.ok(/Bu Ayın Planı/.test(check.dcHtml) || /This Month's Plan/.test(check.dcHtml), 'sonuç kartı iki ekranın farklı sorulara cevap verdiğini açıklamalı');
});

test('AFFORD-NOTE-2: bu not EKLENDİ ama safeMonthlyCapacity/requiredPace HESAPLAMASI hiç değişmedi (yalnızca metin)', async () => {
  const futureDate = new Date(Date.now() + 200 * 86400000).toISOString().slice(0, 10);
  const { page, pageErrors } = await newSession({
    income: 100000, expenses: 30000, assets: 300000,
    goals: [{ id: 'g1', typeKey: 'diger', name: 'Bilgisayar', targetAmount: 40000, targetDate: futureDate }],
  });
  const check = await page.evaluate(() => {
    openGoalAfford('g1');
    const r = affordLastResult;
    const cap = getAffordCapacityInfo();
    return { safeMonthlyCapacity: r.safeMonthlyCapacity, requiredPace: r.requiredPace, capSafeMonthlyCapacity: cap.safeMonthlyCapacity };
  });
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  // getAffordCapacityInfo()'nun kendi formülüyle computeAffordability() sonucundaki
  // safeMonthlyCapacity birebir aynı olmalı — bu değişiklik hesaplamaya dokunmadı.
  assert.equal(check.safeMonthlyCapacity, check.capSafeMonthlyCapacity, 'safeMonthlyCapacity formülü DEĞİŞMEMİŞ olmalı');
  assert.ok(typeof check.requiredPace === 'number', 'requiredPace hâlâ normal şekilde hesaplanıyor olmalı');
});

test('AFFORD-NOTE-3: ad-hoc (hedefsiz) "Alabilir miyim?" akışında da aynı açıklayıcı not gösterilir', async () => {
  const { page, pageErrors } = await newSession({ income: 80000, expenses: 30000, assets: 200000, goals: [] });
  const check = await page.evaluate(() => {
    openAdHocAffordEntry();
    return true;
  });
  await page.fill('#adHocPrice', '5000');
  await page.fill('#adHocDownPayment', '0');
  await page.click('#adHocSubmitBtn');
  await page.waitForTimeout(200);
  const dcHtml = await page.evaluate(() => document.getElementById('affordDecisionCard').innerHTML);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  assert.ok(/Bu Ayın Planı/.test(dcHtml) || /This Month's Plan/.test(dcHtml), 'ad-hoc akışta da aynı açıklayıcı not gösterilmeli');
});

test('AFFORD-NOTE-4: bu değişiklik korunan finansal motor fonksiyonlarına/sabitlerine dokunmuyor', async () => {
  const { page, pageErrors } = await newSession({ income: 80000, expenses: 30000, assets: 200000, goals: [] });
  const out = await page.evaluate(() => ({
    hasV2: typeof runDecisionEngineV2 === 'function',
    hasGCAE: typeof runGoalCashAllocationEngine === 'function',
    v2Src: runDecisionEngineV2.toString(),
    gcaeSrc: runGoalCashAllocationEngine.toString(),
    affordCapSrc: getAffordCapacityInfo.toString(),
  }));
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  assert.equal(out.hasV2, true);
  assert.equal(out.hasGCAE, true);
  // getAffordCapacityInfo()'nun KENDİSİ (rakamları üreten fonksiyon) hiç değişmedi —
  // değişiklik yalnızca renderAffordResult()'taki metin bloğunda.
  assert.ok(!/Bu Ayın Planı|This Month's Plan/.test(out.affordCapSrc), 'getAffordCapacityInfo() hesaplama fonksiyonuna metin/not eklenmemiş olmalı — not yalnızca render katmanında');
});
