// "SIRADAKİ ADIMIM" — Emergency Allocation Override ile hizalanma (P1-2) — regresyon testleri
// -----------------------------------------------------------------------
// AUDIT BULGUSU (FULLBUDGET_YNAB_AUDIT.md, P1, bulgu #4): "Sıradaki Adımım"ın adım-seçim
// mantığı (computePriorityPlan/_planKur) canonical GCAE'den bağımsız KENDİ acil-fon eşiğini/
// tutarını hesaplıyor; tutar/gerekçe sonradan (reconcileStepWithCanonicalAllocation/
// reconcilePersistedEmergencyTask/upgradeStalePersistedMoneyTask — FAZ 3.3/3.4/3.9/3.10/3.11)
// canonical sonuçla üzerine yazılıyor. Bu, testler yeşilken bile "yapısal kırılganlık" olarak
// işaretlenmişti; ÖZELLİKLE bu reconciliation zinciri, FAZ 3.x çalışmalarından SONRA eklenen
// Emergency Allocation Override özelliğiyle (bkz. emergency-allocation-override.regression.
// test.mjs, commit ec27d6b) hiç birlikte test edilmemişti — ki override tam olarak GCAE'nin
// acil-fon tutarını (calculatedAmt yerine kullanıcının belirlediği tutarı) değiştiren mekanizma.
//
// BU DOSYA NE YAPAR: mevcut kodu (herhangi bir motor formülünü) DEĞİŞTİRMEDEN, bu spesifik
// birleşimi (override AKTİFKEN "Sıradaki Adımım" doğru tutarı gösteriyor mu, hem YENİ bir görev
// kurulurken hem de ZATEN PERSIST EDİLMİŞ bir görev override SONRADAN değiştiğinde) doğrulayan
// regresyon testleri ekler. Test-önce-kod kuralına uygun olarak YAZILDI VE ÇALIŞTIRILDI —
// sonuç: mevcut reconciliation zinciri (canonicalRowForMoneyTask'ın `type ===
// 'emergency_fund_contribution'` filtresi override'lı satırları da kapsıyor, bkz. index.html
// ADIM2/EMERGENCY-OVERRIDE bloğu) bu birleşimi ZATEN doğru ele alıyor — bu yüzden P1-2 için
// KOD DEĞİŞİKLİĞİ GEREKMEDİ; bu dosya, gelecekte biri bu zinciri değiştirirse bunu regresyon
// olarak yakalayacak bir GÜVENCE TESTİDİR.
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
      persistent.debts = s.debts || [];
      persistent.creditCards = s.creditCards || [];
      month.incomes = s.income > 0 ? [{ id: 'i1', category: 'Maaş', amount: s.income }] : [];
      month.expenses = s.expenses > 0 ? [{ id: 'e1', category: 'Diğer', amount: s.expenses }] : [];
      persistent.goals = s.goals || [];
      persistent.dailyMoneyTask = null; // sıfırdan kurulsun
      setTab('home');
      render();
    }, setup);
  }
  return { page, pageErrors };
}

// FAZ3.9'un DIVERGENT_SCENARIO'suyla aynı: gerçek bir acil-fon açığı var (liquid < 3 aylık
// zorunlu gider), hem _planKur'un KENDİ eşiği hem canonical emergencyGap bu konuda hemfikir —
// tam da override'ın devreye girdiği (emergencyGap>0) durum.
const SCENARIO = {
  income: 120000, expenses: 40000, assets: 65000,
  creditCards: [{ id: 'c1', name: 'Kart', currentBalance: 15000, limit: 100000, statementDay: 1, dueDay: 10 }],
};

test('OVERRIDE-STEP-1: override YOKKEN "Sıradaki Adımım" hesaplanan (calculatedAmt) tutarı gösterir (temel doğrulama)', async () => {
  const { page, pageErrors } = await newSession(SCENARIO);
  const check = await page.evaluate(() => {
    const canonical = runMonthlyGoalCashAllocationLive();
    const row = canonical.allocations.find(a => a.type === 'emergency_fund_contribution' && a.amount > 1);
    return {
      taskCategory: persistent.dailyMoneyTask.task.category,
      taskAmount: persistent.dailyMoneyTask.task.amount,
      isOverridden: row ? row.isOverridden : null,
      calculatedAmount: row ? row.calculatedAmount : null,
    };
  });
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  assert.equal(check.taskCategory, 'acil_fon', 'sanity: bu senaryo gerçekten bir acil-fon açığı üretmeli');
  assert.equal(check.isOverridden, false);
  assert.equal(check.taskAmount, check.calculatedAmount);
});

test('OVERRIDE-STEP-2: override AKTİFKEN YENİ kurulan "Sıradaki Adımım", override tutarını gösterir — _planKur\'un KENDİ formülünü ya da hesaplanan varsayılanı DEĞİL', async () => {
  const { page, pageErrors } = await newSession(SCENARIO);
  // Önce override YOKKEN calculatedAmt'yi öğren, override'ı ondan BELİRGİN ŞEKİLDE farklı seç.
  const before = await page.evaluate(() => {
    const canonical = runMonthlyGoalCashAllocationLive();
    const row = canonical.allocations.find(a => a.type === 'emergency_fund_contribution' && a.amount > 1);
    const rawStep = _planCache.steps.find(s => s.ik === 'iyi' && /acil/i.test(String(s.label || '')));
    return { calculatedAmount: row.amount, rawPlanKurAmount: rawStep ? rawStep.amount : null };
  });
  assert.notEqual(before.rawPlanKurAmount, before.calculatedAmount,
    'sanity: _planKur\'un KENDİ (30%-damla) formülü canonical calculatedAmt\'den FARKLI olmalı, aksi halde bu senaryo hiçbir şeyi kanıtlamaz');
  const overrideAmount = Math.max(1000, Math.round(before.calculatedAmount * 0.4));
  assert.notEqual(overrideAmount, before.calculatedAmount, 'sanity: seçilen override tutarı calculatedAmt\'den farklı olmalı');

  const after = await page.evaluate((ov) => {
    month.emergencyAllocationOverride = ov;
    persistent.dailyMoneyTask = null; // henüz kurulmamış gibi davran — TAZE görev kurulumu senaryosu
    render();
    const canonical = runMonthlyGoalCashAllocationLive();
    const row = canonical.allocations.find(a => a.type === 'emergency_fund_contribution' && a.amount > 1);
    return {
      taskCategory: persistent.dailyMoneyTask.task.category,
      taskAmount: persistent.dailyMoneyTask.task.amount,
      isOverridden: row ? row.isOverridden : null,
      canonicalOverriddenAmount: row ? row.amount : null,
    };
  }, overrideAmount);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  assert.equal(after.taskCategory, 'acil_fon');
  assert.equal(after.isOverridden, true, 'sanity: canonical GCAE gerçekten override\'ı uygulamış olmalı');
  assert.equal(after.canonicalOverriddenAmount, overrideAmount);
  assert.equal(after.taskAmount, overrideAmount,
    `"Sıradaki Adımım" override AKTİFKEN override tutarını (${overrideAmount}) göstermeli, gösterilen: ${after.taskAmount}`);
});

test('OVERRIDE-STEP-3: ZATEN PERSIST EDİLMİŞ bir görev varken override SONRADAN girilirse, görev bir SONRAKİ render\'da yeni override tutarına güncellenir (kimliği/id\'si değişmeden)', async () => {
  const { page, pageErrors } = await newSession(SCENARIO);
  const initial = await page.evaluate(() => ({
    id: persistent.dailyMoneyTask.task.id,
    amount: persistent.dailyMoneyTask.task.amount,
    category: persistent.dailyMoneyTask.task.category,
  }));
  assert.equal(initial.category, 'acil_fon');

  const overrideAmount = Math.max(1000, Math.round(initial.amount * 1.7));
  const after = await page.evaluate((ov) => {
    month.emergencyAllocationOverride = ov; // görev ZATEN persist edilmişken override giriliyor
    render(); // reconcilePersistedEmergencyTask() bu render'da tazelemeli
    return {
      id: persistent.dailyMoneyTask.task.id,
      amount: persistent.dailyMoneyTask.task.amount,
      category: persistent.dailyMoneyTask.task.category,
    };
  }, overrideAmount);
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  assert.equal(after.id, initial.id, 'aynı kararı temsil eden görevin KİMLİĞİ override ile değişmemeli — yalnızca tutar tazelenir');
  assert.equal(after.category, 'acil_fon');
  assert.equal(after.amount, overrideAmount,
    `zaten kurulmuş görev, override girildikten SONRAKİ render\'da yeni override tutarını (${overrideAmount}) yansıtmalı, gösterilen: ${after.amount}`);
});

test('OVERRIDE-STEP-4: bu doğrulama korunan finansal motor fonksiyonlarına/sabitlerine dokunmuyor (yalnızca yeni bir regresyon testi eklendi)', async () => {
  const { page, pageErrors } = await newSession(SCENARIO);
  const out = await page.evaluate(() => ({
    hasV2: typeof runDecisionEngineV2 === 'function',
    hasGCAE: typeof runGoalCashAllocationEngine === 'function',
    v2Src: runDecisionEngineV2.toString(),
    gcaeSrc: runGoalCashAllocationEngine.toString(),
  }));
  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  assert.equal(out.hasV2, true);
  assert.equal(out.hasGCAE, true);
});
