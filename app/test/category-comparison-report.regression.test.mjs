// FAZ 3.14 IP-8 (kategori bazında ay karşılaştırması):
// -----------------------------------------------------------------------------------------
// AUDIT BULGUSU (FULLBUDGET_YNAB_AUDIT.md, IP-8): "Aylık Rapor" kartı yalnızca mevcut ayın
// EN ÇOK harcanan tek kategorisini gösteriyordu ("Top category"); kullanıcı hangi
// kategorilerin ÖNCEKİ AYA GÖRE arttığını/azaldığını göremiyordu.
//
// Bu değişiklik renderMonthlyReport() içine, mevcut "Top category" satırının HEMEN
// ALTINA, yalnızca GERÇEKTEN değişen (delta !== 0) kategorileri |delta| büyükten küçüğe
// sıralı, en fazla 5 tanesini gösteren yeni bir blok ekliyor. Veri kaynağı: mevcut ay için
// catSums (aynı fonksiyonda zaten month.expenses'ten hesaplanan, "Top category" ile
// BİREBİR aynı canlı veri — history[].categoryBreakdown DEĞİL); önceki ay için
// prev.categoryBreakdown || {} (tek kaynak zaten history[] olduğundan). Yeni bir
// persistence alanı EKLENMEDİ. Decision Engine v2 / GCAE'ye HİÇ dokunulmadı — bu saf bir
// görüntüleme/rapor değişikliği.
//
// waitForTimeout KULLANILMIYOR: renderMonthlyReport() senkron bir fonksiyon, bu yüzden
// tüm doğrulamalar page.evaluate() içinde çağrıldıktan hemen sonra DOM'u okuyarak yapılıyor.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import { readFileSync } from 'node:fs';
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

async function dismissOverlays(page) {
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
}

async function newSession() {
  const page = await browser.newPage({ viewport: { width: 390, height: 1200 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 30000 });
  await dismissOverlays(page);
  await page.evaluate(() => {
    persistent.accounts = [];
    persistent.debts = [];
    persistent.creditCards = [];
    persistent.goals = [];
    persistent.recurringIncomes = [];
    persistent.recurringExpenses = [];
    persistent.dailyMoneyTask = null;
  });
  return { page, pageErrors };
}

// Yardımcı: mevcut monthKey'den bir önceki ayın monthKey'ini üretir ('YYYY-MM' varsayımı,
// mevcut kod tabanında zaten bu formatta kullanılıyor).
function prevMonthKeyOf(mk) {
  const [y, m] = mk.split('-').map(Number);
  const d = new Date(y, m - 2, 1); // m 1-indexli -> m-1 mevcut ay index'i, -1 daha önceki ay
  const yy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${yy}-${mm}`;
}

// -----------------------------------------------------------------------
// CATCMP-01: mevcut ay ile önceki ay arasında farklı tutarlarda harcanan kategoriler
// doğru delta (mevcut - önceki) ve doğru işaret/renkle listelenmeli.
// -----------------------------------------------------------------------
test('CATCMP-01: farklı tutarlı kategoriler doğru delta ile listelenir', async () => {
  const { page, pageErrors } = await newSession();

  const r = await page.evaluate(() => {
    const mk = monthKey;
    const pmk = (() => {
      const [y, m] = mk.split('-').map(Number);
      const d = new Date(y, m - 2, 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    })();
    history.length = 0;
    history.push({ monthKey: pmk, income: 0, expense: 0, totalDebt: 0, assets: 0, netWorth: 0, categoryBreakdown: { 'Market': 1000, 'Yemek': 500 } });
    // renderMonthlyReport() içindeki "prev" hesaplaması currIdx (mevcut ayın history[]'deki
    // konumu) üzerinden yapılıyor (sorted.findIndex(h=>h.monthKey===monthKey)) — bu yüzden
    // testte mevcut ay için de (henüz scheduleHistorySave() çağrılmadığından elle) bir
    // placeholder history kaydı bulunması gerekiyor; bu, renderMonthlyReport()'un KENDİSİNİN
    // zaten var olan, değiştirilmeyen davranışı.
    history.push({ monthKey: mk, income: 0, expense: 0, totalDebt: 0, assets: 0, netWorth: 0 });

    month.expenses = [
      { id: 'e1', category: 'Market', amount: 1500, note: '', recurring: false, fixed: false, accountId: '', cardId: '' }, // artış: +500
      { id: 'e2', category: 'Yemek', amount: 200, note: '', recurring: false, fixed: false, accountId: '', cardId: '' }, // azalış: -300
    ];
    renderMonthlyReport();
    const box = document.getElementById('monthlyReportBox');
    return { html: box ? box.innerHTML : null };
  });

  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  assert.ok(r.html, 'monthlyReportBox render edilmiş olmalı');
  assert.match(r.html, /Kategori bazında değişim/, 'yeni başlık satırı görünmeli');
  assert.match(r.html, /Market/);
  assert.match(r.html, /\+₺?500/, `Market için +500 artış gösterilmeli, gerçek html: ${r.html}`);
  assert.match(r.html, /Yemek/);
  assert.match(r.html, /-₺?300/, `Yemek için -300 azalış gösterilmeli, gerçek html: ${r.html}`);
});

// -----------------------------------------------------------------------
// CATCMP-02: yalnızca mevcut ayda var olan (önceki ayda hiç olmayan) bir kategori de
// listeye dahil edilmeli (kaybolmamalı) — delta = mevcut - 0.
// -----------------------------------------------------------------------
test('CATCMP-02: yalnızca mevcut ayda olan kategori kaybolmadan listelenir', async () => {
  const { page, pageErrors } = await newSession();

  const r = await page.evaluate(() => {
    const mk = monthKey;
    const pmk = (() => {
      const [y, m] = mk.split('-').map(Number);
      const d = new Date(y, m - 2, 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    })();
    history.length = 0;
    history.push({ monthKey: pmk, income: 0, expense: 0, totalDebt: 0, assets: 0, netWorth: 0, categoryBreakdown: {} });
    history.push({ monthKey: mk, income: 0, expense: 0, totalDebt: 0, assets: 0, netWorth: 0 });

    month.expenses = [
      { id: 'e1', category: 'Eğlence', amount: 800, note: '', recurring: false, fixed: false, accountId: '', cardId: '' },
    ];
    renderMonthlyReport();
    const box = document.getElementById('monthlyReportBox');
    return { html: box ? box.innerHTML : null };
  });

  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  assert.match(r.html, /Eğlence/);
  assert.match(r.html, /\+₺?800/, `yeni kategori +800 olarak gösterilmeli, gerçek html: ${r.html}`);
});

// -----------------------------------------------------------------------
// CATCMP-03: yalnızca ÖNCEKİ ayda var olan (mevcut ayda hiç olmayan) bir kategori de
// listelenmeli — delta = 0 - önceki (negatif, azalış olarak).
// -----------------------------------------------------------------------
test('CATCMP-03: yalnızca önceki ayda olan kategori azalış olarak listelenir', async () => {
  const { page, pageErrors } = await newSession();

  const r = await page.evaluate(() => {
    const mk = monthKey;
    const pmk = (() => {
      const [y, m] = mk.split('-').map(Number);
      const d = new Date(y, m - 2, 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    })();
    history.length = 0;
    history.push({ monthKey: pmk, income: 0, expense: 0, totalDebt: 0, assets: 0, netWorth: 0, categoryBreakdown: { 'Tatil': 3000 } });
    history.push({ monthKey: mk, income: 0, expense: 0, totalDebt: 0, assets: 0, netWorth: 0 });

    month.expenses = [
      { id: 'e1', category: 'Market', amount: 100, note: '', recurring: false, fixed: false, accountId: '', cardId: '' },
    ];
    renderMonthlyReport();
    const box = document.getElementById('monthlyReportBox');
    return { html: box ? box.innerHTML : null };
  });

  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  assert.match(r.html, /Tatil/);
  assert.match(r.html, /-₺?3\.?000|-₺?3000/, `sadece önceki ayda olan kategori -3000 olarak gösterilmeli, gerçek html: ${r.html}`);
});

// -----------------------------------------------------------------------
// CATCMP-04: eski (legacy) history kaydında categoryBreakdown alanı hiç yoksa hata
// vermemeli (crash yok) ve blok basitçe boş kategori listesiyle davranmalı.
// -----------------------------------------------------------------------
test('CATCMP-04: categoryBreakdown alanı olmayan eski history kaydında hata oluşmaz', async () => {
  const { page, pageErrors } = await newSession();

  const r = await page.evaluate(() => {
    const mk = monthKey;
    const pmk = (() => {
      const [y, m] = mk.split('-').map(Number);
      const d = new Date(y, m - 2, 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    })();
    history.length = 0;
    // Eski kayıt: categoryBreakdown alanı YOK (IP-8 öncesi kayıtları simüle ediyor).
    history.push({ monthKey: pmk, income: 0, expense: 0, totalDebt: 0, assets: 0, netWorth: 0 });
    history.push({ monthKey: mk, income: 0, expense: 0, totalDebt: 0, assets: 0, netWorth: 0 });

    month.expenses = [
      { id: 'e1', category: 'Market', amount: 250, note: '', recurring: false, fixed: false, accountId: '', cardId: '' },
    ];
    let threw = false;
    try { renderMonthlyReport(); } catch (e) { threw = true; }
    const box = document.getElementById('monthlyReportBox');
    return { threw, html: box ? box.innerHTML : null };
  });

  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  assert.equal(r.threw, false, 'categoryBreakdown eksikken renderMonthlyReport() hata fırlatmamalı');
  // categoryBreakdown olmayan eski kayıt -> prevCatBreakdown = {} -> Market (250) mevcut
  // ayda var, öncekinde 0 -> delta=+250 -> yine de doğru şekilde listelenmeli (crash yok).
  assert.match(r.html, /Market/);
  assert.match(r.html, /\+₺?250/, `gerçek html: ${r.html}`);
});

// -----------------------------------------------------------------------
// CATCMP-05: prev yoksa (ilk ay, hiç geçmiş kaydı yok) yeni blok hiç render edilmemeli.
// -----------------------------------------------------------------------
test('CATCMP-05: önceki ay kaydı yoksa kategori karşılaştırma bloğu render edilmez', async () => {
  const { page, pageErrors } = await newSession();

  const r = await page.evaluate(() => {
    history.length = 0; // hiç geçmiş yok -> prev = null
    month.expenses = [
      { id: 'e1', category: 'Market', amount: 250, note: '', recurring: false, fixed: false, accountId: '', cardId: '' },
    ];
    renderMonthlyReport();
    const box = document.getElementById('monthlyReportBox');
    return { html: box ? box.innerHTML : null };
  });

  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  assert.doesNotMatch(r.html, /Kategori bazında değişim/, 'prev yokken karşılaştırma bloğu görünmemeli');
});

// -----------------------------------------------------------------------
// CATCMP-06: 6+ değişen kategori varsa yalnızca |delta| büyükten küçüğe sıralı İLK 5'i
// gösterilmeli (limit doğru uygulanmalı).
// -----------------------------------------------------------------------
test('CATCMP-06: 6+ değişen kategoriden yalnızca |delta| en büyük 5 tanesi gösterilir', async () => {
  const { page, pageErrors } = await newSession();

  const r = await page.evaluate(() => {
    const mk = monthKey;
    const pmk = (() => {
      const [y, m] = mk.split('-').map(Number);
      const d = new Date(y, m - 2, 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    })();
    history.length = 0;
    history.push({
      monthKey: pmk, income: 0, expense: 0, totalDebt: 0, assets: 0, netWorth: 0,
      categoryBreakdown: { 'Market': 100, 'Yemek': 100, 'Ulaşım': 100, 'Fatura': 100, 'Eğlence': 100, 'Giyim': 100 },
    });
    history.push({ monthKey: mk, income: 0, expense: 0, totalDebt: 0, assets: 0, netWorth: 0 });
    // deltaler: Market +900 (|900|), Yemek +50 (|50|), Ulaşım -90 (|90|), Fatura +500 (|500|),
    // Eğlence +10 (|10|), Giyim +300 (|300|) -> beklenen top-5 (|delta| desc):
    // Market(900), Fatura(500), Giyim(300), Ulaşım(90), Yemek(50) -- Eğlence(10) dışarıda kalmalı.
    month.expenses = [
      { id: 'e1', category: 'Market', amount: 1000, note: '', recurring: false, fixed: false, accountId: '', cardId: '' },
      { id: 'e2', category: 'Yemek', amount: 150, note: '', recurring: false, fixed: false, accountId: '', cardId: '' },
      { id: 'e3', category: 'Ulaşım', amount: 10, note: '', recurring: false, fixed: false, accountId: '', cardId: '' },
      { id: 'e4', category: 'Fatura', amount: 600, note: '', recurring: false, fixed: false, accountId: '', cardId: '' },
      { id: 'e5', category: 'Eğlence', amount: 110, note: '', recurring: false, fixed: false, accountId: '', cardId: '' },
      { id: 'e6', category: 'Giyim', amount: 400, note: '', recurring: false, fixed: false, accountId: '', cardId: '' },
    ];
    renderMonthlyReport();
    const box = document.getElementById('monthlyReportBox');
    return { html: box ? box.innerHTML : null };
  });

  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  for (const cat of ['Market', 'Fatura', 'Giyim', 'Ulaşım', 'Yemek']) {
    assert.match(r.html, new RegExp(cat), `${cat} top-5 içinde olmalı, gerçek html: ${r.html}`);
  }
  assert.doesNotMatch(r.html, /Eğlence/, `en küçük |delta| olan Eğlence top-5 dışında kalmalı, gerçek html: ${r.html}`);
});

// -----------------------------------------------------------------------
// CATCMP-07: iki ayda BİREBİR AYNI tutarda harcanan (delta === 0) bir kategori hiç
// listelenmemeli (kullanıcının onayladığı düzeltme #1).
// -----------------------------------------------------------------------
test('CATCMP-07: delta === 0 olan (değişmeyen) kategori listelenmez', async () => {
  const { page, pageErrors } = await newSession();

  const r = await page.evaluate(() => {
    const mk = monthKey;
    const pmk = (() => {
      const [y, m] = mk.split('-').map(Number);
      const d = new Date(y, m - 2, 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    })();
    history.length = 0;
    history.push({ monthKey: pmk, income: 0, expense: 0, totalDebt: 0, assets: 0, netWorth: 0, categoryBreakdown: { 'Market': 500, 'Yemek': 200 } });
    history.push({ monthKey: mk, income: 0, expense: 0, totalDebt: 0, assets: 0, netWorth: 0 });

    month.expenses = [
      { id: 'e1', category: 'Market', amount: 500, note: '', recurring: false, fixed: false, accountId: '', cardId: '' }, // değişmedi
      { id: 'e2', category: 'Yemek', amount: 350, note: '', recurring: false, fixed: false, accountId: '', cardId: '' }, // +150 arttı
    ];
    renderMonthlyReport();
    const box = document.getElementById('monthlyReportBox');
    return { html: box ? box.innerHTML : null };
  });

  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  assert.match(r.html, /Kategori bazında değişim/, 'değişen kategori (Yemek) olduğu için blok görünmeli');
  assert.match(r.html, /Yemek/);
  assert.match(r.html, /\+₺?150/, `gerçek html: ${r.html}`);
  // Market değişmediği için satırında "Market" ismi kategori-karşılaştırma satırı olarak
  // GÖRÜNMEMELİ. "Top category" satırı Market'i başka bir bağlamda gösterebileceğinden,
  // yalnızca "±" işaretli (değişim yok) bir Market satırının YOKLUĞUNU doğruluyoruz.
  assert.doesNotMatch(r.html, /±/, 'delta===0 için "±" işaretli bir satır asla üretilmemeli');
});

// -----------------------------------------------------------------------
// CATCMP-08: mevcut değişmeyen satırlar (Gelir/Gider/Tasarruf/Borç-Varlık-Net değişimi/
// Top category) IP-8 sonrasında da AYNI şekilde render edilmeye devam etmeli (regresyon
// yok) — FAZ3.13-5'in "En iyi karar" metninin YOKLUĞU beklentisiyle de çakışmamalı.
// -----------------------------------------------------------------------
test('CATCMP-08: mevcut rapor satırları (Gelir/Gider/Tasarruf/Top category) değişmeden kalır', async () => {
  const { page, pageErrors } = await newSession();

  const r = await page.evaluate(() => {
    const mk = monthKey;
    const pmk = (() => {
      const [y, m] = mk.split('-').map(Number);
      const d = new Date(y, m - 2, 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    })();
    history.length = 0;
    history.push({ monthKey: pmk, income: 1000, expense: 500, totalDebt: 0, assets: 0, netWorth: 0, categoryBreakdown: { 'Market': 100 } });
    history.push({ monthKey: mk, income: 0, expense: 0, totalDebt: 0, assets: 0, netWorth: 0 });

    month.incomes = [{ id: 'i1', category: 'Maaş', amount: 2000, note: '', recurring: false, accountId: '' }];
    month.expenses = [
      { id: 'e1', category: 'Market', amount: 900, note: '', recurring: false, fixed: false, accountId: '', cardId: '' },
    ];
    renderMonthlyReport();
    const box = document.getElementById('monthlyReportBox');
    return { html: box ? box.innerHTML : null };
  });

  await page.close();
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  assert.match(r.html, /Gelir/, 'Gelir satırı hâlâ görünmeli');
  assert.match(r.html, /Gider/, 'Gider satırı hâlâ görünmeli');
  assert.match(r.html, /Tasarruf/, 'Tasarruf satırı hâlâ görünmeli');
  assert.match(r.html, /En çok harcanan/, 'Top category satırı hâlâ görünmeli');
  assert.doesNotMatch(r.html, /En iyi karar/, 'FAZ3.13-5 beklentisiyle çakışmamalı: "En iyi karar" metni burada olmamalı');
});
