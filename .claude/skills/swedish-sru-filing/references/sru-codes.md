# SRU Code Tables and BAS-to-SRU Mapping

Complete field code (fältkod) tables for INK2, INK2R, and INK2S blankett types, plus the BAS account to SRU code mapping for INK2R.

## Table of Contents

1. [INK2: Huvudblankett](#ink2)
2. [INK2R: Räkenskapsschema: Balance Sheet Assets](#ink2r-assets)
3. [INK2R: Räkenskapsschema: Balance Sheet Equity & Liabilities](#ink2r-equity)
4. [INK2R: Räkenskapsschema: Income Statement](#ink2r-income)
5. [INK2S: Skattemässiga justeringar](#ink2s)
6. [BAS-to-SRU Mapping: Balance Sheet](#bas-balance)
7. [BAS-to-SRU Mapping: Income Statement](#bas-income)
8. [Sign conventions](#signs)

---

<a id="ink2"></a>
## 1. INK2: Huvudblankett (main declaration, page 1)

| SRU | Row | Description |
|---|---|---|
| 7011 | N/A | Räkenskapsår fr.o.m. (YYYYMMDD) |
| 7012 | N/A | Räkenskapsår t.o.m. (YYYYMMDD) |
| 7104 | 1.1 | Överskott av näringsverksamhet |
| 7114 | 1.2 | Underskott av näringsverksamhet |
| 7132 | 1.4 | Underlag för särskild löneskatt på pensionskostnader |
| 7133 | 1.5 | Negativt underlag särskild löneskatt |
| 7153 | 1.6a | Avkastningsskatt 15% |
| 7155 | 1.7a | Avkastningsskatt 30% |

Fields 7104/7114 correspond directly to INK2S fields 8020/8021. (Verified against Skatteverket's official 2025P4 field list: 1.1 is 7104, NOT 7113; 7113 does not exist on INK2 and Skatteverket rejects it with "är inte ett giltigt postnamn".)

---

<a id="ink2r-assets"></a>
## 2. INK2R: Balance Sheet: Assets (Tillgångar)

| SRU | Row | Description |
|---|---|---|
| 7201 | 2.1 | Koncessioner, patent, licenser, varumärken, hyresrätter, goodwill |
| 7202 | 2.2 | Förskott avs. immateriella anläggningstillgångar |
| 7214 | 2.3 | Byggnader och mark |
| 7215 | 2.4 | Maskiner, inventarier, övriga materiella anläggningstillgångar |
| 7216 | 2.5 | Förbättringsutgifter på annans fastighet |
| 7217 | 2.6 | Pågående nyanläggningar, förskott materiella anläggningstillgångar |
| 7230 | 2.7 | Andelar i koncernföretag |
| 7231 | 2.8 | Andelar i intresseföretag och gemensamt styrda företag |
| 7233 | 2.9 | Ägarintressen i övriga företag + andra långfristiga värdepapper |
| 7232 | 2.10 | Fordringar hos koncern-/intresse-/gemensamt styrda företag |
| 7234 | 2.11 | Lån till delägare eller närstående |
| 7235 | 2.12 | Fordringar hos övriga företag med ägarintresse + andra långfristiga fordringar |
| 7241 | 2.13 | Råvaror och förnödenheter |
| 7242 | 2.14 | Varor under tillverkning |
| 7243 | 2.15 | Färdiga varor och handelsvaror |
| 7244 | 2.16 | Övriga lagertillgångar |
| 7245 | 2.17 | Pågående arbeten för annans räkning |
| 7246 | 2.18 | Förskott till leverantörer |
| 7251 | 2.19 | Kundfordringar |
| 7252 | 2.20 | Fordringar hos koncern-/intresse-/gemensamt styrda företag (kortfristiga) |
| 7261 | 2.21 | Fordringar hos övriga företag med ägarintresse + övriga fordringar |
| 7262 | 2.22 | Upparbetad men ej fakturerad intäkt |
| 7263 | 2.23 | Förutbetalda kostnader och upplupna intäkter |
| 7270 | 2.24 | Andelar i koncernföretag (kortfristiga) |
| 7271 | 2.25 | Övriga kortfristiga placeringar |
| 7281 | 2.26 | Kassa, bank och redovisningsmedel |

---

<a id="ink2r-equity"></a>
## 3. INK2R: Balance Sheet: Equity & Liabilities (Eget kapital och skulder)

| SRU | Row | Description |
|---|---|---|
| 7301 | 2.27 | Bundet eget kapital |
| 7302 | 2.28 | Fritt eget kapital |
| 7321 | 2.29 | Periodiseringsfonder |
| 7322 | 2.30 | Ackumulerade överavskrivningar |
| 7323 | 2.31 | Övriga obeskattade reserver |
| 7331 | 2.32 | Avsättningar för pensioner enl. tryggandelagen |
| 7332 | 2.33 | Övriga avsättningar för pensioner |
| 7333 | 2.34 | Övriga avsättningar |
| 7350 | 2.35 | Obligationslån |
| 7351 | 2.36 | Checkräkningskredit (långfristig) |
| 7352 | 2.37 | Övriga skulder till kreditinstitut (långfristiga) |
| 7353 | 2.38 | Skulder till koncern-/intresse-/gemensamt styrda företag (långfristiga) |
| 7354 | 2.39 | Skulder till övriga företag med ägarintresse + övriga skulder (långfristiga) |
| 7360 | 2.40 | Checkräkningskredit (kortfristig) |
| 7361 | 2.41 | Övriga skulder till kreditinstitut (kortfristiga) |
| 7362 | 2.42 | Förskott från kunder |
| 7363 | 2.43 | Pågående arbeten för annans räkning (skuldsida) |
| 7364 | 2.44 | Fakturerad men ej upparbetad intäkt |
| 7365 | 2.45 | Leverantörsskulder |
| 7366 | 2.46 | Växelskulder |
| 7367 | 2.47 | Skulder till koncern-/intresse-/gemensamt styrda företag (kortfristiga) |
| 7369 | 2.48 | Skulder till övriga företag med ägarintresse + övriga skulder (kortfristiga) |
| 7368 | 2.49 | Skatteskulder |
| 7370 | 2.50 | Upplupna kostnader och förutbetalda intäkter |

---

<a id="ink2r-income"></a>
## 4. INK2R: Income Statement (Resultaträkning)

| SRU | Row | Description | Sign |
|---|---|---|---|
| 7410 | 3.1 | Nettoomsättning | * |
| 7411 | 3.2 | Förändring av lager | * |
| 7412 | 3.3 | Aktiverat arbete för egen räkning | * |
| 7413 | 3.4 | Övriga rörelseintäkter | * |
| 7511 | 3.5 | Råvaror och förnödenheter | * |
| 7512 | 3.6 | Handelsvaror | * |
| 7513 | 3.7 | Övriga externa kostnader | * |
| 7514 | 3.8 | Personalkostnader | * |
| 7515 | 3.9 | Av- och nedskrivningar materiella/immateriella | * |
| 7516 | 3.10 | Nedskrivningar omsättningstillgångar | * |
| 7517 | 3.11 | Övriga rörelsekostnader | * |
| 7414 | 3.12 | Resultat från andelar i koncernföretag | * |
| 7415 | 3.13 | Resultat från andelar i intresseföretag | * |
| 7423 | 3.14 | Resultat från övriga företag med ägarintresse | * |
| 7416 | 3.15 | Resultat från övriga finansiella anläggningstillgångar | * |
| 7417 | 3.16 | Övriga ränteintäkter och liknande | * |
| 7521 | 3.17 | Nedskrivningar finansiella anläggningstillgångar | * |
| 7522 | 3.18 | Räntekostnader och liknande | * |
| 7524 | 3.19 | Lämnade koncernbidrag | * |
| 7419 | 3.20 | Mottagna koncernbidrag | * |
| 7420 | 3.21 | Återföring av periodiseringsfond | * |
| 7525 | 3.22 | Avsättning till periodiseringsfond | * |
| 7421 | 3.23 | Förändring av överavskrivningar | * |
| 7422 | 3.24 | Övriga bokslutsdispositioner | * |
| 7528 | 3.25 | Skatt på årets resultat | * |
| 7450 | 3.26 | Årets resultat, vinst | + |
| 7550 | 3.27 | Årets resultat, förlust | - |

**Sign convention (*)**: No pre-printed sign on form. Supply the sign as-is from the accounting. Costs are typically negative. **(+)**: Positive pre-printed; report positive for agreement. **(-)**: Negative pre-printed; report positive for agreement, negative to deviate.

---

<a id="ink2s"></a>
## 5. INK2S: Skattemässiga justeringar (tax adjustments, page 4)

| SRU | Row | Description |
|---|---|---|
| 7650 | 4.1 | Årets resultat, vinst |
| 7750 | 4.2 | Årets resultat, förlust |
| 7651 | 4.3a | Skatt på årets resultat (ej avdragsgill) |
| 7652 | 4.3b | Nedskrivning av finansiella tillgångar |
| 7653 | 4.3c | Andra bokförda kostnader som inte är avdragsgilla |
| 7751 | 4.4a | Lämnade koncernbidrag |
| 7764 | 4.4b | Andra ej bokförda kostnader som ska dras av |
| 7752 | 4.5a | Ackordsvinster (skattefria) |
| 7753 | 4.5b | Utdelning (skattefri) |
| 7754 | 4.5c | Andra bokförda intäkter som inte ska beskattas |
| 7654 | 4.6a | Schablonintäkt på periodiseringsfonder |
| 7668 | 4.6b | Schablonintäkt på fondandelar |
| 7655 | 4.6c | Mottagna koncernbidrag |
| 7656 | 4.6d | Uppräknat belopp vid återföring av periodiseringsfond |
| 7657 | 4.6e | Andra ej bokförda intäkter som ska beskattas |
| 7755 | 4.7a | Bokförd vinst vid avyttring av delägarrätter |
| 7756 | 4.7b | Bokförd förlust vid avyttring av delägarrätter |
| 7658 | 4.7e | Kapitalvinst för beskattningsåret |
| 7757 | 4.7f | Kapitalförlust som ska dras av |
| 7758 | 4.8a | Bokförd intäkt/vinst i handelsbolag |
| 7659 | 4.8b | Skattemässigt överskott enl. N3B |
| 7660 | 4.8c | Bokförd kostnad/förlust i handelsbolag |
| 7759 | 4.8d | Skattemässigt underskott enl. N3B |
| 7663 | 4.13 | Andra skattemässiga justeringar (catch-all) |
| 7763 | 4.14a | Outnyttjat underskott från föregående beskattningsår |
| 7664 | 4.14b | Reduktion av underskott (beloppsspärr/ackord) |
| 7670 | 4.14c | Reduktion pga koncernbidragsspärr/fusionsspärr |
| 8020 | 4.15 | Överskott → överförs till punkt 1.1 (INK2 field 7104) |
| 8021 | 4.16 | Underskott → överförs till punkt 1.2 (INK2 field 7114) |
| 7770 | 4.20 | Lån från aktieägare (fysisk person) vid beskattningsårets utgång |

**Critical**: INK2S codes are NOT auto-derived from BAS accounts. They represent tax adjustments requiring manual calculation. The bookkeeping result (årets resultat from INK2R) flows into 7650/7750, then adjustments produce 8020/8021.

---

<a id="bas-balance"></a>
## 6. BAS-to-SRU Mapping: Balance Sheet

Source: the official BAS kopplingstabell, bas.se `INK2_P1_intervall-241119.xlsx` (published 2024-11-19, newest as of 2026-09-11; INK2R form edition SKV2002-33). The same file is checked in as `lib/reports/ink2/official-ink2r-coupling.json` and pinned by `lib/reports/ink2/__tests__/official-coupling.test.ts`; the engine ranges live in `lib/reports/ink2/account-mappings.ts`. Account specs use the file spelling: `112x` = 1120-1129, `17xx` = 1700-1799.

| BAS accounts | SRU | INK2R row | Description |
|---|---|---|---|
| 1000-1087, 1089-1099 | 7201 | 2.1 | Koncessioner, patent, licenser, varumärken, hyresrätter, goodwill och liknande rättigheter |
| 1088 | 7202 | 2.2 | Förskott avseende immateriella anläggningstillgångar |
| 1100-1119, 1130-1179, 1190-1199 | 7214 | 2.3 | Byggnader och mark |
| 1200-1279, 1290-1299 | 7215 | 2.4 | Maskiner, inventarier och övriga materiella anläggningstillgångar |
| 112x | 7216 | 2.5 | Förbättringsutgifter på annans fastighet |
| 118x, 128x | 7217 | 2.6 | Pågående nyanläggningar och förskott avseende materiella anläggningstillgångar |
| 131x | 7230 | 2.7 | Andelar i koncernföretag |
| 1330-1335, 1338-1339 | 7231 | 2.8 | Andelar i intresseföretag och gemensamt styrda företag |
| 135x, 1336, 1337 | 7233 | 2.9 | Ägarintresse i övriga företag och andra långfristiga värdepappersinnehav |
| 132x, 1340-1345, 1348-1349 | 7232 | 2.10 | Fordringar hos koncern-, intresse- och gemensamt styrda företag |
| 136x | 7234 | 2.11 | Lån till delägare eller närstående |
| 137x, 138x, 1346, 1347 | 7235 | 2.12 | Fordringar hos övriga företag som det finns ett ett ägarintresse i och Andra långfristiga fordringar |
| 141x, 142x | 7241 | 2.13 | Råvaror och förnödenheter |
| 144x | 7242 | 2.14 | Varor under tillverkning |
| 145x, 146x | 7243 | 2.15 | Färdiga varor och handelsvaror |
| 149x | 7244 | 2.16 | Övriga lagertillgångar |
| 147x | 7245 | 2.17 | Pågående arbeten för annans räkning |
| 148x | 7246 | 2.18 | Förskott till leverantörer |
| 151x-155x, 158x | 7251 | 2.19 | Kundfordringar |
| 156x, 1570-1572, 1574-1579, 166x, 1671-1672, 1674-1679 | 7252 | 2.20 | Fordringar hos koncern-, intresse- och gemensamt styrda företag |
| 161x, 163x-165x, 168x-169x, 1573, 1673 | 7261 | 2.21 | Fordringar hos övriga företag som det finns ett ägarintresse i och Övriga fordringar |
| 162x | 7262 | 2.22 | Upparbetad men ej fakturerad intäkt |
| 17xx | 7263 | 2.23 | Förutbetalda kostnader och upplupna intäkter |
| 186x | 7270 | 2.24 | Andelar i koncernföretag |
| 1800-1859, 1870-1899 | 7271 | 2.25 | Övriga kortfristiga placeringar |
| 19xx | 7281 | 2.26 | Kassa, bank och redovisningsmedel |
| 208x | 7301 | 2.27 | Bundet eget kapital |
| 209x | 7302 | 2.28 | Fritt eget kapital |
| 211x-213x | 7321 | 2.29 | Periodiseringsfonder |
| 215x | 7322 | 2.30 | Ackumulerade överavskrivningar |
| 216x-219x | 7323 | 2.31 | Övriga obeskattade reserver |
| 221x | 7331 | 2.32 | Avsättningar för pensioner och liknande förpliktelser enligt lagen (1967:531) om tryggande av pensionsutfästelserr m.m. |
| 223x | 7332 | 2.33 | Övriga avsättningar för pensioner och liknande förpliktelser |
| 2220-2229, 2240-2299 | 7333 | 2.34 | Övriga avsättningar |
| 231x-232x | 7350 | 2.35 | Obligationslån |
| 233x | 7351 | 2.36 | Checkräkningskredit |
| 234x-235x | 7352 | 2.37 | Övriga skulder till kreditinstitut |
| 2360- 2372, 2374-2379 | 7353 | 2.38 | Skulder till koncern-, intresse- och gemensamt styrda företag |
| 238x-239x, 2373 | 7354 | 2.39 | Skulder till övriga företag som det finns ett ägarintresse i och övriga skulder |
| 248x | 7360 | 2.40 | Checkräkningskredit |
| 241x | 7361 | 2.41 | Övriga skulder till kreditinstitut |
| 242x | 7362 | 2.42 | Förskott från kunder |
| 243x | 7363 | 2.43 | Pågående arbeten för annans räkning |
| 245x | 7364 | 2.44 | Fakturerad men ej upparbetad intäkt |
| 244x | 7365 | 2.45 | Leverantörsskulder |
| 2492 | 7366 | 2.46 | Växelskulder |
| 2460-2472, 2474-2479, 2874-2879 | 7367 | 2.47 | Skulder till koncern-, intresse- och gemensamt styrda företag |
| 2490-2491, 2493-2499, 2600-2859, 2880-2899 | 7369 | 2.48 | Skulder till övriga företag som det finns ett ägarintresse i och Övriga skulder |
| 25xx | 7368 | 2.49 | Skatteskulder |
| 29xx | 7370 | 2.50 | Upplupna kostnader och förutbetalda intäkter |

Accounts the official file does not list but the engine maps on purpose: 2010-2079 (EF/HB equity) to 7301, 1670 to 7252, 2473 and 2860-2873 to 7367, 48xx to 7511.

<a id="bas-income"></a>
## 7. BAS-to-SRU Mapping: Income Statement

**5000-6999 ALL map to 7513.** 40xx-47xx is listed under both 7511 (råvaror) and 7512 (handelsvaror); the engine files 46xx as handelsvaror and the rest as råvaror. Rows marked "om netto -" have a plus box and a minus box on the form: the engine orients the post so positive means income and files a negative net as a positive amount in the minus-box field (`INK2R_SIGN_TWINS`).

| BAS accounts | SRU | INK2R row | Description |
|---|---|---|---|
| 30xx-37xx | 7410 | 3.1 | Nettoomsättning |
| 4900-4909, 4930-4959, 4970-4979, 4990-4999 (Om netto +) | 7411 / 7510 (om netto -) | 3.2 | Förändring av lager av produkter i arbete, färdiga varor och pågående arbete för annans räkning |
| 38xx | 7412 | 3.3 | Aktiverat arbete för egen räkning |
| 39xx | 7413 | 3.4 | Övriga rörelseintäkter |
| 40xx-47xx, 4910-4920 | 7511 | 3.5 | Råvaror och förnödenheter |
| 40xx-47xx, 496x, 498x | 7512 | 3.6 | Handelsvaror |
| 50xx-69xx | 7513 | 3.7 | Övriga externa kostnader |
| 70xx-76xx | 7514 | 3.8 | Personalkostnader |
| 7700-7739, 7750-7789, 7800-7899 | 7515 | 3.9 | Av- och nedskrivningar av materiella och immateriella anläggningstillgångar |
| 774x, 779x | 7516 | 3.10 | Nedskrivningar av omsättningstillgångar utöver normala nedskrivningar |
| 79xx | 7517 | 3.11 | Övriga rörelsekostnader |
| 8000-8069, 8090-8099 (Om netto +) | 7414 / 7518 (om netto -) | 3.12 | Resultat från andelar i koncernföretag |
| 8100-8112, 8114-8117, 8119-8122, 8124-8132, 8134-8169, 8190-8199 (Om netto +) | 7415 / 7519 (om netto -) | 3.13 | Resultat från andelar i intresseföretag och gemensamt styrda företag |
| 8113, 8118, 8123, 8133 (Om netto +) | 7423 / 7530 (om netto -) | 3.14 | Resultat från övriga företag som det finns ett ägarintresse i |
| 8200-8269, 8290-8299 (Om netto +) | 7416 / 7520 (om netto -) | 3.15 | Resultat från övriga anläggningstillgångar |
| 8300-8369, 8390-8399 | 7417 | 3.16 | Övriga ränteintäkter och liknande resultatposter |
| 807x, 808x, 817x, 818x, 827x, 828x, 837x, 838x | 7521 | 3.17 | Nedskrivningar av finansiella anläggningstillgångar och kortfristiga placeringar |
| 84xx | 7522 | 3.18 | Räntekostnader och liknande resultatposter |
| 883x | 7524 | 3.19 | Lämnade koncernbidrag |
| 882x | 7419 | 3.20 | Mottagna koncernbidrag |
| 8810 (Om netto +), 8819 | 7420 | 3.21 | Återföring av periodiseringsfond |
| 8810 (Om netto -), 8811 | 7525 | 3.22 | Avsättning till periodiseringsfond |
| 885x (Om netto +) | 7421 / 7526 (om netto -) | 3.23 | Förändring av överavskrivningar |
| 886x-889x (Om netto +) | 7422 / 7527 (om netto -) | 3.24 | Övriga bokslutsdispositioner |
| 8900-8989 | 7528 | 3.25 | Skatt på årets resultat |
| 899x | 7450 | 3.26 | Årets resultat, vinst (flyttas till p. 4.1)  (+) |

8810 (group account for periodiseringsfond) goes to 7420 when the net is a credit and 7525 when it is a debit; 8811 is always 7525 and 8819 always 7420. 899x is 7450 (vinst) or 7550 (förlust) by sign and is computed from the other rows, never read from the ledger.

<a id="signs"></a>
## 8. Sign conventions for INK2R

The income statement rows on INK2R use a sign system tied to the physical form:

- **Revenue rows** (7410-7422): Report as the natural sign from accounting. Revenue positive, costs negative.
- **Cost rows** (7511-7528): Report as the natural sign. Costs are negative values.
- **7450 (vinst)**: Pre-printed as positive. Supply positive value if profit.
- **7550 (förlust)**: Pre-printed as negative. Supply positive value to indicate a loss; the minus is implicit in the row definition.

When in doubt: supply the signed value as it appears in the trial balance. The form's physical layout handles presentation.

**Balance sheet rows**: All amounts are positive (assets positive, equity/liabilities positive). A negative balance on a liability account indicates an error or special case.