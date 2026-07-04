# ROT-fakturering enligt fakturamodellen: flöde och kontering

## Regelverk

- **IL 67 kap. 11-19 §§**: Skattereduktion för hushållsarbete; rotarbete definierat i 13 a §; undantag i 13 c §.
- **Lag (2009:194)** om förfarandet vid skattereduktion för hushållsarbete (HUSFL) §§ 4, 6, 7, 8, 11, 12.
- **Skatteverkets rättsliga vägledning** "Skattereduktion för rot- och rutarbete" https://www4.skatteverket.se/rattsligvagledning/edition/2024.4/339102.html
- **Krav på elektronisk betalning** sedan 2020-01-01 (67 kap. 19 § IL).

## Belopp och subventionsgrad 2025-2026

- Ordinarie tak: **50 000 kr/person/år** ROT (gemensamt utrymme med RUT på 75 000 kr, varav max 50 000 kr ROT).
- Ordinarie subventionsgrad: **30 % av arbetskostnaden**.
- Tillfällig höjning **50 %** under perioden **2025-05-12 till 2025-12-31** enligt prop. 2024/25:156 / FiU32. Avgörande är **betalningsdatum**, inte fakturadatum.
- Återgång till 30 % från 2026-01-01.

## Dokumentationskrav vid utbetalningsbegäran (9 § HUSFL)

- Utförarens organisationsnummer + F-skatt
- Köparens personnummer/samordningsnummer
- Fastighetsbeteckning (småhus) eller lägenhetsnummer + brf-organisationsnummer (bostadsrätt)
- Antal arbetade timmar
- Art av arbete
- Arbetskostnad och debiterad skattereduktion
- Datum för betalning

Begäran lämnas via Skatteverkets e-tjänst senast **31 januari** året efter betalningsåret (8 § HUSFL).

## Kompletterande verifikationsexempel (utöver SKILL.md)

**Förutsättning:** Måleriarbete i privatbostad. Arbete 30 000 kr ex moms. Material 5 000 kr ex moms. Moms 25 % på allt. Faktura ställs ut 2025-09-15 och betalas 2025-10-01 (omfattas av 50 %-perioden).

- Arbete: 30 000 × 1,25 = 37 500 kr brutto
- Material: 5 000 × 1,25 = 6 250 kr brutto
- ROT-grund: arbete brutto = 37 500 → reduktion 50 % = **18 750 kr** (ej över taket 50 000 kr/år)
- Kund betalar: 37 500 + 6 250 − 18 750 = **25 000 kr**
- Skatteverket utbetalar senare: 18 750 kr

**Vid fakturering (2025-09-15):**
- Debet **1511** Kundfordringar (kunddel) 25 000
- Debet **1513** Kundfordringar, delad faktura (ROT-del) 18 750
- Kredit **2611** Utgående moms 25 % 8 750
- Kredit **3011** Försäljning tjänster 25 % moms 30 000
- Kredit **3041** Försäljning varor 25 % moms 5 000

**Vid kundens betalning (2025-10-01):**
- Debet 1930 25 000 / Kredit 1511 25 000

**Vid Skatteverkets utbetalning (typiskt 2 veckor senare):**
- Debet 1930 18 750 / Kredit 1513 18 750

**Saldokontroll:** 1513 ska gå mot noll. Om Skatteverket vägrar (t.ex. tak överskridet eller köparen ej kvalificerad) → korrigeringsfaktura mot kund: Debet 1511 / Kredit 1513.

## Vanliga gränsfall (efter SKV vägledning)

- **Nybyggnation av småhus < 5 år:** Ger inte ROT.
- **Ekonomibyggnader (lantbrukstaxering):** Ger inte ROT.
- **Fritidshus som inte ägs av sökanden:** Ger inte ROT.
- **Bostadsrätt där annan än sökanden bor permanent:** Ger inte ROT.
- **Service/installation av maskiner och inventarier:** Ger inte ROT (67 kap. 13 c § IL).
- **Arbete där försäkringsersättning lämnats:** Ger inte ROT (SKV dnr 131 338276-10/111).
- **Material, frakt, maskinhyra, resor:** Aldrig ROT-grund: endast arbetskostnad.
- **UE utför arbetet:** OK om huvudutförare har F-skatt och faktiskt utfört uppdraget (skenavtal vägras, jfr HFD 2018 ref. 49).
- **Betalning kontant:** Inte ROT-grundande sedan 2020-01-01 (67 kap. 19 § IL).
- **Avgränsning mot grön teknik:** SRN 2023-07-19 dnr 83-22/D: ROT och grön teknik har separata utrymmen; arbete kan inte räknas dubbelt.
