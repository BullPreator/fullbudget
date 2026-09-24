// FİNANS KOÇU — YÜZEN LAUNCHER + PANEL — davranış regresyon testleri
// -----------------------------------------------------------------------
// Amaç: ana sayfanın sağ-altına eklenen açılır/kapanır Finans Koçu launcher'ının
// (yeni bir AI/chat sistemi İCAT ETMEYEN, mevcut aiChatHistory/askCoach() akışını
// paylaşan ikinci bir sunum yüzeyi) temel davranışlarını gerçek bir Chromium
// sayfasında (Playwright), gerçek app/index.html üzerinde doğrulamak.
//
// Yöntem, ai-coach-priority-plan.regression.test.mjs ile AYNI: yerel bir statik
// dosya sunucusu + gerçek tarayıcı; hiçbir mantık elle kopyalanmadı/çatallanmadı.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(__dirname, '..', '..'); // repo kökü (app/ ve app/index.html'i içerir)

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

async function newPage(viewport) {
  const page = await browser.newPage({ viewport: viewport || { width: 1440, height: 900 } });
  const consoleErrors = [];
  page.on('pageerror', (err) => consoleErrors.push(String(err)));
  // 'domcontentloaded' yerine 'load' kullanılmadı: bu sandbox ortamında döviz/altın
  // kuru API'leri ve Google Fonts gibi dış kaynaklara giden istekler egress politikası
  // tarafından reddediliyor ve 'load' olayı hiç tetiklenmeyebiliyor (gerçek CI/production
  // ortamında bu kısıtlama yok). DOM ve script'lerin çalışması için 'domcontentloaded'
  // yeterli ve daha güvenilir.
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(300); // inline script'lerin ilk render'ı tamamlaması için kısa pay
  // Onboarding/auth overlaylerini kapat — AYNI desen ai-coach-priority-plan.regression.test.mjs
  // dosyasındaki newSession() ile (uygulamanın ilk açılış akışı, kopyalanmadı, aynen izlendi).
  for (const [ov, btn] of [['#onboardingOverlay', '#onboardSkipBtn'], ['#authOverlay', '#authGuestBtn']]) {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const shown = await page.evaluate((s) => {
        const e = document.querySelector(s);
        return !!(e && e.classList.contains('show'));
      }, ov).catch(() => false);
      if (shown) {
        const b = await page.$(btn);
        if (b) { await b.click({ force: true }).catch(() => {}); await page.waitForTimeout(300); break; }
        break;
      }
      await page.waitForTimeout(150);
    }
  }
  // Açılış splash ekranı (varsa) kısa bir süre sonra kendiliğinden kalkar; garanti olsun diye
  // gizli olmasını bekle - gerçek uygulama akışına müdahale etmez, yalnızca bekler.
  await page.waitForFunction(() => {
    const s = document.getElementById('splashScreen');
    return !s || getComputedStyle(s).display === 'none' || getComputedStyle(s).visibility === 'hidden' || getComputedStyle(s).opacity === '0';
  }, null, { timeout: 6000 }).catch(() => {});
  return { page, consoleErrors };
}

test('launcher DOM var ve başlangıçta panel kapalı', async () => {
  const { page } = await newPage();
  const launcher = page.locator('#fcLauncher');
  await assert.doesNotReject(launcher.waitFor({ state: 'visible', timeout: 5000 }));
  const panelHidden = await page.locator('#fcPanel').getAttribute('hidden');
  assert.notEqual(panelHidden, null);
  await page.close();
});

test('launcher tıklanınca panel açılır, kapatma düğmesiyle kapanır', async () => {
  const { page } = await newPage();
  await page.locator('#fcLauncher').click();
  await page.locator('#fcPanel.on').waitFor({ state: 'visible', timeout: 5000 });
  const expanded = await page.locator('#fcLauncher').getAttribute('aria-expanded');
  assert.equal(expanded, 'true');
  await page.locator('#fcCloseBtn').click();
  await page.waitForTimeout(250);
  const panelHidden = await page.locator('#fcPanel').getAttribute('hidden');
  assert.notEqual(panelHidden, null);
  await page.close();
});

test('ESC tuşu açık paneli kapatır', async () => {
  const { page } = await newPage();
  await page.locator('#fcLauncher').click();
  await page.locator('#fcPanel.on').waitFor({ state: 'visible', timeout: 5000 });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  const panelHidden = await page.locator('#fcPanel').getAttribute('hidden');
  assert.notEqual(panelHidden, null);
  await page.close();
});

test('boş mesaj gönderilemez (aiChatHistory değişmez)', async () => {
  const { page } = await newPage();
  await page.locator('#fcLauncher').click();
  await page.locator('#fcPanel.on').waitFor({ state: 'visible', timeout: 5000 });
  const before = await page.evaluate(() => aiChatHistory.length);
  await page.locator('#fcSendBtn').click();
  await page.waitForTimeout(150);
  const after = await page.evaluate(() => aiChatHistory.length);
  assert.equal(after, before);
  await page.close();
});

test('mesaj gönderince kullanıcı balonu görünür ve aynı geçmiş "Finans Koçun" sekmesiyle paylaşılır (tek gerçek kaynak)', async () => {
  const { page } = await newPage();
  // Bu sandbox ortamında gerçek AI backend'inin ağ adresine (Cloudflare Worker) egress
  // politikası izin vermiyor; canUseRealAICoach() true olduğunda gerçek istek denenir ve
  // 20 saniyelik timeout'tan SONRA şablon koça düşer (bkz. askCoachAI). Bu davranışın
  // KENDİSİ ayrı testlerde (sonsuz yükleme yok) doğrulanıyor; burada PAYLAŞILAN STATE'i
  // hızlı ve belirleyici test etmek için backend'i boş bırakarak (gerçek, var olan
  // isAICoachBackendReady() kapısı üzerinden) şablon yolunu seçtiriyoruz - yeni bir mantık
  // eklenmedi, sadece mevcut yapılandırma değişkeni test için boşaltıldı.
  // NOT: FB_AI_CONFIG klasik <script> içinde const ile tanımlı - top-level const/let
  // window'a EKLENMEZ (var'dan farklı olarak), bu yüzden window.FB_AI_CONFIG değil,
  // sayfanın global sözcük kapsamındaki çıplak tanımlayıcı üzerinden erişiliyor.
  await page.evaluate(() => { FB_AI_CONFIG.backendUrl = ''; });
  await page.locator('#fcLauncher').click();
  await page.locator('#fcPanel.on').waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('#fcInput').fill('Bu ay param nereye gidiyor?');
  await page.locator('#fcSendBtn').click();
  await page.waitForTimeout(50);
  const userBubble = await page.locator('#fcMessages .fc-msg.user').count();
  assert.ok(userBubble >= 1, 'kullanıcı mesajı panelde görünmeli');
  // Aynı soru aiChatHistory dizisine (Finans Koçun sekmesiyle PAYLAŞILAN tek state) girmeli.
  const sharedHistoryHasIt = await page.evaluate(() =>
    aiChatHistory.some((m) => m.role === 'user' && m.text === 'Bu ay param nereye gidiyor?')
  );
  assert.equal(sharedHistoryHasIt, true);
  await page.waitForFunction(() => !aiRequestInFlight, null, { timeout: 8000 });
  const assistantBubble = await page.locator('#fcMessages .fc-msg.assistant').count();
  assert.ok(assistantBubble >= 1, 'koç bir cevap vermeli (sonsuz yükleme yok)');
  await page.close();
});

test('gerçek AI backend\'e ulaşılamasa bile (ağ engelli/reddedilmiş bağlantı) sonsuz yükleme olmaz, şablon cevaba düşer', async () => {
  const { page } = await newPage();
  // Bu testte backend KASITLI OLARAK gerçek (ama bu sandboxta egress politikası tarafından
  // reddedilen) adresinde bırakılıyor - askCoachAI'nin ağ hatası/timeout durumunda otomatik
  // şablon-cevap fallback'ini (mevcut, değiştirilmeyen davranış) uçtan uca doğrular. Bu
  // sandboxta bağlantı REDDİ genelde hızlı gerçekleştiği için (20sn'lik timeout'a
  // varmadan), asıl kanıtlanan şey "ne olursa olsun eninde sonunda bir cevap gelir,
  // sonsuza kadar yüklenmez" garantisidir - üst sınır 25sn olarak bırakıldı.
  await page.locator('#fcLauncher').click();
  await page.locator('#fcPanel.on').waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('#fcInput').fill('Bütçemi kontrol et');
  await page.locator('#fcSendBtn').click();
  await page.waitForFunction(() => aiRequestInFlight === false, null, { timeout: 25000 });
  const assistantBubble = await page.locator('#fcMessages .fc-msg.assistant').count();
  assert.ok(assistantBubble >= 1, 'ağ/timeout hatasında bile kullanıcı cevapsız kalmamalı');
  await page.close();
});

test('hoş geldin durumunda hazır soru çipleri gerçek örnek istemleri gösterir, yatırım tavsiyesi gibi görünmez', async () => {
  const { page } = await newPage();
  await page.evaluate(() => { window.aiChatHistory = []; });
  await page.locator('#fcLauncher').click();
  await page.locator('#fcPanel.on').waitFor({ state: 'visible', timeout: 5000 });
  const chipTexts = await page.locator('#fcMessages .fc-quick-btn').allTextContents();
  assert.ok(chipTexts.length >= 3, 'en az birkaç hazır soru gösterilmeli');
  // Tam kelime sınırlarıyla: yatırım yönlendirmesi (hisse al/sat, dolara geç, ...) YASAK;
  // "Finansal" gibi kelimelerin İÇİNDEKİ "al" gibi rastgele alt dizeler YANLIŞ POZİTİF sayılmaz.
  const forbidden = /\bhisse\b|\bal\b|\bsat\b|dolara geç|yatırım yap|\bbuy\b|\bsell\b/i;
  for (const t of chipTexts) assert.equal(forbidden.test(t), false, `çip yatırım tavsiyesi gibi görünmemeli: "${t}"`);
  await page.close();
});

test('mobil genişlikte launcher, alt gezinme çubuğuyla üst üste binmez', async () => {
  const { page } = await newPage({ width: 390, height: 844 });
  const launcherBox = await page.locator('#fcLauncher').boundingBox();
  const navBox = await page.locator('.bottom-nav').first().boundingBox().catch(() => null);
  assert.ok(launcherBox, 'launcher görünür olmalı');
  if (navBox) {
    // Launcher'ın alt kenarı, alt nav'ın üst kenarından YUKARIDA olmalı (çakışma yok).
    assert.ok(launcherBox.y + launcherBox.height <= navBox.y + 2, 'launcher alt navigasyonun üzerine binmemeli');
  }
  await page.close();
});

test('konsolda yakalanmamış hata (pageerror) yok', async () => {
  const { page, consoleErrors } = await newPage();
  await page.locator('#fcLauncher').click();
  await page.locator('#fcPanel.on').waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('#fcCloseBtn').click();
  await page.waitForTimeout(200);
  assert.deepEqual(consoleErrors, []);
  await page.close();
});
