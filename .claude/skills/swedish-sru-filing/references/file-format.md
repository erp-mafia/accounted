# SRU File Format: Structure, Encoding and a Worked Example

<!-- toc -->
**Contents**

- [1. INFO.SRU structure](#1-infosru-structure)
- [2. BLANKETTER.SRU structure](#2-blankettersru-structure)
- [3. Encoding and formatting rules](#3-encoding-and-formatting-rules)
- [4. Zero-value handling](#4-zero-value-handling)
- [5. Complete example: calendar-year 2024 AB](#5-complete-example-calendar-year-2024-ab)
- [6. Validation errors](#6-validation-errors)
- [7. Data type reference](#7-data-type-reference)
- [8. Key external references](#8-key-external-references)

<!-- /toc -->

## 1. INFO.SRU structure

Posts must appear in this exact order. Omit optional posts entirely if not used.

```
#DATABESKRIVNING_START
#PRODUKT SRU
#MEDIAID <free-form ID>
#SKAPAD <YYYYMMDD> <HHMMSS>
#PROGRAM <program name and version>
#FILNAMN BLANKETTER.SRU
#DATABESKRIVNING_SLUT
#MEDIELEV_START
#ORGNR <12-digit org number>
#NAMN <submitter name, max 250 chars>
#ADRESS <postal address>
#POSTNR <5-digit postal code>
#POSTORT <city>
#AVDELNING <department>
#KONTAKT <contact person>
#EMAIL <email>
#TELEFON <max 15 chars>
#FAX <max 15 chars>
#MEDIELEV_SLUT
```

Mandatory posts: `#PRODUKT`, `#FILNAMN`, `#ORGNR`, `#NAMN`, `#POSTNR`, `#POSTORT`.

The `#PRODUKT` value is always `SRU` (post-2013). There is no `#PERIOD` post: period is encoded in each blankett type string.

## 2. BLANKETTER.SRU structure

Contains one or more blankett blocks, terminated by `#FIL_SLUT`:

```
#BLANKETT <BlankettTyp>
#IDENTITET <OrgNr> <YYYYMMDD> <HHMMSS>
#NAMN <taxpayer name>
#UPPGIFT <FältKod> <FältVärde>
... (repeat #UPPGIFT for each field)
#BLANKETTSLUT
... (repeat #BLANKETT blocks for each form section)
#FIL_SLUT
```

### INK2 requires three blankett blocks

An aktiebolag filing INK2 must include three separate blocks in this file:

| Block | BlankettTyp example | Content |
|---|---|---|
| INK2 | `INK2-2024P4` | Huvudblankett (page 1): summary fields |
| INK2R | `INK2R-2024P4` | Räkenskapsschema (pages 2-3): balance sheet + income statement |
| INK2S | `INK2S-2024P4` | Skattemässiga justeringar (page 4): tax adjustments |

### Period suffix rules

The suffix after the hyphen encodes when the fiscal year ENDS:

| Suffix | Fiscal year ends in months |
|---|---|
| P1 | January-April |
| P2 | May-June |
| P3 | July-August |
| P4 | September-December (calendar-year companies) |

The year in the type string is the INCOME YEAR (inkomstår: the calendar year in which the räkenskapsår ends), not the filing year. A company with fiscal year 2024-01-01 to 2024-12-31 uses period `2024P4`; fiscal year 2024-07-01 to 2025-06-30 uses `2025P2`.

### Each block is independent

Every blankett block carries its own `#IDENTITET` line. The `DatFramst` timestamp determines version precedence: later timestamps replace earlier submissions for the same org number and blankett type.

## 3. Encoding and formatting rules

### Encoding: ISO 8859-1 (Latin-1)

This is the single most common source of validation failure in programmatic SRU generation. **Never use UTF-8.** Swedish characters (å, ä, ö) will corrupt.

When writing files in code:
- Python: `open(path, 'w', encoding='iso-8859-1')`
- Node.js: Use `iconv-lite` to encode to `iso-8859-1` before writing
- Java: `new OutputStreamWriter(fos, StandardCharsets.ISO_8859_1)`

### Line endings

All three conventions accepted: `\r\n` (Windows), `\r` (classic Mac), `\n` (Unix).

### Amount formatting

- **Integers in hela kronor (whole SEK)**. No öre, no decimals.
- Positive: no sign, no leading zeros. Example: `1000`
- Negative: `-` prefix. Example: `-1000`. Use it only to deviate from the sign printed on the form (see sign convention below).
- **No thousands separators.** `7 135` with a space WILL fail.
- Truncation rule per SFL 22 kap. 1 §: öre are DROPPED (truncated), not rounded.
- Small rounding differences from öre truncation across multiple posts are accepted by Skatteverket.

### Sign convention (teckenkonventionen)

The sign printed on the form applies and the amount is reported as a **positive** number. Cost rows printed with "−" (e.g. INK2R 7511-7517, 7522, 7528; INK2S 7751, 7763) are therefore sent as positive amounts. A negative amount means the value deviates from the printed sign. Fields without a printed sign (balance sheet rows 2.1-2.50) are reported with their actual sign. The printed sign per field is in column `*/+/-` of Skatteverket's fältnamnstabell; see `references/sru-codes.md`.

### Org number format

Always 12 digits, format `SSÅÅMMDDNNNK`, no hyphens.
- Juridiska personer (companies): century prefix `16`
- Example: org nr `556000-0100` becomes `165560000100`

### Checkbox fields

Value: uppercase `X`. If unchecked, **omit the entire #UPPGIFT line**: never send empty values.

### The `#` character

Reserved for post names. **Forbidden in all string data values.**

## 4. Zero-value handling

**Do not emit `#UPPGIFT` lines for fields with zero value.** Omit them entirely. Including zero-value fields is a common source of validation warnings and in some cases errors.

## 5. Complete example: calendar-year 2024 AB

### INFO.SRU
```
#DATABESKRIVNING_START
#PRODUKT SRU
#SKAPAD 20250401 100000
#PROGRAM accounted 1.0
#FILNAMN BLANKETTER.SRU
#DATABESKRIVNING_SLUT
#MEDIELEV_START
#ORGNR 165590001234
#NAMN Exempelbolaget AB
#POSTNR 11122
#POSTORT Stockholm
#KONTAKT Anna Andersson
#EMAIL anna@exempel.se
#MEDIELEV_SLUT
```

### BLANKETTER.SRU
```
#BLANKETT INK2-2024P4
#IDENTITET 165590001234 20250401 100000
#NAMN Exempelbolaget AB
#UPPGIFT 7011 20240101
#UPPGIFT 7012 20241231
#UPPGIFT 7104 100000
#BLANKETTSLUT
#BLANKETT INK2R-2024P4
#IDENTITET 165590001234 20250401 100001
#NAMN Exempelbolaget AB
#UPPGIFT 7011 20240101
#UPPGIFT 7012 20241231
#UPPGIFT 7215 60000
#UPPGIFT 7251 40000
#UPPGIFT 7281 180000
#UPPGIFT 7301 25000
#UPPGIFT 7302 154400
#UPPGIFT 7365 80000
#UPPGIFT 7368 20600
#UPPGIFT 7410 500000
#UPPGIFT 7513 250000
#UPPGIFT 7514 150000
#UPPGIFT 7528 20600
#UPPGIFT 7450 79400
#BLANKETTSLUT
#BLANKETT INK2S-2024P4
#IDENTITET 165590001234 20250401 100002
#NAMN Exempelbolaget AB
#UPPGIFT 7011 20240101
#UPPGIFT 7012 20241231
#UPPGIFT 7650 79400
#UPPGIFT 7651 20600
#UPPGIFT 7670 100000
#BLANKETTSLUT
#FIL_SLUT
```

Cost rows 7513, 7514 and 7528 are printed with "−" on INK2R and are therefore sent as positive amounts. Result before tax 100 000 kr, booked tax 20 600 kr (20.6 %), årets resultat 79 400 kr (3.26 → 4.1). INK2S adds back the tax (4.3a) to reach överskott 100 000 kr at 4.15 (7670), which is carried to INK2 1.1 (7104).

## 6. Validation errors

Skatteverket validates on upload and returns a mottagningskvittens.

### Level 1 (entire submission rejected)
- Structural errors in INFO.SRU
- Posts in wrong order in any blankett block
- More than 100 level 2 errors total
- Missing `#FIL_SLUT`
- Unknown post types
- `#FILNAMN` referencing nonexistent file

### Level 2 (individual blankett block rejected, others accepted)
- Invalid org number
- Field code not valid for the blankett type
- Value violates field rules (wrong data type, out of range)
- Missing mandatory timestamp
- Invalid blankett type string

### Most frequent real-world failures
1. **Renamed files**: browsers adding `(1)` suffix
2. **Wrong period**: using `2025P4` when income year is 2024
3. **Amounts with decimals or spaces**: `7135.50` or `7 135`
4. **UTF-8 encoding** instead of ISO 8859-1
5. **Including #UPPGIFT for zero/empty values**
6. **Duplicate field codes** in same blankett block
7. **10-digit or hyphenated org number** instead of 12-digit
8. **Non-existent SRU codes**: mapping BAS accounts to wrong field codes

## 7. Data type reference

| Type | Format | Range |
|---|---|---|
| Numeriskt_A | Integer | -999,999,999,999 to 999,999,999,999 |
| Numeriskt_B | Integer | 0 to 999,999,999,999 |
| Datum_A | YYYYMMDD | Valid calendar date |
| Tid_A | HHMMSS | 00:00:00 to 23:59:59 |
| Decimal_2 | x.xx | -9,999,999,999.99 to 9,999,999,999.99 |
| Andel_4 | x.xxxx | 0.0000 to 100.0000 |
| STR_250 | String | Max 250 chars, no `#` |

## 8. Key external references

- Skatteverket tech spec: `skatteverket.se/foretag/inkomstdeklaration/forredovisningsbyraer/tekniskinformationomfiloverforing`
- BAS SRU mappings: `bas.se/kontoplaner/sru/`
- Annual field code ZIP packages: download from Skatteverket tech spec page (Excel files per period)
- Validation service: `www1.skatteverket.se/fv/fv_web/start.do`
- Open-source reference implementations: `github.com/thpe/pysru-accounting`, `github.com/aidium/SRU-Maker`
