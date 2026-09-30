# BAS Kontoplan Reference

The BAS kontoplan is the de facto standard chart of accounts for Swedish companies. Published by BAS-intressenternas förening. Not legally mandated, but universally used and expected by auditors, Skatteverket, and accounting systems.

## Table of Contents
1. Structure overview
2. Account classes (1-8)
3. Common accounts for SMEs/startups
4. Moms accounts
5. Mapping rules and principles
6. BAS account numbering conventions

---

## 1. Structure overview

BAS uses a 4-digit account numbering system organized into 8 classes:

| Class | Range | Name | Type |
|---|---|---|---|
| 1 | 1000-1999 | Tillgångar | Balance sheet (debit) |
| 2 | 2000-2999 | Eget kapital och skulder | Balance sheet (credit) |
| 3 | 3000-3999 | Rörelsens intäkter | Income statement (credit) |
| 4 | 4000-4999 | Kostnader för varor och material | Income statement (debit) |
| 5 | 5000-5999 | Övriga externa kostnader | Income statement (debit) |
| 6 | 6000-6999 | Övriga externa kostnader (cont.) | Income statement (debit) |
| 7 | 7000-7999 | Personal, avskrivningar, nedskrivningar | Income statement (debit) |
| 8 | 8000-8999 | Finansiella poster, bokslutsdispositioner, skatt | Income statement |

## 2. Account classes detail

### Klass 1: Tillgångar
- **10xx**: Immateriella anläggningstillgångar (patents, goodwill)
- **11xx**: Byggnader och mark
- **12xx**: Maskiner och inventarier
- **13xx**: Finansiella anläggningstillgångar (aktier, långfristiga fordringar)
- **14xx**: Varulager
- **15xx**: Kundfordringar
- **16xx**: Övriga kortfristiga fordringar (momsfordran, förskott)
- **17xx**: Förutbetalda kostnader och upplupna intäkter
- **18xx**: Kortfristiga placeringar
- **19xx**: Kassa och bank

### Klass 2: Eget kapital och skulder
- **20xx**: Eget kapital (aktiekapital, balanserat resultat, årets resultat)
- **21xx**: Obeskattade reserver
- **22xx**: Avsättningar
- **23xx**: Långfristiga skulder (banklån)
- **24xx**: Kortfristiga skulder till kreditinstitut
- **25xx**: Skatteskulder
- **26xx**: Momsskulder (utgående/ingående moms)
- **27xx**: Personalens skatter och avgifter
- **28xx**: Övriga kortfristiga skulder
- **29xx**: Upplupna kostnader och förutbetalda intäkter

### Klass 3: Rörelsens intäkter
- **30xx**: Huvudintäkter (försäljning varor/tjänster)
- **31xx-34xx**: Further breakdown of sales by type
- **35xx**: Fakturerade kostnader
- **36xx**: Rörelsens sidointäkter
- **37xx**: Intäktskorrigeringar (rabatter, returer)
- **38xx**: Aktiverat arbete för egen räkning
- **39xx**: Övriga rörelseintäkter (BAS 3960 = Valutakursvinster på fordringar och skulder av rörelsekaraktär)

### Klass 4: Material och varor
BAS 2026 splits class 4 between handelsvaror and råvaror och förnödenheter:
- **40xx**: Inköp av handelsvaror (BAS 4010 = Inköp av handelsvaror i Sverige)
- **42xx**: Sålda handelsvaror VMB
- **43xx**: Inköp av råvaror och material i Sverige
- **44xx**: Inköp av råvaror och material, tjänster m.m. i Sverige, omvänd betalningsskyldighet
- **45xx**: Inköp av råvaror och material, tjänster m.m. från utlandet (EU-förvärv, import)
- **46xx**: Inköp av tjänster, underentreprenader och legoarbeten i Sverige
- **47xx**: Reduktion av inköpspriser
- **48xx**: Andra produktionskostnader (energi, drivmedel, resor, hyra av utrustning)
- **49xx**: Förändring av lager, produkter i arbete och pågående arbeten

### Klass 5-6: Övriga externa kostnader
- **50xx**: Lokalkostnader (hyra, el, värme)
- **51xx**: Fastighetskostnader
- **52xx**: Hyra av anläggningstillgångar
- **53xx**: Energikostnader för drift (ej råvaror och förnödenheter)
- **54xx**: Förbrukningsinventarier
- **55xx**: Reparation och underhåll
- **56xx**: Transportkostnader
- **57xx**: Frakt och transporter
- **58xx**: Resekostnader
- **59xx**: Reklam och PR
- **60xx**: Övriga försäljningskostnader
- **61xx**: Kontorsmaterial
- **62xx**: Tele och post
- **63xx**: Företagsförsäkringar
- **64xx**: Förvaltningskostnader
- **65xx**: Övriga externa tjänster
- **67xx**: Särskilt för ideella föreningar och stiftelser
- **68xx**: Inhyrd personal
- **69xx**: Övriga externa kostnader

### Klass 7: Personal, avskrivningar
- **70xx**: Löner till kollektivanställda
- **72xx**: Löner till tjänstemän och företagsledare (BAS 7210 = Löner tjänstemän)
- **73xx**: Kostnadsersättningar (traktamenten, bilersättning)
- **74xx**: Pensionskostnader
- **75xx**: Sociala avgifter (BAS 7510 = Arbetsgivaravgifter)
- **76xx**: Övriga personalkostnader (utbildning, friskvård)
- **77xx**: Nedskrivningar och återföring av nedskrivningar
- **78xx**: Avskrivningar enligt plan (BAS 7832 = Avskrivningar på inventarier, verktyg och installationer)
- **79xx**: Övriga rörelsekostnader

### Klass 8: Finansiella poster, bokslutsdispositioner
- **80xx**: Resultat från andelar i koncernföretag
- **81xx**: Resultat från andelar i intresseföretag
- **82xx**: Resultat från övriga värdepapper
- **83xx**: Ränteintäkter
- **84xx**: Räntekostnader
- **85xx-87xx**: Not used (no kontogrupper defined in BAS)
- **88xx**: Bokslutsdispositioner (överavskrivningar, periodiseringsfonder)
- **89xx**: Skatter (inkomstskatt, årets skatt)
- **8999**: Årets resultat

## 3. Common accounts for SMEs/startups

Most small AB/enskild firma need these accounts at minimum:

**Tillgångar:**
- 1510 Kundfordringar
- 1630 Skattekonto (avräkning Skatteverket)
- 1710 Förutbetalda hyreskostnader
- 1910 Kassa
- 1920 PlusGiro
- 1930 Företagskonto bank
- 1940 Sparkonto bank

**Skulder & EK:**
- 2010 Eget kapital (enskild firma) or 2081 Aktiekapital
- 2091 Balanserad vinst/förlust
- 2099 Årets resultat
- 2440 Leverantörsskulder
- 2610 Utgående moms 25 % (gruppkonto)
- 2611 Utgående moms 25 % försäljning inom Sverige
- 2620 Utgående moms 12 % (gruppkonto)
- 2621 Utgående moms 12 % försäljning inom Sverige
- 2630 Utgående moms 6 % (gruppkonto)
- 2631 Utgående moms 6 % försäljning inom Sverige
- 2640 Ingående moms
- 2650 Redovisningskonto för moms
- 2710 Personalskatt
- 2730 Arbetsgivaravgifter skuld
- 2920 Upplupna semesterlöner
- 2990 Övriga upplupna kostnader

**Intäkter:**
- 3000 or 3010 Försäljning tjänster (or varor)
- 3740 Öres- och kronutjämning

**Kostnader:**
- 4010 Inköp av handelsvaror i Sverige (BAS 2026; råvaror och material: 4310)
- 5010 Lokalhyra
- 5410 Förbrukningsinventarier
- 6110 Kontorsmaterial
- 6212 Mobiltelefoni
- 6230 Datakommunikation
- 6250 Postbefordran
- 6530 Redovisningstjänster
- 6540 IT-tjänster
- 6570 Bankkostnader
- 7010 or 7210 Löner
- 7510 Arbetsgivaravgifter
- 7832 Avskrivningar på inventarier, verktyg och installationer

**Finansiellt:**
- 8310 Ränteintäkter
- 8410 Räntekostnader
- 8910 Skatt

## 4. Moms accounts

Standard moms account structure in BAS 2024 (per bas.se):

| Konto | Beskrivning | Sats |
|---|---|---|
| 2610 | Utgående moms (gruppkonto / 25 %) | 25 % |
| 2611 | Utgående moms 25 % försäljning inom Sverige | 25 % |
| 2612 | Utgående moms 25 % egna uttag | 25 % |
| 2614 | Utgående moms 25 % omvänd skattskyldighet | 25 % (reverse) |
| 2615 | Utgående moms 25 % import | 25 % (import) |
| 2620 | Utgående moms (gruppkonto / 12 %) | 12 % |
| 2621 | Utgående moms 12 % försäljning inom Sverige | 12 % |
| 2624 | Utgående moms 12 % omvänd skattskyldighet | 12 % (reverse) |
| 2630 | Utgående moms (gruppkonto / 6 %) | 6 % |
| 2631 | Utgående moms 6 % försäljning inom Sverige | 6 % |
| 2634 | Utgående moms 6 % omvänd skattskyldighet | 6 % (reverse) |
| 2640 | Ingående moms | (avdrag) |
| 2645 | Beräknad ingående moms vid förvärv EU | (avdrag) |
| 2650 | Redovisningskonto för moms | (avstämning) |

Workflow:
1. During the period: utgående bokförs på 2611 (25 %) / 2621 (12 %) / 2631 (6 %); ingående på 2640
2. At declaration: netta 2611+2621+2631-2640 against 2650
3. Payment to/from Skatteverket: 2650 <-> 1630 (skattekonto)

**From 1 Apr 2026**: livsmedel-momsen sänks från 12 % till 6 %: försäljning av livsmedel flyttas från **2621 (12 %)** till **2631 (6 %)** (intäkt 3002 → 3003; EU-förvärv 2624 → 2634 och 4516 → 4517; import 2625 → 2635). Systemet måste hantera övergången baserat på leveransdatum.

## 5. Mapping rules and principles

### Debit and credit conventions
- Tillgångar (klass 1): increase = debit, decrease = credit
- Skulder & EK (klass 2): increase = credit, decrease = debit
- Intäkter (klass 3): increase = credit (booking revenue)
- Kostnader (klass 4-7): increase = debit
- Finansiella poster (klass 8): depends on type

### Standard transaction patterns

**Kundfaktura:**
- Debit 1510 (kundfordringar) full amount inkl moms
- Credit 30xx (intäkt) exkl moms
- Credit 2611 (25 %) / 2621 (12 %) / 2631 (6 %) (utgående moms)

**Leverantörsfaktura:**
- Debit 4xxx/5xxx/6xxx (kostnad) exkl moms
- Debit 2640 (ingående moms)
- Credit 2440 (leverantörsskulder) full amount inkl moms

**Löneutbetalning:**
- Debit 7210 (lön) brutto
- Credit 2710 (personalskatt)
- Credit 1930 (bank) nettolön
Then separately:
- Debit 7510 (arbetsgivaravgifter)
- Credit 2730 (arbetsgivaravgifter skuld)

**Momsredovisning (monthly/quarterly):**
- Debit 2611 (tömma utgående 25 %)
- Debit 2621 (tömma utgående 12 %)
- Debit 2631 (tömma utgående 6 %)
- Credit 2640 (tömma ingående)
- Credit/Debit 2650 (netto: skuld if credit, fordran if debit)

## 6. BAS numbering conventions

- 4 digits is standard
- Companies can add sub-accounts using 5+ digits for internal reporting (e.g., 3011 for product line A, 3012 for product line B)
- The first digit determines the class
- The second digit typically groups related accounts
- Stay consistent with BAS standard numbering. Don't invent custom numbers where BAS already has a standard account
- BAS publishes yearly updates. Most years the changes are small, but BAS 2026 was a major restructure: 114 new and 107 renamed accounts, class 4 split between handelsvaror and råvaror och förnödenheter, and maskiner vs inventarier separated in 12xx, 77xx and 78xx (e.g. 7833-7835 removed). Map accounts per BAS year
