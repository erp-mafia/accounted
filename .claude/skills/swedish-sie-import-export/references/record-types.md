---
audience: developer
---

# SIE4 Record Type Reference

Complete specification of all SIE4 record types, fields, and rules, per SIE filformat utgåva 4C (2025-08-06).


<!-- toc -->
**Contents**

- [Spec, file types and subtypes](#spec-file-types-and-subtypes)
- [Field format rules](#field-format-rules)
- [Flag item](#flag-item)
- [Identification items](#identification-items)
- [Chart of accounts items](#chart-of-accounts-items)
- [Dimension and object items](#dimension-and-object-items)
- [Balance items](#balance-items)
- [Multi-year handling](#multi-year-handling)
- [Verification and transaction items](#verification-and-transaction-items)
- [Verification structure example](#verification-structure-example)
- [Verification series conventions](#verification-series-conventions)
- [Control total](#control-total)
- [Record ordering](#record-ordering)
- [Type availability matrix](#type-availability-matrix)

<!-- /toc -->

## Spec, file types and subtypes

**Current spec**: SIE filformat utgåva 4C (2025-08-06). 4C does not change the file format from 4B (2008); its format clarifications are that a line added and later removed is written as #BTRANS, and that an empty field before a field with a value is written as `""`. CP437 (`#FORMAT PC8`) is still the only allowed character set. SIE-Gruppen's online validator is at https://sietest.sie.se/. SIE 5 is a separate XML format (English labels; can also carry reskontror, asset registers and attached documents). This skill covers SIE 4.

**File extensions**: `.SE` = export, `.SI` = import.

**Five subtypes**:
- **Type 1**: Closing balances + chart of accounts + SRU codes (tax returns)
- **Type 2**: Type 1 + monthly period balances (#PSALDO, #PBUDGET)
- **Type 3**: Type 2 + object-level balances, dimensions
- **Type 4E**: Export file: Type 1 records + verifications (#VER/#TRANS); period and object balances optional. Used for full transaction exports (audit trail)
- **Type 4I**: Import file: header (incl. #FNAMN) + verifications; #RAR, #KONTO, #DIM/#OBJEKT optional; no balance records = subsystem import (payroll, POS)

---

## Field format rules

- **Quoting**: Double quotes around fields with spaces. Escape internal quotes as `\"`
- **Empty fields**: Fields are positional. An empty field before a field with a value is written as `""` (`#VER "" "" 20251216 "Porto"`); trailing empty fields may be left out
- **Dates**: YYYYMMDD. Periods: YYYYMM
- **Amounts**: Dot decimal separator, max 2 decimals, no plus sign
- **Block delimiters**: `{` and `}` each on own line around #TRANS entries in #VER
- **Object lists**: `{dimension_no "object_no"}` within balance/transaction items
- **Forward compat**: Readers must ignore unknown labels and unknown trailing fields

---

## Flag item

### #FLAGGA x
- **Compulsory**: All types
- **Position**: Must be first item in file
- **Values**: `0` = not yet imported (set by exporter), `1` = already imported (set by importer)
- **Purpose**: Prevents double-import of transaction files
- **Workflow**: Exporter creates with 0 → importer sets to 1 after success → re-import attempts detect 1 and refuse

---

## Identification items

### #PROGRAM name version
- **Compulsory**: All types
- **Example**: `#PROGRAM "Fortnox" 3.0`
- **Note**: Useful for encoding detection heuristics (cloud vs desktop)

### #FORMAT PC8
- **Compulsory**: All types
- **Values**: Only `PC8` (Codepage 437) is valid per spec
- **Reality**: Many programs write `PC8` but export UTF-8. Treat as unreliable for encoding detection.

### #GEN date [sign]
- **Compulsory**: All types
- **Fields**: date = YYYYMMDD, sign = optional author signature string
- **Example**: `#GEN 20240115 "JD"`

### #SIETYP n
- **Compulsory**: Types 2-4 (if absent, assume type 1)
- **Values**: 1, 2, 3, 4
- **Note**: No distinction between 4E and 4I in this field; both are type 4

### #FNAMN name
- **Compulsory**: All types
- **Example**: `#FNAMN "Exempelföretag AB"`

### #ORGNR cin [acq_no] [act_no]
- **Optional**
- **Format**: Organisationsnummer with hyphen after 6th digit: `556677-8899`
- **Additional fields**: acquisition number, activity number (rarely used)

### #RAR year_no start end
- **Compulsory**: Types 1-3 and 4E; optional in 4I
- **Fields**: year_no (0 = current, -1 = previous, -2 = two years ago), start/end = YYYYMMDD
- **Both current (0) and previous (-1) year should be present**
- **Supports broken fiscal years**: `#RAR 0 20240701 20250630`
- **Example**: `#RAR 0 20240101 20241231`

### #TAXAR year
- **Optional**
- **Purpose**: Taxation year for SRU code interpretation
- **Example**: `#TAXAR 2024`

### #OMFATTN date
- **Compulsory**: Types 2-3; optional for 4E
- **Purpose**: End date of the period scope covered by the file
- **Example**: `#OMFATTN 20241231`

### #KPTYP type
- **Optional** (if missing, assume BAS 95)
- **Valid values**: `BAS95`, `BAS96`, `EUBAS97`, `NE2007`
- **Rule**: Any value starting with `BAS2` (e.g., `BAS2024`) is treated as `EUBAS97`

### #PROSA text
- **Optional**
- **Purpose**: Free-form comment

### #FNR id
- **Optional**
- **Purpose**: Internal company code in multi-company setups

### #ADRESS contact address postal_address tel
- **Optional**
- **Fields**: 4 quoted strings
- **Example**: `#ADRESS "Jan Sansen" "Box 21" "211 20  Malmö" "040-12 34 56"`

### #BKOD sni_code
- **Optional**
- **Purpose**: SNI industry code (Svensk Näringsgrensindelning)

### #FTYP type
- **Optional**
- **Valid values**: AB, E, HB, KB, EK, KHF, BRF, BF, SF, I, S, FL, BAB, MB, SB, BFL, FAB, OFB, SE, SCE, TSF, X
- **Common**: AB (aktiebolag), E (enskild firma), HB (handelsbolag), KB (kommanditbolag)

### #VALUTA code
- **Optional** (if missing, assume SEK)
- **Format**: ISO 4217 currency code

---

## Chart of accounts items

### #KONTO account_no name
- **Compulsory**: Types 1-3, 4E; optional in 4I
- **Rule**: Account numbers must be numeric. On export, all accounts used in the file must be declared. A 4I file may leave accounts undeclared if they already exist in the receiving program; a declared account missing there is created on import.
- **Example**: `#KONTO 1510 "Kundfordringar"`

### #KTYP account_no type
- **Optional**
- **Values**: T (Tillgång/Asset), S (Skuld/Liability), K (Kostnad/Cost), I (Intäkt/Income)
- **Example**: `#KTYP 1510 T`

### #ENHET account_no unit
- **Optional**
- **Purpose**: Quantity unit for the account
- **Example**: `#ENHET 4010 "st"`

### #SRU account sru_code
- **Compulsory**: Types 1-2; optional in 3, 4E and 4I
- **Rule**: Multiple #SRU entries per account are permitted (one account can map to multiple SRU codes)
- **Example**: `#SRU 1510 7214`

---

## Dimension and object items

### #DIM dimension_no name
- **Types**: 3 and 4
- **Reserved dimensions** (need not be explicitly declared):
  - 1 = Kostnadsställe (cost centre)
  - 2 = Kostnadsbärare (cost bearer, sub-dimension of 1)
  - 6 = Projekt (project)
  - 7 = Anställd (employee)
  - 8 = Kund (customer)
  - 9 = Leverantör (supplier)
  - 10 = Faktura (invoice)
- **Reserved but unused**: 3-5, 11-19
- **Freely assignable**: 20+
- **Example**: `#DIM 1 "Kostnadsställe"`

### #UNDERDIM dimension_no name superdimension
- **Optional**
- **Purpose**: Hierarchical sub-dimension declaration
- **Example**: `#UNDERDIM 2 "Kostnadsbärare" 1`

### #OBJEKT dimension_no object_no name
- **Types**: 3 and 4
- **Example**: `#OBJEKT 1 "100" "Stockholm"`
- **Example**: `#OBJEKT 6 "P01" "Projekt Alpha"`

---

## Balance items

### #IB year_no account balance [quantity]
- **Purpose**: Opening balance (Ingående Balans) for balance sheet accounts
- **year_no**: 0 = current year, -1 = previous year
- **Sign**: Credit = negative (liabilities/equity carry negative balances)
- **Rule**: Only balance sheet accounts (1xxx-2xxx) should have non-zero IB
- **Example**: `#IB 0 1510 125000.00`

### #UB year_no account balance [quantity]
- **Purpose**: Closing balance (Utgående Balans)
- **Rule**: UB for current year (0) must always be present
- **Continuity rule**: UB(year -1, account) must equal IB(year 0, account)
- **Example**: `#UB 0 1510 98500.00`

### #RES year_no account balance [quantity]
- **Purpose**: Balance for income statement accounts (3xxx-8xxx)
- **Sign**: Income (credit) = negative, Cost (debit) = positive
- **Example**: `#RES 0 3010 -500000.00` (500k in revenue)

### #OIB year_no account {dim_no obj_no} balance [quantity]
- **Purpose**: Opening balance per object (type 3+)
- **Example**: `#OIB 0 1510 {1 "100"} 50000.00`

### #OUB year_no account {dim_no obj_no} balance [quantity]
- **Purpose**: Closing balance per object (type 3+)

### #PSALDO year_no period account {obj_list} balance [quantity]
- **Compulsory**: Types 2-3
- **Purpose**: Monthly change on account (NOT cumulative)
- **Period**: YYYYMM
- **Object list**: Empty `{}` for type 2; object-specific for type 3
- **Example**: `#PSALDO 0 202401 3010 {} -42000.00`

### #PBUDGET year_no period account {obj_list} balance [quantity]
- **Compulsory**: Types 2-3 whenever budget values exist (no budget registered = no records); optional in 4E; not allowed in type 1 or 4I
- **Structure**: Same as #PSALDO but for budgeted values

---

## Multi-year handling

- `#RAR 0 20240101 20241231` = current fiscal year
- `#RAR -1 20230101 20231231` = previous year
- Only one chart of accounts per file (current year's)
- Broken fiscal years supported: `#RAR 0 20240701 20250630`
- #PSALDO/#PBUDGET store monthly change (not cumulative), period = YYYYMM

---

## Verification and transaction items

### #VER series verno verdate [vertext] [regdate] [sign]
- **Type**: 4 only (optional record in both 4E and 4I)
- **Fields**:
  - series = letter (A, B...), number, or alphanumeric string
  - verno = sequential number within series
  - verdate = YYYYMMDD
  - vertext = optional description in quotes
  - regdate = optional registration date YYYYMMDD
  - sign = optional author signature
- **Rules**:
  - Must be followed by `{` on its own line
  - Then one or more #TRANS lines
  - Then `}` on its own line
  - All verifications within a series must be in ascending verno order
  - For 4I files, series and verno may be empty (receiver assigns). Empty fields before a later value are written as `""`: `#VER "" "" 20251216 "Porto"`
- **Example**: `#VER A 1 20240115 "Kundfaktura 2024-001" 20240115 "JD"`

### #TRANS account_no {object_list} amount [transdate] [transtext] [quantity] [sign]
- **Type**: 4 only, as sub-entry of #VER
- **Fields**:
  - account_no = numeric account
  - object_list = `{}` or `{dim_no "obj_no" ...}` (multiple dim/obj pairs allowed)
  - amount = decimal, debit positive, credit negative
  - transdate = optional override of verification date
  - transtext = optional line-level description
  - quantity = optional quantity
  - sign = optional author
- **Balance rule**: Sum of all #TRANS amounts in a #VER = 0.00 exactly
- **Example**: `#TRANS 1510 {} 12500.00 20240115 "Faktura 2024-001"`

### #RTRANS (same fields as #TRANS)
- **Purpose**: Added transaction line (tillagd transaktionspost), i.e. a line added to the verification after it was first registered
- **Rule**: Must be immediately followed by an identical #TRANS for backward compatibility
- **Programs understanding RTRANS**: use RTRANS, ignore following TRANS
- **Programs not understanding RTRANS**: ignore RTRANS, use TRANS
- **Balance**: Count the line once. Summing both #RTRANS and its #TRANS breaks the verification balance.

### #BTRANS (same fields as #TRANS)
- **Purpose**: Removed transaction line (borttagen transaktionspost)
- **Rule (clarified in 4C)**: A line that was first added and later removed is written only as #BTRANS
- **Programs not understanding BTRANS**: simply ignore it
- **Balance**: #BTRANS lines are not part of the verification balance

---

## Verification structure example

```
#VER A 1 20240115 "Kundfaktura 2024-001"
{
    #TRANS 1510 {} 12500.00
    #TRANS 2611 {} -2500.00
    #TRANS 3010 {1 "100" 6 "P01"} -10000.00
}
```

Sum: 12500 + (-2500) + (-10000) = 0. Valid.

---

## Verification series conventions

Swedish practice:

- **A** = Huvudserie (main/general)
- **B** = Automatkonteringar (auto-postings)
- **F** = Kundfakturor (customer invoices)
- **I** = Inbetalningar (customer payments)
- **J** = Bokslutsverifikationer (year-end closing)
- **L** = Leverantörsfakturor (supplier invoices)
- **N** = Löner (payroll)
- **U** = Utbetalningar (supplier payments)

Series and numbering often restart each fiscal year, but some programs run a series across years. Every verification series must be unbroken (BFNAR 2013:2 p. 5.9). 4I import files may have empty series/verno.

---

## Control total

### #KSUMMA [value]
- **Optional**
- **Two instances**:
  1. Near file start: `#KSUMMA` (empty, signals active checksumming)
  2. At file end: `#KSUMMA 1234567890` (the actual CRC-32 value)
- **Algorithm**: CRC-32 with polynomial EDB88320H, pre-conditioning FFFFFFFF, post-conditioning bit-invert
- **Included**: labels and field contents, from the record after the opening #KSUMMA up to (not including) the closing #KSUMMA
- **Excluded from calculation**: spaces/tabs between fields, the quotes enclosing a field, braces around object lists and #TRANS blocks. For an escaped quote `\"` inside a field, only the quote character counts.
- **Truncation detection**: If opening KSUMMA exists but closing is missing, file is truncated. Reject.
- **Encoding caveat**: CRC is calculated on CP437 byte values per spec. If file is actually UTF-8, checksum will not match. Skip validation for non-CP437 files.

---

## Record ordering

The SIE spec (section 5.12) requires four groups in this order; order within a group is free unless a record's description says otherwise:

1. `#FLAGGA` (always first; an opening `#KSUMMA` follows directly if checksumming is used)
2. Identification items (#PROGRAM, #FORMAT, #GEN, #SIETYP, #FNAMN, #ORGNR, #RAR, etc.)
3. Chart of accounts items (#KONTO, #KTYP, #ENHET, #SRU, #DIM, #UNDERDIM, #OBJEKT)
4. Balance and verification items (#IB, #UB, #OIB, #OUB, #RES, #PSALDO, #PBUDGET, #VER with nested #TRANS)

The closing `#KSUMMA` comes last. Writers should put balances before verifications by convention. Readers should be tolerant of minor ordering deviations but may reject severely out-of-order files.

---

## Type availability matrix

| Record | Type 1 | Type 2 | Type 3 | Type 4E | Type 4I |
|--------|--------|--------|--------|---------|---------|
| #FLAGGA | Required | Required | Required | Required | Required |
| #PROGRAM | Required | Required | Required | Required | Required |
| #FORMAT | Required | Required | Required | Required | Required |
| #GEN | Required | Required | Required | Required | Required |
| #SIETYP | Implied | Required | Required | Required | Required |
| #FNAMN | Required | Required | Required | Required | Required |
| #RAR | Required | Required | Required | Required | Optional |
| #KONTO | Required | Required | Required | Required | Optional |
| #SRU | Required | Required | Optional | Optional | Optional |
| #DIM/#OBJEKT | N/A | N/A | Required | Optional | Optional |
| #IB/#UB | Required | Required | Required | Required | N/A |
| #RES | Required | Required | Required | Required | N/A |
| #OIB/#OUB | N/A | N/A | Required | Optional | N/A |
| #PSALDO | N/A | Required | Required | Optional | N/A |
| #PBUDGET | N/A | Required | Required | Optional | N/A |
| #VER/#TRANS | N/A | N/A | N/A | Optional | Optional |
| #RTRANS/#BTRANS | N/A | N/A | N/A | Optional | Optional |
| #KSUMMA | Optional | Optional | Optional | Optional | Optional |

N/A = the record may not appear in that file type. #ORGNR, #KPTYP, #TAXAR, #VALUTA, #FTYP, #ADRESS and #PROSA are optional in all types. Required balance records (#IB, #UB, #RES, #OIB, #OUB, #PSALDO, #PBUDGET) must be written whenever values exist; zero balances may be omitted (spec 5.17-5.18). Source: SIE filformat 4C, section 6.