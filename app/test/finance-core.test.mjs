// FINANCE-CORE testleri
// -----------------------------------------------------------------------
// Amaç: "varlık (net worth kalemi)" ile "aylık nakit akışı" hesaplarının
// KESİN olarak ayrı olduğunu, gerçek uygulama kaynağından (app/index.html)
// otomatik olarak doğrulamak.
//
// Yöntem: index.html tek parça bir HTML/JS dosyası olduğu ve derleme/modül
// sistemi olmadığı için, bu testler DEVASA script'i baştan sona çalıştırmak
// yerine (DOM'a bağımlı yüzlerce satır içerir) yalnızca ilgili fonksiyonları
// index.html içindeki
//     /* FINANCE-CORE-START */ ... /* FINANCE-CORE-END */
// işaretleri arasından çıkarıp gerçek bir Node vm bağlamında çalıştırır.
// Böylece test ettiğimiz kod, uygulamanın GERÇEK kaynak dosyasıdır — testler
// için ayrıca elle kopyalanmış/çatallanmış bir mantık YOKTUR; index.html
// değişirse (ör. formül kazayla bozulursa) bu testler de onu yakalar.
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

test('FINANCE-CORE bloğu index.html içinde bulunabiliyor', () => {
  assert.notEqual(startIdx, -1, 'FINANCE-CORE-START işareti index.html içinde bulunamadı');
  assert.notEqual(endIdx, -1, 'FINANCE-CORE-END işareti index.html içinde bulunamadı');
  assert.ok(endIdx > startIdx, 'FINANCE-CORE-END, FINANCE-CORE-START\'tan önce görünüyor');
});

const source = html.slice(startIdx + START.length, endIdx);

function loadFinanceCore() {
  const sandbox = { module: { exports: {} } };
  sandbox.exports = sandbox.module.exports;
  vm.createContext(sandbox);
  vm.runInContext(source + '\nmodule.exports = { computeCashFlowSummary, computeNetWorth };', sandbox, {
    filename: 'finance-core-extracted.js',
  });
  return sandbox.module.exports;
}

const { computeCashFlowSummary, computeNetWorth } = loadFinanceCore();

test('computeCashFlowSummary ve computeNetWorth index.html\'den yüklenebiliyor', () => {
  assert.equal(typeof computeCashFlowSummary, 'function');
  assert.equal(typeof computeNetWorth, 'function');
});

// ---------------------------------------------------------------------
// Kullanıcının verdiği asıl test senaryosu:
//   income=110000, expenses=44067, debtPayments=0, remainingDays=16,
//   assets=500000
// Beklenen:
//   remaining=65933, savingsRate≈59.94, safeDailySpend≈4120.81,
//   netWorth=500000 (borç girilmediği için totalDebt=0 varsayıldı)
// ---------------------------------------------------------------------
test('senaryo: gelir=110000, gider=44067, borç ödemesi=0, kalan gün=16, varlık=500000', () => {
  const income = 110000;
  const expenses = 44067;
  const debtPayments = 0;
  const remainingDays = 16;
  const assets = 500000;

  const cashFlow = computeCashFlowSummary({ income, expenses, debtPayments, remainingDays });
  const netWorth = computeNetWorth({ assets, totalDebt: 0 });

  assert.equal(cashFlow.remaining, 65933, 'Aylık kalan yanlış');
  assert.ok(
    Math.abs(cashFlow.savingsRate - 59.94) < 0.01,
    `Tasarruf oranı yanlış: ${cashFlow.savingsRate}`
  );
  assert.ok(
    Math.abs(cashFlow.safeDailySpend - 4120.8125) < 0.01,
    `Günlük güvenli harcama yanlış: ${cashFlow.safeDailySpend}`
  );
  assert.equal(netWorth, 500000, 'Net varlık yanlış');
});

test('500.000 TL varlık, aylık kalan/tasarruf oranı/günlük harcamaya HİÇ karışmıyor', () => {
  const base = { income: 110000, expenses: 44067, debtPayments: 0, remainingDays: 16 };
  const withoutAssets = computeCashFlowSummary(base);

  // computeCashFlowSummary'nin imzasında "assets" parametresi YOK; buna rağmen biri
  // yanlışlıkla ekstra bir alanla çağırsa bile (ör. gelecekte bir refactor sırasında)
  // sonuç DEĞİŞMEMELİ — fonksiyon assets alanını okumuyor.
  const withIgnoredAssets = computeCashFlowSummary({ ...base, assets: 500000, netWorth: 500000 });

  assert.deepEqual(withIgnoredAssets, withoutAssets,
    'computeCashFlowSummary çıktısı, tanımadığı "assets" alanından etkilenmemeli');
  assert.equal(withoutAssets.remaining, 65933);
});

test('computeNetWorth SADECE varlık ve borçtan hesaplanıyor, gelir/gider parametresi kabul etmiyor', () => {
  const netWorth = computeNetWorth({ assets: 500000, totalDebt: 0 });
  assert.equal(netWorth, 500000);
  // computeNetWorth'e income/expenses geçirilse bile göz ardı edilmeli (imzasında yok).
  const netWorth2 = computeNetWorth({ assets: 500000, totalDebt: 0, income: 999999, expenses: 999999 });
  assert.equal(netWorth2, 500000, 'computeNetWorth income/expenses alanlarını yanlışlıkla kullanmamalı');
});

test('gelir sıfırsa tasarruf oranı 0 döner (bölme hatası yok)', () => {
  const cashFlow = computeCashFlowSummary({ income: 0, expenses: 0, debtPayments: 0, remainingDays: 16 });
  assert.equal(cashFlow.savingsRate, 0);
  assert.equal(cashFlow.safeDailySpend, 0);
});

test('kalan negatifse (açık varsa) günlük güvenli harcama 0 döner, negatif gösterilmez', () => {
  const cashFlow = computeCashFlowSummary({ income: 10000, expenses: 20000, debtPayments: 0, remainingDays: 10 });
  assert.equal(cashFlow.remaining, -10000);
  assert.equal(cashFlow.safeDailySpend, 0);
});

test('borç ödemesi de nakit akışından düşülüyor', () => {
  const cashFlow = computeCashFlowSummary({ income: 110000, expenses: 44067, debtPayments: 20000, remainingDays: 16 });
  assert.equal(cashFlow.remaining, 45933);
});
