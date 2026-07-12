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
| 7113 | 1.1 | Överskott av näringsverksamhet |
| 7114 | 1.2 | Underskott av näringsverksamhet |
| 7132 | 1.4 | Underlag för särskild löneskatt på pensionskostnader |
| 7133 | 1.5 | Negativt underlag särskild löneskatt |
| 7153 | 1.6a | Avkastningsskatt 15% |
| 7155 | 1.7a | Avkastningsskatt 30% |

Fields 7113/7114 correspond directly to INK2S fields 8020/8021.

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
| 8020 | 4.15 | Överskott → överförs till punkt 1.1 (INK2 field 7113) |
| 8021 | 4.16 | Underskott → överförs till punkt 1.2 (INK2 field 7114) |
| 7770 | 4.20 | Lån från aktieägare (fysisk person) vid beskattningsårets utgång |

**Critical**: INK2S codes are NOT auto-derived from BAS accounts. They represent tax adjustments requiring manual calculation. The bookkeeping result (årets resultat from INK2R) flows into 7650/7750, then adjustments produce 8020/8021.

---

<a id="bas-balance"></a>
## 6. BAS-to-SRU Mapping: Balance Sheet

Source: BAS-kontogruppen + Skatteverket joint mapping at bas.se/kontoplaner/sru/. Stable since 2017.

### Assets

| BAS accounts | → SRU | INK2R row | Description |
|---|---|---|---|
| 1010-1079, 1090-1099 | 7201 | 2.1 | Immateriella anläggningstillgångar |
| 1080-1089 | 7202 | 2.2 | Förskott immateriella |
| 1100-1119, 1130-1179, 1190-1199 | 7214 | 2.3 | Byggnader och mark |
| 1200-1299 (most) | 7215 | 2.4 | Maskiner och inventarier |
| 1120-1129 | 7216 | 2.5 | Förbättringsutgifter annans fastighet |
| 1180-1189 | 7217 | 2.6 | Pågående nyanläggningar |
| 1311-1316 | 7230 | 2.7 | Andelar koncernföretag |
| 1330-1338 | 7231 | 2.8 | Andelar intresseföretag |
| 1350-1359, 1380-1389 | 7233 | 2.9 | Ägarintressen övriga |
| 1320-1329, 1340-1349 | 7232 | 2.10 | Fordringar koncern/intresse |
| 1360-1369 | 7234 | 2.11 | Lån till delägare |
| 1370-1379, 1390-1399 | 7235 | 2.12 | Övriga långfristiga fordringar |
| 1410-1419 | 7241 | 2.13 | Råvaror |
| 1440-1449 | 7242 | 2.14 | Varor under tillverkning |
| 1450-1469 | 7243 | 2.15 | Färdiga varor |
| 1470-1489 | 7244 | 2.16 | Övriga lagertillgångar |
| 1490-1499 | 7245 | 2.17 | Pågående arbeten |
| 1400-1409 | 7246 | 2.18 | Förskott till leverantörer |
| 1500-1519 | 7251 | 2.19 | Kundfordringar |
| 1560-1579 | 7252 | 2.20 | Fordringar koncern/intresse (kortfristiga) |
| 1520-1559, 1580-1599, 1600-1699 | 7261 | 2.21 | Övriga fordringar |
| 1620 (specific) | 7262 | 2.22 | Upparbetad ej fakturerad |
| 1700-1799 | 7263 | 2.23 | Förutbetalda kostnader |
| 1860-1869 | 7270 | 2.24 | Kortfristiga andelar koncern |
| 1800-1859, 1870-1899 | 7271 | 2.25 | Övriga kortfristiga placeringar |
| 1900-1999 | 7281 | 2.26 | Kassa och bank |

### Equity & Liabilities

| BAS accounts | → SRU | INK2R row | Description |
|---|---|---|---|
| 2010-2089 | 7301 | 2.27 | Bundet eget kapital |
| 2090-2099 | 7302 | 2.28 | Fritt eget kapital |
| 2110-2129 | 7321 | 2.29 | Periodiseringsfonder |
| 2150-2159 | 7322 | 2.30 | Ackumulerade överavskrivningar |
| 2130-2149, 2160-2199 | 7323 | 2.31 | Övriga obeskattade reserver |
| 2210-2219 | 7331 | 2.32 | Pensionsavsättningar tryggandelagen |
| 2220-2229 | 7332 | 2.33 | Övriga pensionsavsättningar |
| 2230-2299 | 7333 | 2.34 | Övriga avsättningar |
| 2320-2329 | 7350 | 2.35 | Obligationslån |
| 2330-2339 | 7351 | 2.36 | Checkräkningskredit (långfristig) |
| 2340-2359 | 7352 | 2.37 | Övriga skulder kreditinstitut (långfristiga) |
| 2360-2379 | 7353 | 2.38 | Skulder koncern/intresse (långfristiga) |
| 2380-2399 | 7354 | 2.39 | Övriga skulder (långfristiga) |
| 2410-2419 | 7360 | 2.40 | Checkräkningskredit (kortfristig) |
| 2420-2439 | 7361 | 2.41 | Övriga skulder kreditinstitut (kortfristiga) |
| 2400-2409 | 7362 | 2.42 | Förskott från kunder |
| 2450-2459 | 7363 | 2.43 | Pågående arbeten (skuld) |
| 2460-2469 | 7364 | 2.44 | Fakturerad ej upparbetad |
| 2440-2449 | 7365 | 2.45 | Leverantörsskulder |
| 2490 | 7366 | 2.46 | Växelskulder |
| 2470-2479 | 7367 | 2.47 | Skulder koncern/intresse (kortfristiga) |
| 2480-2489, 2491-2499, 2600-2799, 2800-2899 | 7369 | 2.48 | Övriga skulder (kortfristiga) |
| 2500-2599 | 7368 | 2.49 | Skatteskulder |
| 2900-2999 | 7370 | 2.50 | Upplupna kostnader |

---

<a id="bas-income"></a>
## 7. BAS-to-SRU Mapping: Income Statement

**CRITICAL: BAS 5000-6999 ALL map to SRU 7513.** This is the single most common mapping error.

| BAS accounts | → SRU | INK2R row | Description |
|---|---|---|---|
| 3000-3799 | 7410 | 3.1 | Nettoomsättning |
| 3800-3899 | 7412 | 3.3 | Aktiverat arbete |
| 3900-3999 | 7413 | 3.4 | Övriga rörelseintäkter |
| 4900-4999 | 7411 | 3.2 | Förändring av lager |
| 4000-4499 | 7511 | 3.5 | Råvaror och förnödenheter |
| 4600-4699 | 7512 | 3.6 | Handelsvaror |
| **5000-6999** | **7513** | 3.7 | **Övriga externa kostnader (ALL accounts in range)** |
| 7000-7699 | 7514 | 3.8 | Personalkostnader |
| 7700-7799 | 7516 | 3.10 | Nedskrivningar omsättningstillgångar |
| 7800-7899 | 7515 | 3.9 | Avskrivningar |
| 7900-7999 | 7517 | 3.11 | Övriga rörelsekostnader |
| 8000-8099 | 7414 | 3.12 | Resultat koncernföretag |
| 8100-8199 | 7415 | 3.13 | Resultat intresseföretag |
| 8200-8269 | 7423 | 3.14 | Resultat övriga ägarintresse |
| 8270-8299 | 7416 | 3.15 | Övriga finansiella anläggningstillgångar |
| 8300-8399 | 7417 | 3.16 | Ränteintäkter |
| 8400-8499 | 7522 | 3.18 | Räntekostnader |
| 8500-8599 (nedskrivn.) | 7521 | 3.17 | Nedskrivningar finansiella |
| 8810 | 7524 | 3.19 | Lämnade koncernbidrag |
| 8820 | 7419 | 3.20 | Mottagna koncernbidrag |
| 8830 | 7420 | 3.21 | Återföring periodiseringsfond |
| 8840 | 7525 | 3.22 | Avsättning periodiseringsfond |
| 8850 | 7421 | 3.23 | Förändring överavskrivningar |
| 8860-8899 | 7422 | 3.24 | Övriga bokslutsdispositioner |
| 8900-8989 | 7528 | 3.25 | Skatt |
| 8999 (positive balance) | 7450 | 3.26 | Vinst |
| 8999 (negative balance) | 7550 | 3.27 | Förlust |

---

<a id="signs"></a>
## 8. Sign conventions for INK2R

The income statement rows on INK2R use a sign system tied to the physical form:

- **Revenue rows** (7410-7422): Report as the natural sign from accounting. Revenue positive, costs negative.
- **Cost rows** (7511-7528): Report as the natural sign. Costs are negative values.
- **7450 (vinst)**: Pre-printed as positive. Supply positive value if profit.
- **7550 (förlust)**: Pre-printed as negative. Supply positive value to indicate a loss; the minus is implicit in the row definition.

When in doubt: supply the signed value as it appears in the trial balance. The form's physical layout handles presentation.

**Balance sheet rows**: All amounts are positive (assets positive, equity/liabilities positive). A negative balance on a liability account indicates an error or special case.