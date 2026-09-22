# Ek Audit Bulgusu: "Günün Güvenli Harcama Alanı" — Home'dan Kaldırma Kapsam Analizi

**Tarih:** 2026-09-21
**İncelenen taban:** `decision-engine-v1` dalı, commit `d153265` (final bundle `fullbudget-final-d153265.bundle` ile teslim edilen zincirin ucu)
**Durum:** SALT OKUNUR İNCELEME — hiçbir kod satırı değiştirilmedi, silinmedi, hiçbir özellik kaldırılmadı. `git status --short` yalnızca daha önce teslim edilen `FULLBUDGET_YNAB_AUDIT.md` dosyasını (izlenmeyen, önceki tur) gösteriyor; `app/index.html` ve `app/test/` tamamen dokunulmamış durumda.
**Onay durumu:** Bu belge yalnızca bulguları raporlar. Aşağıdaki "Onay Bekleyen Plan" bölümündeki hiçbir madde onayınız olmadan uygulanmayacak.

---

## 0. Önemli ön-netleştirme

Bu turun talebi özelliği "daha önce kaldırılmış" varsayımıyla geldi. Kod tabanını doğrudan inceledim: **özellik bugün Home ekranında tam olarak canlı, görünür ve çalışır durumda** — `data-section="ring"` bölümü (index.html:2761-2775), başlığı "Günün Güvenli Harcama Alanı", ring/daire görseli, `#dailyAmountNum`/`#dailyAmountLabel` ile günlük tutarı gösteriyor ve `render()` akışının bir parçası olarak her sayfa yüklemesinde hesaplanıyor (index.html:9444-9565). Ayrıca özel olarak bu özelliğin doğruluğunu doğrulayan yakın tarihli bir "FAZ 3.20" regresyon paketi var (`app/test/faz3-20-safe-spending-semantics.regression.test.mjs`, 12 test).

Bu, sizin "kaldırmayı değerlendiriyoruz" ifadenizle tutarlı (henüz kaldırılmadı, değerlendirme aşamasındasınız) — sadece bir önceki tur özetinde bu özelliğin "zaten kaldırılmış" gibi yansımış olabileceğini netleştirmek istedim, çünkü aşağıdaki tüm bulgular "canlı bir özelliği kaldırma" senaryosuna göre yazıldı.

---

## 1. Güncel Dosya / Fonksiyon Envanteri

Tüm referanslar `app/index.html` içinde (proje tek dosyalık bir mimariye sahip).

### 1.1 HTML / DOM
| Öğe | Satır |
|---|---|
| `<div class="reorder-section" data-section="ring">` — ana kapsayıcı bölüm | 2761 |
| Bölüm başlığı `<span data-i18n="bugunku-butce">Günün Güvenli Harcama Alanı</span>` | 2763 |
| `.hero` / `.ring-wrap` / SVG (`#ringProgress`) | 2764-2768 |
| `.ring-center` / `.ring-amount` / `#dailyAmountNum` / `#dailyAmountLabel` | 2769-2770 |
| `#heroSub` (durum metni: yükleniyor/gelir gir/bütçe bitti vb.) | 2772 |
| `.ring-note` (`data-i18n="ring-aylik-fark-not"`) — statik HTML fallback (bkz. 1.4'teki not: bu metin ölü/runtime'da hep ezilir) | 2773 |

### 1.2 CSS
`.hero` (180), `.ring-wrap` (+`:active`/svg) (188-190), `.ring-track` (191), `.ring-progress` (192), `.ring-center` (193), `.ring-amount` (+ `#dailyAmountNum`/`#dailyAmountLabel` alt kuralları) (194-196), `.hero-sub` (197-198), `.ring-note` (1110). Hepsi hâlâ kullanılıyor, ölü CSS yok.

### 1.3 JavaScript — hesaplama/render fonksiyonları
| Fonksiyon | Satır | Rol |
|---|---|---|
| `getCanonicalFreeSpendingPoolTL(allocationResult)` | 13157-13162 | GCAE sonucundaki `long_term_or_flexible` satırını okur |
| `computeSafeDailySpendTempo({freeSpendingPool, remainingDays})` | 13166-13170 | Saf fonksiyon: `freeSpendingPool / remainingDays` |
| Ring render bloğu (`_de2ForRing`, `_allocationForRing`, `freeSpendingPool`, `safeDaily`, DOM güncellemesi) | 9444-9565 | `render()` içinde tek çağrı noktası |
| `.ring-wrap` tıklama olayı → Gelir sekmesine geçiş | 19828 | Ring'e özgü navigasyon kısayolu |

### 1.4 i18n anahtarları
- `bugunku-butce` (dict: 4483) — bölüm başlığı, kullanımda.
- `ring-aylik-fark-not` (dict: 4478) — **ÖNEMLİ BULGU:** bu anahtarın SÖZLÜKTEKİ metni FAZ 3.20'de zaten değiştirilmiş ve artık "Bu Ayki Planım" ile karşılaştırma yapmıyor ("...kalan günlere yayarak hesaplanan yaklaşık günlük tempo... kullanmadığın tutar sonraki güne aktarılır"). HTML'deki statik fallback metin (2773. satır, hâlâ eski "aynı şey değildir" karşılaştırmasını içeriyor) `applyTranslations()` tarafından HER render'da eziliyor — yani kullanıcı hiçbir zaman o eski metni görmüyor. Ring kaldırılırsa bu ölü fallback de onunla birlikte gider, ekstra bir iş gerekmez.
- `s-bugun-harcanabilir` (dict: 4298, "Bugün harcayabileceğin") — kodda `data-i18n` ile hiçbir DOM öğesine bağlı değil; zaten ölü bir sözlük girdisi (Top-5 kutusundan FAZ 3.12'de kaldırılmış, gerekçesi "ring ve networth hero'da zaten var" — bkz. 3. bölüm).

### 1.5 Dead code (önceden bilinen, doğrulandı)
- `guncelleKararOzeti(plan, safeDaily, income)` (13428) — `safeDaily` parametresi gövdede hiç okunmuyor.
- `renderTop5(safeDaily, netWorth, monthlyCashFlow, priorityResult)` (15604) — `safeDaily` parametresi gövdede hiç okunmuyor.
- Her iki çağrı noktası da (9720, 9742) hesaplanan `safeDaily` değişkenini bu fonksiyonlara geçiriyor ama sessizce düşüyor.

---

## 2. Bağımlılık Analizi — "Günün Güvenli Harcama Alanı"

### 2.1 Core hesaplama motorları buna bağımlı mı?

**Hayır — doğrulandı, tek yönlü bağımlılık (ring → motor), motor → ring YÖNÜNDE hiçbir bağımlılık yok.**

`runDecisionEngineV2()` (12709-12853), `runGoalCashAllocationEngine()` (12948-13128), `buildMonthlySnapshot()` (12633-12690) ve `getAffordCapacityInfo()` (17366-17385) fonksiyonlarının TAM gövdelerini okudum: hiçbiri `computeSafeDailySpendTempo`/`getCanonicalFreeSpendingPoolTL`'i çağırmıyor, ring DOM öğelerine (`ringProgress`/`dailyAmountNum`/`dailyAmountLabel`/`heroSub`) referans vermiyor. Bu iki fonksiyonun dosya genelindeki TEK çağrı noktası ring render bloğu (9446-9457) ve `module.exports` satırları (13172-13173) — motor kodunun içinde hiç yok.

Veri akışı yönü (doğrulanmış):
```
runDecisionEngineV2() → runGoalCashAllocationEngine() → allocations[]
                                                            │
                                          (long_term_or_flexible satırı)
                                                            ▼
                                          getCanonicalFreeSpendingPoolTL()
                                                            ▼
                                          computeSafeDailySpendTempo() → ring DOM
```

Yani ring, motorun bir ÇIKTISINI okuyan bir TÜKETİCİ; motorun kendisi ring'in var olup olmadığından habersiz. **Ring tamamen kaldırılsa `runDecisionEngineV2()`/`runGoalCashAllocationEngine()`/Protected Liquidity/Distributable Cash hesaplamalarının SONUCU bir bit bile değişmez.**

### 2.2 Kaldırılırsa ne kırılır — etkilenen testler

Aşağıdaki test dosyaları ring'in VAR OLDUĞUNU/DOĞRU ÇALIŞTIĞINI doğruluyor; ring kaldırılırsa hepsi ya güncellenmeli ya da (ring'e özgü olanlar) tamamen kaldırılmalı:

| Dosya | Ring'e bağımlılığı |
|---|---|
| `faz3-20-safe-spending-semantics.regression.test.mjs` | **TAMAMEN ring'e özel** — 12 testin tümü `computeSafeDailySpendTempo`/`getCanonicalFreeSpendingPoolTL`/`#dailyAmountNum` doğruluyor. Ring gidince bu dosyanın TAMAMI anlamsız kalır. |
| `faz3-14-contextual-safety.regression.test.mjs` | `HOME_KEPT_SECTIONS` dizisi `'ring'`i Home'da kalması ZORUNLU 6 bölümden biri sayıyor (satır 95, 262'de kullanılıyor) — bu liste güncellenmeli, yoksa test kırılır. |
| `faz3-10-next-step-semantics.regression.test.mjs` | 244-260: `#dailyAmountNum`'ı okuyan bir izolasyon testi — DOM öğesi gidince kırılır. |
| `faz3-1-plan-clarity.regression.test.mjs` | 259-262: günlük/aylık ayrımını doğruluyor — güncellenmeli. |
| `faz3-3-next-step-alignment.regression.test.mjs` | 210-212: aynı ayrım koruması. |
| `faz3-4-stale-task-reconcile.regression.test.mjs` | 266-268: aynı ayrım koruması. |
| `faz3-5-home-simplify.regression.test.mjs` | 219-233: ring bölümünün VAR OLDUĞUNU doğrudan doğruluyor. |
| `faz3-6-plan-detail-simplify.regression.test.mjs` | 280-285: `#dailyAmountNum` okuyor. |
| `faz3-home-refactor.regression.test.mjs` | 179-181: ring/aylık plan ayrımını doğruluyor. |
| `emergency-allocation-override.regression.test.mjs` | 227-240: override sonrası ring'in doğru güncellendiğini `#dailyAmountNum` üzerinden doğruluyor. |
| `financial-truth.regression.test.mjs` | 158, 210, 226, 232, 472-502: `safeDailySpend===0` (açıkta) senaryosu + ring/AI-koç formül farkını belgeleyen özel test. |
| `finance-core.test.mjs` | 55-120: `computeCashFlowSummary()`'nin `safeDailySpend` alanını birim test ediyor — bu, ring'in DEĞİL, ayrı/legacy formülün testi (bkz. 2.3), ring kalksa bile KALMALI. |
| `state-normalization.test.mjs` | 148-153: `safeDailySpend`'i yalnızca örnek aritmetik olarak kullanıyor, fonksiyonel bağımlılık yok — etkilenmez. |

**Özet:** 1 test dosyası (faz3-20) tamamen anlamsızlaşır (silinmesi ya da başka bir amaca uyarlanması gerekir), 9 test dosyasında ring'e referans veren belirli test/satırların güncellenmesi/kaldırılması gerekir, 2 dosya etkilenmez.

### 2.3 Kritik ek bulgu: "güvenli günlük harcama" kavramı ring dışında da yaşıyor

Ring kaldırılsa bile kavramın kendisi UYGULAMADAN TAMAMEN gitmiyor — **AI Coach'un `answerHowMuchCanISpend()` fonksiyonu (14786-14811)**, ring'in kullandığı canonical zincirden (`computeSafeDailySpendTempo`/GCAE) **TAMAMEN BAĞIMSIZ, ayrı ve daha eski bir formül** kullanıyor: `computeCashFlowSummary()`'nin (9364-9381) ürettiği `.safeDailySpend` alanı (`income − harcama − sabit-gider-tahmini − borç ödemesi`, GCAE'siz ham nakit akışı). Bu iki formülün ZATEN kasıtlı olarak farklı olduğu kod içinde belgelenmiş (13137-13156, 14793-14799) ve `financial-truth.regression.test.mjs:472-502` bu farkı açıkça test ediyor ("iki formül de kendi içinde doğru ama birbirinden farklı, henüz hizalanmadı" — ayrı bir P1 bulgusu, bu turun kapsamı DIŞINDA, sadece netlik için not ediyorum).

**Sonuç:** Ring Home'dan kaldırılırsa, kullanıcı hâlâ AI Coach'a "bugün ne kadar harcayabilirim?" diye sorabilir ve BAŞKA bir formülden gelen bir cevap alır. Bu bir çelişki YARATMAZ (zaten iki ayrı, birbirinden bağımsız cevap mekanizması var) ama "özellik tamamen kaldırıldı" algısı yanlış olur — yalnızca Home'daki GÖRSEL/OTOMATİK gösterim kaldırılmış olur, AI Coach'taki soru-cevap mekanizması etkilenmez (istenirse o da ayrıca ele alınabilir, ama bu talebin kapsamında değil).

---

## 3. FAZ 3.13 "Ürün Sesi + UX Tutarlılığı" Bulguları

Dosyada `FAZ 3.13` etiketli 6 yorum bloğu bulundu (4648-4652, 8744-8747, 10217-10220, 10291-10292, 10591-10592, 12086-12089, 15446-15449). Bunlardan çıkan kural seti:
1. Projeksiyon/senaryo/tahmini sayılar asla canlı bir gerçekmiş gibi sunulmaz — açıkça "senaryo tahmini" etiketlenir.
2. Uygulama kişiselleştirilmiş tavsiye veriyormuş ya da kullanıcıyı yargılıyormuş gibi bir dil kullanılmaz.
3. İç jargon yerine sade/yerelleştirilmiş kelimeler kullanılır.
4. Benzer UI yüzeylerinde (ör. boş durumlar) TEK bir yapısal şablon kullanılır.

**Ring'in kaldırılması bu 4 kuraldan HİÇBİRİNİ ihlal etmiyor** — FAZ 3.13'ün 6 bulgusundan hiçbiri ring'e/"Günün Güvenli Harcama Alanı"na değinmiyor; tamamen ayrı, ilgisiz bir iyileştirme turu.

Ayrıca özellikle "ring kaldırılırsa sarkan/anlamsız kalan metin var mı?" sorusunu kontrol ettim:
- **`ring-note` statik HTML fallback'i (2773) zaten ölü** (bkz. 1.4) — ring gidince sorunsuz gider.
- **Canlı `ring-aylik-fark-not` sözlük metni** (4478, FAZ 3.20'de yazılmış) ARTIK "Bu Ayki Planım"a referans vermiyor — bu yüzden ring kaldırıldığında başka hiçbir kartın metnini güncellemek GEREKMİYOR.
- Dosya genelinde "aynı şey değildir / farklıdır / karıştırma" gibi karşılaştırma ifadeleri tarandı: ring'e referans veren TEK karşılaştırma zaten yukarıdaki ölü fallback. Diğer tüm "karşılaştırma" metinleri (net varlık/likidite rozeti, Top-5 kutusunun `monthlyCashFlow` vs `distributableCash` notu) ring'le İLGİSİZ, başka kartları karşılaştırıyor.
- **Tek gerçek belge/ürün-kararı notu:** Top-5 kutusundaki bir yorum (15601-15603, FAZ 3.12 — FAZ 3.13 değil) "Bugün harcayabileceğin" istatistiğinin o kutudan kaldırılma GEREKÇESİNİ ring'in varlığına dayandırıyor ("ikisi de zaten kendi kartlarında görünüyordu"). Bu, işlevsel bir bağımlılık DEĞİL, yalnızca eski bir yorum satırı — ring kalkarsa bu yorumun güncellenmesi (kod davranışı değil, sadece açıklama) gerekir, aksi halde yanıltıcı/güncel-olmayan bir kod yorumu olarak kalır.

### Ring'e bağlı tüm UI metinleri (kaldırma kapsamında ele alınacaklar)
| Metin | Yer |
|---|---|
| "Günün Güvenli Harcama Alanı" (bölüm başlığı) | 2763, dict 4483 |
| "bugünün tahmini güvenli harcama tempon" (statik fallback) | 2770 |
| "Bugünün Tahmini Güvenli Harcama Tempon" (JS ile yazılan) | ~9563 |
| "Başla / Gelirini Gir" (sıfır gelir durumu) | ~9561 |
| "Güvenli Bütçen Bitti" (tükenmiş durum) | ~9562 |
| "Bilgiler yükleniyor…" (`#heroSub` placeholder) | 2772 |
| Ring-note (ölü fallback + canlı sözlük metni) | 2773, dict 4478 |
| "Bugün harcayabileceğin" (`s-bugun-harcanabilir`, zaten ölü) | dict 4298 |

---

## 4. Risk Sınıflandırması

| # | Bulgu | Risk | Gerekçe |
|---|---|---|---|
| R1 | Core motorların (`runDecisionEngineV2`/`runGoalCashAllocationEngine`/Protected Liquidity/Distributable Cash) ring'e bağımlı OLMAMASI | **Bilgi (risk yok)** | Doğrulandı — kaldırma bu motorların matematiğini hiçbir şekilde etkilemez. |
| R2 | `faz3-20-safe-spending-semantics.regression.test.mjs`'in tamamının anlamsızlaşması | **P1 — planlama gerekli** | 12 test tek bir dosyada; silme/yeniden amaçlandırma kararı net onay gerektirir (testleri SİLMEME kuralınızla çelişmemesi için nasıl ele alınacağı ayrıca netleştirilmeli — bkz. Bölüm 5). |
| R3 | 9 test dosyasında ring'e referans veren tekil test/satırların güncellenmesi | **P1 — orta kapsam** | Her biri küçük ama toplamda geniş bir yüzey; tek tek gözden geçirilmeli. |
| R4 | `HOME_KEPT_SECTIONS` listesinin (`faz3-14`) güncellenmesi gerekliliği | **P1** | Home'un "korunan 6 bölüm" kuralı doğrudan etkileniyor — bu liste güncellenmezse test yanlış pozitif/negatif verebilir. |
| R5 | Ölü `safeDaily` parametreleri (`guncelleKararOzeti`, `renderTop5`) | **P2 — düşük** | Zaten okunmuyor; ring kalksa da kalsa da bağımsız, ayrı bir temizlik kararı. |
| R6 | AI Coach'un `answerHowMuchCanISpend()`'i ayrı/legacy formülle yaşamaya devam etmesi | **P2 — bilgilendirme** | Ring kaldırılsa da kullanıcı "bugün ne kadar harcayabilirim" diye sorabilir; kapsam dışı ama ürün algısı için not edildi. |
| R7 | FAZ 3.12 yorum satırının (15601-15603) güncel-olmayan hale gelmesi | **P2 — kozmetik** | Yalnızca kod içi açıklama, davranışı etkilemiyor. |
| R8 | i18n anahtarlarının (`bugunku-butce`, `ring-aylik-fark-not`) ölü kalması | **P2 — düşük** | Kullanılmayan sözlük girdisi, çalışmayı etkilemiyor, temizlik kapsamına eklenmeli. |

**Genel değerlendirme: kaldırma, core finansal hesaplamalar açısından RİSKSİZ (R1). Asıl iş yükü test bakımı (R2-R4) ve küçük metin/temizlik işleri (R5, R7, R8).**

---

## 5. Onay Bekleyen Plan (HENÜZ UYGULANMADI)

Aşağıdaki hiçbir madde bu rapor sırasında uygulanmadı. Onayınızdan sonra, önceki turlardaki gibi her biri ayrı, küçük, izole, testli, commit'li ve geri alınabilir bir bundle olarak teslim edilecek.

| # | Konu | Önerilen yaklaşım | Açık karar gerektiren nokta |
|---|---|---|---|
| RP-1 | Ring'in HTML/CSS/JS'ini Home'dan kaldırma | `data-section="ring"` bloğunu ve render bloğunu (9444-9565) kaldır; `computeSafeDailySpendTempo`/`getCanonicalFreeSpendingPoolTL` fonksiyonlarını (kullanılmayan hale gelirlerse) kaldır ya da bırak | **Sizin kararınız gerekiyor:** fonksiyonlar tamamen silinsin mi, yoksa ileride başka bir yüzeyde (ör. AI Coach) kullanılabilir diye kod olarak kalsın mı (yalnızca Home render çağrısı kaldırılsın)? |
| RP-2 | `faz3-20-safe-spending-semantics.regression.test.mjs`'in akıbeti | Seçenek A: dosyayı tamamen kaldır (12 test) — "artık test edilecek bir UI yok" gerekçesiyle. Seçenek B: dosyayı `computeSafeDailySpendTempo`/`getCanonicalFreeSpendingPoolTL`'in SAF fonksiyon testine indirger (DOM/Home testlerini çıkarır, yalnızca fonksiyon matematiğini korur) | **"Mevcut testleri silme" kuralınızla nasıl uzlaştırılacağı sizin onayınızı gerektiriyor** — bu kural muhtemelen "gereksiz yere/sonucu değiştirmek için silme" anlamındaydı, ama bir UI kaldırıldığında o UI'a özel testlerin akıbeti açık bir ürün kararı, otomatik varsaymıyorum. |
| RP-3 | 9 test dosyasındaki ring'e özel test/satırların güncellenmesi | Her dosyada yalnızca ring'e referans veren SPESİFİK assertion'lar kaldırılır/güncellenir; dosyanın geri kalanı (ring'siz kısımlar) dokunulmaz | Düşük risk, ama RP-1 onaylanmadan başlanamaz |
| RP-4 | `HOME_KEPT_SECTIONS` (faz3-14) güncellemesi | `'ring'`i listeden çıkar, Home'un yeni "korunan bölüm" sayısını (5 mi kalıyor?) yansıt | RP-1 ile birlikte, aynı bundle'da |
| RP-5 | Ölü `safeDaily` parametreleri (`guncelleKararOzeti`, `renderTop5`) temizliği | Parametreleri ve çağrı noktalarındaki (9720, 9742) argümanları kaldır | Bağımsız, RP-1'den ayrı bir küçük bundle olarak da yapılabilir — istediğiniz sırayı siz belirleyin |
| RP-6 | FAZ 3.12 yorum satırının (15601-15603) güncellenmesi | Yalnızca kod yorumu metni güncellenir, davranış değişmez | RP-1 ile birlikte |
| RP-7 | Ölü i18n anahtarları (`bugunku-butce`, `ring-aylik-fark-not`, `s-bugun-harcanabilir`) temizliği | Kullanılmayan sözlük girdilerini kaldır | Kozmetik, ayrı/isteğe bağlı |
| RP-8 | AI Coach'un `answerHowMuchCanISpend()`'i (bağımsız/legacy formül) | **Bu turun kapsamında DEĞİL** — sadece bilginize sunuluyor (R6). Dokunulmasını istiyorsanız ayrıca onaylamanız gerekir. | Kapsam dışı, sizin açık isteğinizi bekliyor |

**Kesinlikle uygulanmayan/önerilmeyen şeyler (talimatlarınıza uygun):** Home yeniden tasarımı yok, "Planlanabilir Tutar" merkezli yeni bir akış eklenmesi yok, yeni bir günlük harcama metriği icat edilmesi yok, core hesaplama motorlarına (`runDecisionEngineV2`/`runGoalCashAllocationEngine`/Protected Liquidity/Distributable Cash) hiçbir dokunuş önerilmiyor — bunların hiçbiri bu bulguda da, RP-1..RP-8'de de yer almıyor.

---

## 6. Doğrulama Notu

Bu rapor, bulguları doğrudan `app/index.html`'i okuyarak ve `grep -n` ile satır referanslarını teyit ederek hazırlandı (araştırma iki paralel alt-ajanla yürütüldü, kritik iddialar — motor bağımsızlığı, i18n metninin FAZ 3.20'de zaten değiştiği — tarafımca ayrıca tek tek doğrulandı). Hiçbir dosya değiştirilmedi; `git status --short` bunu teyit ediyor.
