// FAZ 3.14 IP-6 (remainingFixedEstimate duplicate temizliği):
// -----------------------------------------------------------------------------------------
// AUDIT BULGUSU (FULLBUDGET_YNAB_AUDIT.md, IP-6): render() ve answerHowMuchCanISpend() aynı
// "Math.max(0, lastMonthFixed - fixedSpent)" satırını BİREBİR iki kez elle yazıyordu —
// AYNI finansal gerçeğin iki ayrı kopyası, biri değişip diğeri unutulursa ekran (render) ile
// AI Coach (answerHowMuchCanISpend) birbirinden farklı "kalan zorunlu gider" sayısı
// söyleyebilirdi.
//
// Bu değişiklik YENİ bir hesaplama İCAT ETMİYOR: yalnızca bu iki satırlık saf hesaplamayı
// FINANCE-CORE bloğuna (computeCashFlowSummary/computeNetWorth'ün yanına) taşıyan,
// computeRemainingFixedEstimate({ lastMonthFixed, fixedSpent }) adlı üçüncü bir pure
// fonksiyon ekliyor. computeCashFlowSummary()'ye TEK SATIR dokunulmadı. "history" erişimi
// KASITLI OLARAK bu fonksiyonun dışında bırakıldı — her iki call-site de lastMonthFixed'i
// bugünkü gibi kendi yerinde hesaplıyor, yalnızca zaten hesaplanmış sayıyı helper'a veriyor.
//
// Bu dosya, index.html'in KENDİSİNDEN (FINANCE-CORE-START/END işaretleri arasından) canlı
// kaynak çıkararak çalışır — app/test/finance-core.test.mjs ile AYNI yöntem. Böylece test
// ettiğimiz kod gerçek uygulama kaynağıdır, elle kopyalanmış/çatallanmış bir mantık YOKTUR.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.join(__dirname, '..', 'index.html');
const html = readFileSync(indexPath, 'utf-8');

const START = '/* FINANCE-CORE-START */';
const END = '/* FINANCE-CORE-END */';
const startIdx = html.indexOf(START);
const endIdx = html.indexOf(END);

test('FINANCE-CORE bloğu index.html içinde bulunabiliyor (computeRemainingFixedEstimate dahil)', () => {
  assert.notEqual(startIdx, -1, 'FINANCE-CORE-START işareti index.html içinde bulunamadı');
  assert.notEqual(endIdx, -1, 'FINANCE-CORE-END işareti index.html içinde bulunamadı');
  assert.ok(endIdx > startIdx, 'FINANCE-CORE-END, FINANCE-CORE-START\'tan önce görünüyor');
});

const source = html.slice(startIdx + START.length, endIdx);

function loadFinanceCore() {
  const sandbox = { module: { exports: {} } };
  sandbox.exports = sandbox.module.exports;
  vm.createContext(sandbox);
  vm.runInContext(
    source + '\nmodule.exports = { computeCashFlowSummary, computeNetWorth, computeRemainingFixedEstimate };',
    sandbox,
    { filename: 'remaining-fixed-estimate-extracted.js' }
  );
  return sandbox.module.exports;
}

const { computeCashFlowSummary, computeRemainingFixedEstimate } = loadFinanceCore();

test('computeRemainingFixedEstimate index.html\'den (FINANCE-CORE bloğundan) yüklenebiliyor', () => {
  assert.equal(typeof computeRemainingFixedEstimate, 'function');
});

// -----------------------------------------------------------------------
// Ana matematiksel davranış: lastMonthFixed > fixedSpent -> doğru pozitif kalan.
// -----------------------------------------------------------------------
test('RFE-01: lastMonthFixed > fixedSpent -> pozitif kalan doğru hesaplanır', () => {
  const r = computeRemainingFixedEstimate({ lastMonthFixed: 5000, fixedSpent: 3200 });
  assert.equal(r, 1800);
});

// -----------------------------------------------------------------------
// RFE-02: fixedSpent === lastMonthFixed -> 0 (ne pozitif ne negatif).
// -----------------------------------------------------------------------
test('RFE-02: fixedSpent === lastMonthFixed -> 0 döner', () => {
  const r = computeRemainingFixedEstimate({ lastMonthFixed: 4000, fixedSpent: 4000 });
  assert.equal(r, 0);
});

// -----------------------------------------------------------------------
// RFE-03: fixedSpent > lastMonthFixed -> negatif değil, 0'a clamp edilir.
// -----------------------------------------------------------------------
test('RFE-03: fixedSpent > lastMonthFixed -> negatif dönmez, 0\'a clamp edilir', () => {
  const r = computeRemainingFixedEstimate({ lastMonthFixed: 1000, fixedSpent: 2500 });
  assert.equal(r, 0);
});

// -----------------------------------------------------------------------
// RFE-04: her iki girdi de 0 (ör. hiç geçmiş ay yok VE bu ay hiç sabit gider girilmemiş)
// -> 0 döner, hata/NaN/Infinity üretmez.
// -----------------------------------------------------------------------
test('RFE-04: lastMonthFixed=0 ve fixedSpent=0 -> 0 döner (0/0 durumu)', () => {
  const r = computeRemainingFixedEstimate({ lastMonthFixed: 0, fixedSpent: 0 });
  assert.equal(r, 0);
});

// -----------------------------------------------------------------------
// RFE-05: helper pure/deterministik — aynı girdiyle art arda çağrılınca hep aynı sonucu
// üretir ve girdi nesnelerini mutasyona uğratmaz (side-effect yok).
// -----------------------------------------------------------------------
test('RFE-05: computeRemainingFixedEstimate saf (pure) ve deterministiktir', () => {
  const input = { lastMonthFixed: 7500, fixedSpent: 2100 };
  const inputCopy = { ...input };
  const r1 = computeRemainingFixedEstimate(input);
  const r2 = computeRemainingFixedEstimate(input);
  const r3 = computeRemainingFixedEstimate({ ...input });
  assert.equal(r1, r2);
  assert.equal(r2, r3);
  assert.equal(r1, 5400);
  assert.deepEqual(input, inputCopy, 'helper girdi nesnesini mutasyona uğratmamalı');
});

// -----------------------------------------------------------------------
// RFE-06: eksik/undefined/geçersiz sayısal alanlar -> Number(...)||0 fallback'i ile
// güvenli davranır (crash yok, NaN sızmaz) — history[].fixedExpense alanı olmayan eski
// kayıtlarla besleniyormuş gibi simüle ediyor (call-site'lardaki "||0" fallback'iyle tutarlı).
// -----------------------------------------------------------------------
test('RFE-06: undefined/NaN girdilerde güvenli şekilde 0 varsayımına düşer', () => {
  assert.equal(computeRemainingFixedEstimate({ lastMonthFixed: undefined, fixedSpent: 1000 }), 0);
  assert.equal(computeRemainingFixedEstimate({ lastMonthFixed: 5000, fixedSpent: undefined }), 5000);
  assert.equal(computeRemainingFixedEstimate({ lastMonthFixed: NaN, fixedSpent: NaN }), 0);
  assert.equal(computeRemainingFixedEstimate({}), 0);
});

// -----------------------------------------------------------------------
// RFE-07: helper çıktısı, iki call-site'ta ESKİDEN elle yazılan formülle (Math.max(0,
// lastMonthFixed - fixedSpent)) matematiksel olarak BİREBİR aynı sonucu üretir — bir dizi
// rastgele-benzeri senaryo üzerinden karşılaştırılıyor.
// -----------------------------------------------------------------------
test('RFE-07: helper çıktısı eski elle-yazılmış formülle birebir eşdeğerdir (çoklu senaryo)', () => {
  const scenarios = [
    { lastMonthFixed: 12000, fixedSpent: 4500 },
    { lastMonthFixed: 0, fixedSpent: 0 },
    { lastMonthFixed: 300.5, fixedSpent: 300.5 },
    { lastMonthFixed: 999999, fixedSpent: 1 },
    { lastMonthFixed: 1, fixedSpent: 999999 },
    { lastMonthFixed: 250, fixedSpent: 0 },
    { lastMonthFixed: 0, fixedSpent: 250 },
  ];
  for (const s of scenarios) {
    const legacyFormula = Math.max(0, (Number(s.lastMonthFixed) || 0) - (Number(s.fixedSpent) || 0));
    const helperResult = computeRemainingFixedEstimate(s);
    assert.equal(helperResult, legacyFormula, `senaryo ${JSON.stringify(s)} için eşleşmedi`);
  }
});

// -----------------------------------------------------------------------
// RFE-08: helper'ın çıktısı, computeCashFlowSummary()'nin remainingFixedEstimate
// parametresine beslendiğinde, o fonksiyonun DAVRANIŞI/imzası hiç değişmemiş gibi doğru
// safeRemaining/safeDailySpend üretir (computeCashFlowSummary'nin KENDİSİNE dokunulmadığının
// dolaylı kanıtı — finance-core.test.mjs'deki mevcut senaryoyla aynı taban değerler).
// -----------------------------------------------------------------------
test('RFE-08: helper çıktısı computeCashFlowSummary\'ye beslendiğinde doğru safeRemaining üretir', () => {
  // finance-core.test.mjs'deki taban senaryo: income=110000, expenses=44067, debtPayments=0,
  // remainingDays=16 -> remaining=65933. Burada ek olarak lastMonthFixed=8000, fixedSpent=3000
  // -> remainingFixedEstimate=5000 -> safeRemaining = 65933 - 5000 = 60933.
  const remainingFixedEstimate = computeRemainingFixedEstimate({ lastMonthFixed: 8000, fixedSpent: 3000 });
  assert.equal(remainingFixedEstimate, 5000);
  const cf = computeCashFlowSummary({
    income: 110000, expenses: 44067, debtPayments: 0, remainingDays: 16, remainingFixedEstimate,
  });
  assert.equal(cf.remaining, 65933, 'computeCashFlowSummary\'nin remaining alanı DEĞİŞMEMİŞ olmalı');
  assert.equal(cf.safeRemaining, 60933, 'safeRemaining = remaining - remainingFixedEstimate olmalı');
});
