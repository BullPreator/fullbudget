// HEDEF — "currentSaved" (biriktirilen tutar) DÜZENLEME — regresyon testleri (P0-2)
// -----------------------------------------------------------------------
// AUDIT BULGUSU (FULLBUDGET_YNAB_AUDIT.md, P0): sıradan hedeflerde (ev/araba/bilgisayar/
// telefon/tatil/motor/egitim/dugun/yatirim/diger) computeGoalInfo() `alreadySaved`'i
// `g.currentSaved`'den okuyor — ama bu alan kullanıcının hedefi OLUŞTURMA anında bir kez
// elle girdiği, sonrasında HİÇBİR yerden düzenlenemeyen bir alandı (uygulama genelinde bir
// "hedef düzenle" akışı yoktu, yalnızca "sil" vardı). Sonuç: (a) kullanıcı parayı başka yere
// harcasa bile ilerleme çubuğu güncellenmiyor (donuk/yanlış ilerleme), (b) aynı fiziksel para
// birden fazla hedefe "biriktirdim" olarak girilip çapraz kontrol edilmeden kalabiliyordu.
//
// DÜZELTME (minimal, IP-2'ye birebir uygun): var olan TEK alana (currentSaved) küçük bir
// "düzenle" arayüzü eklendi — yeni bir hedef motoru/otomatik senkron YOK. Yalnızca
// computeGoalInfo()'nun zaten `g.currentSaved`'i DOĞRUDAN okuduğu türlerde (kind: market/
// custom/custom_named) düzenlenebilir; canlı/kaynağından hesaplanan türlerde (acilfon/
// borcsuz/networth/fire/gelirartir — kind: saving/debtfree/networth/fire/income_target)
// düzenle düğmesi hiç gösterilmez, çünkü o türlerde zaten `alreadySaved` gerçek finansal
// durumdan (totalLiquidAssets/netWorth/totalDebtTL/totalIncome) canlı okunuyor — DOĞRU desen,
// dokunulmadı.
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

async function newPage() {
  const page = await browser.newPage({ viewport: { width: 430, height: 1600 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  for (const [ov, btn] of [['#onboardingOverlay', '#onboardSkipBtn'], ['#authOverlay', '#authGuestBtn']]) {
    const dl = Date.now() + 8000;
    while (Date.now() < dl) {
      const shown = await page.evaluate((s) => {
        const e = document.querySelector(s); return !!(e && e.classList.contains('show'));
      }, ov).catch(() => false);
      if (shown) { const b = await page.$(btn); if (b) { await b.click({ force: true }).catch(() => {}); await page.waitForTimeout(300); break; } }
      await page.waitForTimeout(150);
    }
  }
  return { page, pageErrors };
}

function setupPhoneGoal() {
  persistent.accounts = [{ id: 'a1', name: 'Banka', type: 'Banka Hesabı', balance: 100000, currency: 'TRY' }];
  persistent.debts = []; persistent.creditCards = [];
  persistent.goals = [{ id: 'gTel', typeKey: 'telefon', targetAmount: 50000, currentSaved: 10000, targetDate: '' }];
  persistent.dailyMoneyTask = null; persistent.cardPaymentLog = [];
  month.incomes = [{ id: 'i1', category: 'Maaş', amount: 40000 }];
  month.expenses = [];
}

function setupEmergencyFundGoal() {
  persistent.accounts = [{ id: 'a1', name: 'Banka', type: 'Banka Hesabı', balance: 100000, currency: 'TRY' }];
  persistent.debts = []; persistent.creditCards = [];
  persistent.goals = [{ id: 'gAcil', typeKey: 'acilfon', targetAmount: 0, currentSaved: 5000, targetDate: '' }];
  persistent.dailyMoneyTask = null; persistent.cardPaymentLog = [];
  month.incomes = [{ id: 'i1', category: 'Maaş', amount: 40000 }];
  month.expenses = [{ id: 'e1', category: 'Diğer', amount: 10000, fixed: true }];
}

test('GOAL-EDIT-1: sıradan hedef (telefon) kartında "biriktirileni düzenle" düğmesi gösterilir', async () => {
  const { page, pageErrors } = await newPage();
  const out = await page.evaluate((setupSrc) => {
    eval(setupSrc);
    render();
    const box = document.getElementById('goalList');
    return { hasEditBtn: !!box.querySelector('.goal-saved-edit-btn[data-id="gTel"]') };
  }, `${setupPhoneGoal.toString()}\nsetupPhoneGoal();`);
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  assert.equal(out.hasEditBtn, true, 'sıradan hedefte düzenle düğmesi olmalı');
  await page.close();
});

test('GOAL-EDIT-2: canlı/canonical kaynaklı hedef (Acil Durum Fonu) kartında düzenle düğmesi GÖSTERİLMEZ', async () => {
  const { page, pageErrors } = await newPage();
  const out = await page.evaluate((setupSrc) => {
    eval(setupSrc);
    render();
    const box = document.getElementById('goalList');
    return { hasEditBtn: !!box.querySelector('.goal-saved-edit-btn[data-id="gAcil"]') };
  }, `${setupEmergencyFundGoal.toString()}\nsetupEmergencyFundGoal();`);
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  assert.equal(out.hasEditBtn, false, 'acilfon gibi canonical kaynaklı hedeflerde düzenle düğmesi OLMAMALI — alreadySaved zaten totalLiquidAssets()\'ten canlı okunuyor, elle üzerine yazılabilir olmamalı');
  await page.close();
});

test('GOAL-EDIT-3: düzenle → yeni tutar gir → kaydet: currentSaved güncellenir, gap/ilerleme DOĞRU yeniden hesaplanır ve kalıcı olur', async () => {
  const { page, pageErrors } = await newPage();
  const before = await page.evaluate((setupSrc) => {
    eval(setupSrc);
    render();
    executeQuickAction({tab:'goals'});
    const info = computeGoalInfo(persistent.goals[0]);
    return { gap: info.gap, alreadySaved: info.alreadySaved };
  }, `${setupPhoneGoal.toString()}\nsetupPhoneGoal();`);
  assert.equal(before.gap, 40000, 'başlangıçta gap = 50000-10000 = 40000 olmalı');

  await page.click('.goal-saved-edit-btn[data-id="gTel"]');
  await page.waitForTimeout(50);
  const inputSel = '#goalSavedInput-gTel';
  await page.fill(inputSel, '25000');
  await page.click('.goal-saved-save-btn[data-id="gTel"]');
  await page.waitForTimeout(50);

  const after = await page.evaluate(() => {
    const info = computeGoalInfo(persistent.goals[0]);
    return {
      currentSaved: persistent.goals[0].currentSaved,
      gap: info.gap,
      alreadySaved: info.alreadySaved,
      cardHtml: document.getElementById('goalList').innerHTML,
      stillEditing: !!document.querySelector('#goalSavedInput-gTel'),
    };
  });
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  assert.equal(after.currentSaved, 25000, 'currentSaved kaydedilen yeni değere güncellenmeli');
  assert.equal(after.alreadySaved, 25000, 'computeGoalInfo bu türde alreadySaved\'i güncel currentSaved\'den okumalı');
  assert.equal(after.gap, 25000, 'gap yeni değere göre yeniden hesaplanmalı (50000-25000=25000)');
  assert.equal(after.stillEditing, false, 'kaydettikten sonra düzenleme modu kapanmalı (girdi alanı kalmamalı)');
  assert.ok(after.cardHtml.includes('25.000') || after.cardHtml.includes('25000'), 'kart görünümü yeni tutarı yansıtmalı');

  // Kalıcılık: reload sonrası da yeni değer korunmalı.
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(500);
  const persisted = await page.evaluate(() => (persistent.goals.find(g => g.id === 'gTel') || {}).currentSaved);
  await page.close();
  assert.equal(persisted, 25000, 'sayfa yenilendikten sonra da güncellenen currentSaved kalıcı olmalı');
});

test('GOAL-EDIT-4: "vazgeç" ile düzenleme iptal edilirse currentSaved DEĞİŞMEZ', async () => {
  const { page, pageErrors } = await newPage();
  await page.evaluate((setupSrc) => { eval(setupSrc); render(); executeQuickAction({tab:'goals'}); }, `${setupPhoneGoal.toString()}\nsetupPhoneGoal();`);
  await page.click('.goal-saved-edit-btn[data-id="gTel"]');
  await page.waitForTimeout(50);
  await page.fill('#goalSavedInput-gTel', '99999');
  await page.click('.goal-saved-cancel-btn[data-id="gTel"]');
  await page.waitForTimeout(50);
  const out = await page.evaluate(() => ({
    currentSaved: persistent.goals[0].currentSaved,
    stillEditing: !!document.querySelector('#goalSavedInput-gTel'),
  }));
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  assert.equal(out.currentSaved, 10000, 'vazgeçildiğinde currentSaved ORİJİNAL değerinde kalmalı');
  assert.equal(out.stillEditing, false, 'vazgeç sonrası düzenleme modu kapanmalı');
  await page.close();
});

test('GOAL-EDIT-5: geçersiz (negatif) tutarla kaydetmeye çalışmak reddedilir, currentSaved değişmez', async () => {
  const { page, pageErrors } = await newPage();
  await page.evaluate((setupSrc) => { eval(setupSrc); render(); executeQuickAction({tab:'goals'}); }, `${setupPhoneGoal.toString()}\nsetupPhoneGoal();`);
  await page.click('.goal-saved-edit-btn[data-id="gTel"]');
  await page.waitForTimeout(50);
  await page.fill('#goalSavedInput-gTel', '-500');
  await page.click('.goal-saved-save-btn[data-id="gTel"]');
  await page.waitForTimeout(50);
  const out = await page.evaluate(() => ({ currentSaved: persistent.goals[0].currentSaved }));
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  assert.equal(out.currentSaved, 10000, 'geçersiz (negatif) girişte currentSaved DEĞİŞMEMELİ');
  await page.close();
});

test('GOAL-EDIT-6: bu değişiklik korunan finansal motor fonksiyonlarına/sabitlerine dokunmuyor', async () => {
  const { page, pageErrors } = await newPage();
  const out = await page.evaluate(() => ({
    hasV2: typeof runDecisionEngineV2 === 'function',
    hasGCAE: typeof runGoalCashAllocationEngine === 'function',
    v2Src: runDecisionEngineV2.toString(),
    gcaeSrc: runGoalCashAllocationEngine.toString(),
  }));
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  assert.equal(out.hasV2, true);
  assert.equal(out.hasGCAE, true);
  assert.ok(!/editGoalCurrentSaved|goal-saved-edit-btn/.test(out.v2Src), 'runDecisionEngineV2 bu değişiklikten etkilenmemiş olmalı');
  assert.ok(!/editGoalCurrentSaved|goal-saved-edit-btn/.test(out.gcaeSrc), 'runGoalCashAllocationEngine bu değişiklikten etkilenmemiş olmalı');
  await page.close();
});
