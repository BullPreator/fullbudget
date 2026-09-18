// HEDEF (EV) — PEŞİNAT MODU İLERLEME/GAP DOĞRULUĞU — regresyon testleri
// -----------------------------------------------------------------------
// GERÇEK BULGU (manuel test): Ev hedefi, hedef fiyatı ₺5.000.000, güncel referans (enflasyona
// göre güncellenmiş) fiyatı ₺5.212.875, kullanıcının biriktirdiği ₺1.563.863 iken ekran
// "İlerleme: %100 / Eksik kalan: ₺0 / Hedefe zaten ulaştın" gösteriyordu — oysa ₺1.563.863,
// ₺5.000.000'un yalnızca ~%31.3'ü.
//
// KÖK NEDEN: "Ev" hedefleri VARSAYILAN olarak SADECE PEŞİNATI biriktirme modundadır
// (fullPriceInsteadOfDownPayment=false) — bu modda computeGoalInfo() içindeki neededTotal,
// evin TAM (enflasyona göre güncellenmiş) fiyatı DEĞİL, yalnızca o fiyatın downPaymentPct'i
// (varsayılan %30) kadardır. ₺1.563.863 tam olarak bu %30'luk peşinat hedefine denk geliyordu
// (₺5.212.875 × %30 ≈ ₺1.563.862,5) — yani gap=0/progress=%100 ARİTMETİK OLARAK DOĞRU (peşinat
// hedefine ulaşıldı), ama computeGoalInfo() bu ayrımı HİÇBİR ALANLA işaretlemiyordu, bu yüzden
// UI "Hedefe zaten ulaştın" derken evin TAMAMEN alınabilir olduğunu yanlış ima ediyordu.
//
// DÜZELTME: computeGoalInfo() artık `isDownPaymentGoal` alanını döndürüyor (neededTotal/gap/
// alreadySaved/pct'e DOKUNULMADI — mevcut finansal gerçeklik semantiği korundu). renderGoalList()
// bu alanı okuyup, peşinat modunda "Hedefe zaten ulaştın" yerine peşinat hedefine ulaşıldığını VE
// evin hâlâ tam fiyatta olduğunu açıkça belirten bir mesaj gösteriyor.
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

// Ortak temel: gelir/gider anlamsız, tek odak "ev" hedefinin kendisi. targetDate 6 ay sonrası ve
// %20 yıllık enflasyon varsayımıyla, hedef fiyatı enflasyona göre büyütülüyor (gerçek bulguyla
// AYNI mekanizma — kesin ₺5.212.875 rakamını yeniden üretmeye çalışmak yerine, aynı ORANSAL
// ilişkiyi -- "biriken tam olarak %30'luk peşinat hedefine eşit" -- yeniden kuruyoruz).
function setupHomeGoal(fullPriceMode) {
  const targetDate = (function () { const d = new Date(); d.setMonth(d.getMonth() + 6); return d.toISOString().slice(0, 10); })();
  persistent.accounts = [{ id: 'a1', name: 'Banka', type: 'Banka Hesabı', balance: 100000, currency: 'TRY' }];
  persistent.debts = []; persistent.creditCards = [];
  persistent.goals = [{
    id: 'gEv', typeKey: 'ev', referenceId: 'custom', targetAmount: 5000000, currentSaved: 0,
    targetDate, priceInflationPct: 20, downPaymentPct: 30,
    fullPriceInsteadOfDownPayment: !!fullPriceMode,
  }];
  persistent.dailyMoneyTask = null; persistent.cardPaymentLog = [];
  month.incomes = [{ id: 'i1', category: 'Maaş', amount: 40000 }];
  month.expenses = [{ id: 'e1', category: 'Diğer', amount: 10000, fixed: false }];
}

test('GOAL-1: varsayılan (peşinat) modda neededTotal, TAM fiyat değil, sadece downPaymentPct kadardır', async () => {
  const { page, pageErrors } = await newPage();
  const out = await page.evaluate((setupSrc) => {
    eval(setupSrc);
    render();
    const info = computeGoalInfo(persistent.goals[0]);
    return { info };
  }, `${setupHomeGoal.toString()}\nsetupHomeGoal(false);`);
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  const { info } = out;
  assert.equal(info.isDownPaymentGoal, true, 'varsayılan modda isDownPaymentGoal=true olmalı');
  assert.ok(info.inflatedPrice > info.basePrice, 'enflasyon uygulanmış olmalı (6 ay, %20 yıllık)');
  // neededTotal, inflatedPrice'ın TAMAMI değil, sadece %30'u olmalı — ±1 TL yuvarlama toleransı.
  const expectedDownPayment = info.inflatedPrice * 0.30;
  assert.ok(Math.abs(info.neededTotal - expectedDownPayment) < 1, `neededTotal (${info.neededTotal}) ~%30 peşinat (${expectedDownPayment}) olmalı`);
  assert.ok(info.neededTotal < info.inflatedPrice * 0.99, 'neededTotal, evin tam fiyatından ÇOK daha düşük olmalı (peşinat modu)');
  await page.close();
});

test('GOAL-2: TAM SENARYO — biriken tam olarak peşinat hedefine eşitken gap=0/progress=%100 (aritmetik olarak doğru) AMA evin tam fiyatına HENÜZ ulaşılmamış', async () => {
  const { page, pageErrors } = await newPage();
  const out = await page.evaluate((setupSrc) => {
    eval(setupSrc);
    render();
    // İlk geçiş: enflasyona göre güncellenmiş fiyatı ve ondan türeyen peşinat hedefini öğren.
    const preInfo = computeGoalInfo(persistent.goals[0]);
    // Gerçek bulgudaki gibi: kullanıcı, biriktirdiğini TAM OLARAK peşinat hedefine eşitliyor.
    persistent.goals[0].currentSaved = preInfo.neededTotal;
    render();
    const info = computeGoalInfo(persistent.goals[0]);
    const pct = info.neededTotal > 0 ? Math.min(100, (info.alreadySaved / info.neededTotal) * 100) : 0;
    return { info, pct };
  }, `${setupHomeGoal.toString()}\nsetupHomeGoal(false);`);
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  const { info, pct } = out;
  // Peşinat hedefine göre bu sonuçlar DOĞRU (finansal gerçeklik semantiği korunuyor, DEĞİŞMEDİ):
  assert.equal(info.gap, 0, 'peşinat hedefine tam ulaşıldığında gap=0 olmalı (down-payment semantiği)');
  assert.equal(Math.round(pct), 100, 'progress, peşinat hedefine göre %100 olmalı');
  // Ama bu ASLA "evin tamamı alındı" anlamına gelmemeli — bunu ayırt eden alan artık mevcut:
  assert.equal(info.isDownPaymentGoal, true);
  assert.ok(info.alreadySaved < info.inflatedPrice * 0.5, 'biriken tutar, evin tam fiyatının yarısından bile az olmalı — ev henüz alınabilir değil');
  await page.close();
});

test('GOAL-3: renderGoalList(), peşinat hedefine ulaşıldığında ARTIK yanıltıcı "Hedefe zaten ulaştın" YAZMAZ — peşinat/tam fiyat ayrımını açıkça belirtir', async () => {
  const { page, pageErrors } = await newPage();
  const out = await page.evaluate((setupSrc) => {
    eval(setupSrc);
    render();
    const preInfo = computeGoalInfo(persistent.goals[0]);
    persistent.goals[0].currentSaved = preInfo.neededTotal;
    render();
    const cardHtml = document.getElementById('goalList').innerHTML;
    return { cardHtml, inflatedPrice: computeGoalInfo(persistent.goals[0]).inflatedPrice };
  }, `${setupHomeGoal.toString()}\nsetupHomeGoal(false);`);
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  assert.ok(!out.cardHtml.includes('>Hedefe zaten ulaştın.'), 'peşinat modunda TAM/nitelenmemiş "Hedefe zaten ulaştın" mesajı ARTIK gösterilmemeli');
  assert.ok(out.cardHtml.includes('Peşinat hedefine ulaştın'), 'peşinat hedefine ulaşıldığını açıkça belirten yeni mesaj gösterilmeli');
  await page.close();
});

test('GOAL-4: "Tamamını biriktir" modunda (fullPriceInsteadOfDownPayment=true) sadece peşinat kadar biriktirmek YETERLİ SAYILMAZ (gap>0 kalmalı)', async () => {
  const { page, pageErrors } = await newPage();
  const out = await page.evaluate((setupSrc) => {
    eval(setupSrc);
    render();
    const preInfo = computeGoalInfo(persistent.goals[0]);
    // Yalnızca %30'luk peşinat kadar biriktirdi, ama bu hedef "tamamını biriktir" modunda.
    persistent.goals[0].currentSaved = preInfo.inflatedPrice * 0.30;
    render();
    const info = computeGoalInfo(persistent.goals[0]);
    return { info };
  }, `${setupHomeGoal.toString()}\nsetupHomeGoal(true);`);
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  const { info } = out;
  assert.equal(info.isDownPaymentGoal, false, '"Tamamını biriktir" modunda isDownPaymentGoal=false olmalı');
  assert.equal(info.neededTotal, info.inflatedPrice, 'bu modda neededTotal, evin TAM fiyatına eşit olmalı');
  assert.ok(info.gap > 0, 'sadece peşinat kadar biriktirmek, "tamamını biriktir" modunda hedefi TAMAMLAMAMALI');
  await page.close();
});

test('GOAL-5: "Tamamını biriktir" modunda evin TAM fiyatına gerçekten ulaşılınca özgün "Hedefe zaten ulaştın" mesajı DOĞRU şekilde gösterilir', async () => {
  const { page, pageErrors } = await newPage();
  const out = await page.evaluate((setupSrc) => {
    eval(setupSrc);
    render();
    const preInfo = computeGoalInfo(persistent.goals[0]);
    persistent.goals[0].currentSaved = preInfo.inflatedPrice; // evin TAM fiyatı kadar birikti
    render();
    const cardHtml = document.getElementById('goalList').innerHTML;
    const info = computeGoalInfo(persistent.goals[0]);
    return { cardHtml, info };
  }, `${setupHomeGoal.toString()}\nsetupHomeGoal(true);`);
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  assert.equal(out.info.gap, 0);
  assert.equal(out.info.isDownPaymentGoal, false);
  assert.ok(out.cardHtml.includes('>Hedefe zaten ulaştın.'), 'evin TAMAMI biriktiğinde özgün "Hedefe zaten ulaştın" mesajı doğru şekilde kullanılmalı (bu artık YANLIŞ değil)');
  await page.close();
});

test('GOAL-6: computeGoalInfo() diğer hedef türlerinde isDownPaymentGoal=false döner (yeni alan ev dışına sızmaz)', async () => {
  const { page, pageErrors } = await newPage();
  const out = await page.evaluate(() => {
    persistent.accounts = [{ id: 'a1', name: 'Banka', type: 'Banka Hesabı', balance: 100000, currency: 'TRY' }];
    persistent.debts = []; persistent.creditCards = [];
    persistent.goals = [{ id: 'gTel', typeKey: 'telefon', targetAmount: 50000, currentSaved: 50000, targetDate: '' }];
    persistent.dailyMoneyTask = null; persistent.cardPaymentLog = [];
    month.incomes = [{ id: 'i1', category: 'Maaş', amount: 40000 }];
    month.expenses = [];
    render();
    const info = computeGoalInfo(persistent.goals[0]);
    return { info, cardHtml: document.getElementById('goalList').innerHTML };
  });
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
  assert.equal(out.info.isDownPaymentGoal, false, 'ev dışındaki türlerde isDownPaymentGoal=false olmalı');
  assert.ok(out.cardHtml.includes('>Hedefe zaten ulaştın.'), 'ev dışındaki türlerde özgün mesaj DEĞİŞMEDEN çalışmaya devam etmeli');
  await page.close();
});
