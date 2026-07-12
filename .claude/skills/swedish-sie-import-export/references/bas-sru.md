# BAS Kontoplan and SRU Code Reference for SIE4

## Account class hierarchy

BAS uses a 4-digit decimal system: first digit = class, first two = group, all four = specific account.

| Class | #KTYP | Swedish | English | Report | IB/UB? |
|-------|-------|---------|---------|--------|--------|
| 1xxx | T | Tillgångar | Assets | Balance sheet | Yes (#IB/#UB) |
| 2xxx | S | Eget kapital och skulder | Equity & liabilities | Balance sheet | Yes (#IB/#UB) |
| 3xxx | I | Rörelseintäkter | Operating revenue | Income statement | No (#RES) |
| 4xxx | K | Varuinköp/material | Cost of goods | Income statement | No (#RES) |
| 5xxx | K | Övriga externa kostnader (lokaler, förbrukningsinventarier) | Other external costs | Income statement | No (#RES) |
| 6xxx | K | Övriga externa kostnader (kontorsmaterial, telefon, reklam) | Other external costs | Income statement | No (#RES) |
| 7xxx | K | Personalkostnader, avskrivningar | Personnel, depreciation | Income statement | No (#RES) |
| 8xxx | I/K | Finansiella poster, bokslutsdispositioner, skatt | Financial items, appropriations, tax | Income statement | No (#RES) |
| 9xxx | - | Internredovisning | Internal/management | Off-report | N/A |

## Account type (#KTYP) behavior in SIE4

| Type | Increases on | Decreases on | Normal balance | SIE sign convention |
|------|-------------|--------------|----------------|---------------------|
| T (Asset) | Debit (+) | Credit (-) | Positive | IB/UB positive = normal |
| S (Liability/Equity) | Credit (-) | Debit (+) | Negative | IB/UB negative = normal |
| I (Income) | Credit (-) | Debit (+) | Negative | RES negative = revenue |
| K (Cost) | Debit (+) | Credit (-) | Positive | RES positive = expense |

## Key accounts for SIE validation

These accounts appear frequently in SIE files and have special significance:

### Balance sheet (1xxx-2xxx)
- **1510** Kundfordringar (accounts receivable)
- **1910** Kassa (cash)
- **1920** PlusGiro
- **1930** Företagskonto/bank (business bank account)
- **1940** Övriga bankkonton
- **2081** Aktiekapital (share capital, AB only)
- **2091** Balanserad vinst/förlust (retained earnings)
- **2098** Vinst/förlust föregående år
- **2099** Årets resultat (current year net income, used in closing)
- **2440** Leverantörsskulder (accounts payable)
- **2510** Skatteskulder (tax liabilities)
- **2610** Utgående moms 25% (output VAT 25%)
- **2620** Utgående moms 12%
- **2630** Utgående moms 6%
- **2640** Ingående moms (input VAT)
- **2650** Redovisning av moms (VAT settlement account)
- **2710** Personalens källskatt (employee withholding tax)
- **2730** Lagstadgade sociala avgifter (statutory social charges)
- **2920** Upplupna semesterlöner (accrued vacation pay)

### Income statement (3xxx-8xxx)
- **3010-3099** Försäljning varor/tjänster (sales revenue)
- **3740** Öres-/avrundningsdifferens (rounding differences)
- **3741** Öresutjämning (øre equalization, used to balance rounding)
- **4010** Varuinköp (cost of goods purchased)
- **5010** Lokalhyra (office rent)
- **6110** Kontorsmaterial (office supplies)
- **6212** Mobiltelefon
- **6230** Datakommunikation (internet/data)
- **6570** Bankkostnader (bank charges)
- **7010** Löner (salaries)
- **7210** Arbetsgivaravgifter (employer contributions)
- **7510** Avskrivningar maskiner/inventarier (depreciation)
- **8310** Ränteintäkter (interest income)
- **8410** Räntekostnader (interest expenses)
- **8910** Skatt på årets resultat (income tax on profit, AB)
- **8999** Årets resultat (result for the year, closing account)

## SRU codes

### What SRU codes are

SRU (Standardiserade Räkenskapsutdrag) codes are 4-digit numeric codes that map BAS accounts to specific fields in Swedish income tax declaration forms. They enable automated transfer of account balances to tax returns.

### SRU in SIE files

The `#SRU` record maps an account to its SRU code:
```
#SRU 1510 7214
#SRU 3010 7410
```

Multiple #SRU entries per account are permitted (one account may map to multiple SRU codes). Some amounts map to different SRU codes depending on sign (debit vs credit balance).

### Key relationships
- `#TAXAR` specifies which taxation year's SRU mappings apply
- `#KPTYP` determines which SRU mapping set is appropriate
- The mapping schema is maintained by BAS-kontogruppen and Skatteverket
- Updated annually; published at bas.se as "kopplingsschema"

### Tax forms using SRU
- **INK2** (+ INK2R, INK2S): Aktiebolag (AB) income tax
- **INK3**: Ideella föreningar, stiftelser (non-profits, foundations)
- **INK4** (+ INK4R, INK4S, INK4DU): Handelsbolag, kommanditbolag (HB, KB)
- **NE-bilaga**: Enskild firma (sole proprietorship)

### SRU code ranges (approximate)
- **7000-7399**: Balance sheet items (tillgångar, eget kapital, skulder)
- **7400-7699**: Income statement items (intäkter, kostnader)
- **7700-7999**: Special items (bokslutsdispositioner, skatter)

### Important note
SRU mappings change between taxation years. A file with `#TAXAR 2023` uses 2023's mappings; `#TAXAR 2024` uses 2024's. Always verify the kopplingsschema version matches the taxation year.

## Account class rules for SIE validation

### Balance sheet accounts (1xxx-2xxx)
- Must have #IB and #UB records
- UB(year -1) must equal IB(year 0)
- Carry forward between fiscal years

### Income statement accounts (3xxx-8xxx)
- Must have #RES records (not #IB/#UB)
- IB must be zero at start of each fiscal year
- Zeroed out by year-end closing entries (transferred to 2099)
- #PSALDO records track monthly changes

### Internal accounts (9xxx)
- Not included in external reports
- Some systems (Visma Bokföring) don't support them
- May or may not appear in SIE exports depending on system
- No mandatory #IB/#UB or #RES requirements

## BAS version handling in SIE

The `#KPTYP` record declares the chart of accounts version:
- `BAS95`: Original BAS plan
- `BAS96`: 1996 revision
- `EUBAS97`: EU-adapted version (most common modern usage)
- `NE2007`: Specialized for enskild firma
- `BAS2xxx` (e.g., `BAS2024`): Treated as equivalent to EUBAS97

If `#KPTYP` is missing, assume BAS 95. The account number structure is consistent across versions; differences are mainly in which accounts exist and their SRU mappings.