// FAZ 3.8 — AYARLAR EKRANI BİLGİ MİMARİSİ SADELEŞTİRMESİ REGRESYONU
// -----------------------------------------------------------------------
// Bu dosya, Ayarlar sekmesinde YALNIZCA sunum/HTML/CSS/i18n katmanında yapılan şu
// değişiklikleri doğrular (hiçbir finansal motora dokunulmadı):
//   1. Ayar satırları beş adlandırılmış gruba ayrıldı (HESABIM/TERCİHLER/GÜVENLİK/
//      VERİLERİM/HAKKINDA) — bkz. hazirlaAyarGruplari()/DEFAULT_SECTION_ORDER.settings.
//   2. Doğru satırlar doğru grubun altında (ör. Uygulama Kilidi artık GÜVENLİK'te,
//      eskiden Para Birimi ile Bildirimler arasına sıkışmıştı).
//   3. Misafir hesabında "Hesap oluştur" + "Giriş yap" gösteriliyor, "Profili düzenle"
//      GÖSTERİLMİYOR (anlamsal karışıklık giderildi); gerçek hesapta ise "Profili düzenle" /
//      "Çıkış yap" / "Hesabı sil" hâlâ aynı şekilde çalışıyor — hiçbir handler silinmedi.
//   4. CSV dışa aktarma ve Yedekleme düğmeleri/davranışları (id'ler, click handler'lar) korundu.
//   5. Alt navigasyon (Ana Sayfa | Gelir-Gider | Sesle Ekle | Varlıklar | Hedefler) Ayarlar
//      sekmesindeyken de aynen render ediliyor.
// runDecisionEngineV2()/runGoalCashAllocationEngine()/computeGoalInfo()/buildMonthlySnapshot()/
// computeCashFlowSummary()/getAffordCapacityInfo()/assessCardAffordability()/getFinancialAlerts()/
// computePriorityPlan()/_planKur()/RISK_PROFILES/activeRiskProfile bu dosya tarafından ASLA
// çağrılmaz/mutasyona uğratılmaz — bu ekranın onlarla hiç ilgisi yok.
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

async function newSession() {
  const page = await browser.newPage({ viewport: { width: 390, height: 1600 } });
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
  await page.evaluate(() => { setTab('settings'); render(); });
  return { page, pageErrors };
}

// ---------------------------------------------------------------------
// 1. Group headers exist, in the right order, with the right text.
// ---------------------------------------------------------------------
test('FAZ3.8-1: Settings shows exactly the 5 expected group headers, in order', async () => {
  const { page, pageErrors } = await newSession();
  const headers = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.tab-panel[data-tab="settings"] > .ayar-grup-baslik')).map(el => el.textContent.trim())
  );
  await page.close();
  assert.deepEqual(headers, ['HESABIM', 'TERCİHLER', 'GÜVENLİK', 'VERİLERİM', 'HAKKINDA']);
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// 2. Each settings row lives directly under the correct group header.
// ---------------------------------------------------------------------
test('FAZ3.8-2: settings rows are grouped correctly (e.g. Uygulama Kilidi is under GÜVENLİK, not between Para Birimi/Bildirimler)', async () => {
  const { page, pageErrors } = await newSession();
  const map = await page.evaluate(() => {
    const panel = document.querySelector('.tab-panel[data-tab="settings"]');
    const kids = Array.from(panel.children).filter(el =>
      el.classList.contains('ayar-grup-baslik') || el.hasAttribute('data-section'));
    const out = {};
    let currentGroup = null;
    kids.forEach(el => {
      if (el.classList.contains('ayar-grup-baslik')) { currentGroup = el.textContent.trim(); return; }
      out[el.dataset.section] = currentGroup;
    });
    return out;
  });
  await page.close();
  assert.equal(map['hesap'], 'HESABIM');
  assert.equal(map['ayarlar-premium'], 'TERCİHLER');
  assert.equal(map['gorunum'], 'TERCİHLER');
  assert.equal(map['para-birimi'], 'TERCİHLER');
  assert.equal(map['bildirimler'], 'TERCİHLER');
  assert.equal(map['uygulama-kilit'], 'GÜVENLİK');
  assert.equal(map['yedekleme'], 'VERİLERİM');
  assert.equal(map['csv-baslik'], 'VERİLERİM');
  assert.equal(map['veri-yonetim'], 'VERİLERİM');
  assert.equal(map['hakkinda'], 'HAKKINDA');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// 3. Guest vs authenticated account CTAs don't clash / aren't confusing.
// ---------------------------------------------------------------------
test('FAZ3.8-3: guest account card shows "Hesap oluştur" + "Giriş yap" (no confusing "Profili düzenle")', async () => {
  const { page, pageErrors } = await newSession();
  const check = await page.evaluate(() => ({
    createBtn: !!document.getElementById('acctCreateBtn'),
    loginBtn: !!document.getElementById('acctLoginBtn'),
    editProfileBtn: !!document.getElementById('acctEditProfileBtn'),
    logoutBtn: !!document.getElementById('acctLogoutBtn'),
  }));
  await page.close();
  assert.equal(check.createBtn, true, '"Hesap oluştur" must be present for a guest');
  assert.equal(check.loginBtn, true, '"Giriş yap" must be present for a guest');
  assert.equal(check.editProfileBtn, false, '"Profili düzenle" must NOT be shown to a guest with no profile');
  assert.equal(check.logoutBtn, false, 'a guest must not see a logout button');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

test('FAZ3.8-4: authenticated account card keeps "Profili düzenle" / "Çıkış yap" — behavior unchanged', async () => {
  const { page, pageErrors } = await newSession();
  const check = await page.evaluate(() => {
    authState.status = 'authenticated';
    authState.user = { email: 'test@example.com' };
    authState.provider = 'email';
    renderAccountSettings();
    return {
      editProfileBtn: !!document.getElementById('acctEditProfileBtn'),
      logoutBtn: !!document.getElementById('acctLogoutBtn'),
      deleteBtn: !!document.getElementById('acctDeleteBtn'),
      createBtn: !!document.getElementById('acctCreateBtn'),
      loginBtn: !!document.getElementById('acctLoginBtn'),
    };
  });
  await page.close();
  assert.equal(check.editProfileBtn, true, 'authenticated users must still be able to edit their profile');
  assert.equal(check.logoutBtn, true);
  assert.equal(check.deleteBtn, true);
  assert.equal(check.createBtn, false, 'an authenticated user must not see "Hesap oluştur"');
  assert.equal(check.loginBtn, false, 'an authenticated user must not see "Giriş yap"');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// 4. CSV export / backup behavior is untouched.
// ---------------------------------------------------------------------
test('FAZ3.8-5: CSV export and backup controls keep their ids/handlers (only the surrounding copy changed)', async () => {
  const { page, pageErrors } = await newSession();
  const check = await page.evaluate(() => ({
    exportCsvBtn: !!document.getElementById('exportCsvBtn'),
    exportBackupBtn: !!document.getElementById('exportBackupBtn'),
    importBackupBtn: !!document.getElementById('importBackupBtn'),
    resetBtn: !!document.getElementById('resetBtn'),
    csvRowLabel: document.querySelector('[data-i18n="csv-baslik"]')?.textContent.trim(),
    csvRowValue: document.querySelector('[data-settings-value="csv"]')?.textContent.trim(),
    backupRowValue: document.querySelector('[data-settings-value="yedekleme"]')?.textContent.trim(),
  }));
  await page.close();
  assert.equal(check.exportCsvBtn, true);
  assert.equal(check.exportBackupBtn, true);
  assert.equal(check.importBackupBtn, true);
  assert.equal(check.resetBtn, true);
  assert.equal(check.csvRowLabel, 'Verileri Dışa Aktar');
  assert.equal(check.csvRowValue, 'CSV');
  assert.equal(check.backupRowValue, 'İndir / Geri Yükle');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});

// ---------------------------------------------------------------------
// 5. Bottom navigation keeps working while on the Settings screen.
// ---------------------------------------------------------------------
test('FAZ3.8-6: bottom nav (Ana Sayfa | Gelir-Gider | Sesle Ekle | Varlıklar | Hedefler) still renders on Settings', async () => {
  const { page, pageErrors } = await newSession();
  const check = await page.evaluate(() => ({
    groupCount: document.querySelectorAll('#bottomNav > .nav-group').length,
    hasIncome: !!document.querySelector('#bottomNav [data-serit-tab="income"]'),
    hasAssets: !!document.querySelector('#bottomNav [data-serit-tab="assets"]'),
    hasGoals: !!document.querySelector('#bottomNav [data-serit-tab="goals"]'),
    hasVoiceAdd: !!document.querySelector('#bottomNav [data-eylem="ses"]'),
    // #bottomNav is `position:fixed`, so offsetParent is unreliable here (browsers commonly
    // report null for fixed-position elements even when visible) — check computed style instead.
    visible: (() => {
      const cs = getComputedStyle(document.getElementById('bottomNav'));
      return cs.display !== 'none' && cs.visibility !== 'hidden';
    })(),
  }));
  await page.close();
  assert.equal(check.groupCount, 5, 'bottom nav must still have exactly 5 items on Settings');
  assert.equal(check.hasIncome, true);
  assert.equal(check.hasAssets, true);
  assert.equal(check.hasGoals, true);
  assert.equal(check.hasVoiceAdd, true);
  assert.equal(check.visible, true, 'bottom nav must stay visible on the Settings screen');
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
});
