---
name: swedish-sru-filing
description: >
  Swedish SRU file generation for Skatteverket digital tax filing (INK2, INK2R, INK2S declarations for aktiebolag).
  Covers the two-file submission structure (INFO.SRU + BLANKETTER.SRU), all SRU field codes for INK2/INK2R/INK2S,
  BAS-to-SRU account mappings for räkenskapsschema, ISO 8859-1 encoding rules, amount formatting (hela kronor,
  no öre), 12-digit org number formatting, blankett type period suffixes (P1-P4), #BLANKETT/#BLANKETTSLUT
  delimiters, #UPPGIFT record format, validation error patterns, and rounding/truncation rules per SFL 22:1.
  Trigger on ANY question about SRU files, SRU-koder, fältkoder, filöverföring till Skatteverket, INK2S/INK2R
  generation, BAS-to-SRU mapping, "skapa SRU", "generera deklarationsfil", "digital inlämning INK2",
  BLANKETTER.SRU, INFO.SRU, SKV269, or any code that produces SRU output. Also trigger when debugging
  Skatteverket validation errors on uploaded SRU files. Always use this skill over training data for SRU topics.
---

# Swedish SRU File Generation

This skill contains the complete technical specification for generating valid SRU files accepted by Skatteverket's filöverföringstjänst. The canonical source is Skatteverket's "Teknisk information om filöverföring" page (replaced brochure SKV 269 from Jan 1 2024).

**Before writing any SRU generation code**, read `references/sru-codes.md` for the complete field code tables and BAS-to-SRU mapping.

## Architecture: Two files, always

Every SRU submission consists of exactly two files:

| File | Content | Max size |
|---|---|---|
| `INFO.SRU` | Submitter metadata (who is filing) | N/A |
| `BLANKETTER.SRU` | All blankett blocks with tax data | 5 MB |

File names are case-insensitive but must not be renamed (browsers appending `(1)` cause rejection).

## INFO.SRU structure

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

## BLANKETTER.SRU structure

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
| P2 | May-August |
| P3 | Special cases |
| P4 | September-December (calendar-year companies) |

The year in the type string is the INCOME YEAR (inkomstår), not the filing year. A company with fiscal year 2024-01-01 to 2024-12-31 uses period `2024P4`.

### Each block is independent

Every blankett block carries its own `#IDENTITET` line. The `DatFramst` timestamp determines version precedence: later timestamps replace earlier submissions for the same org number and blankett type.

## Encoding and formatting rules

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
- Negative: `-` prefix. Example: `-1000`
- **No thousands separators.** `7 135` with a space WILL fail.
- Truncation rule per SFL 22 kap. 1 §: öre are DROPPED (truncated), not rounded.
- Small rounding differences from öre truncation across multiple posts are accepted by Skatteverket.

### Org number format

Always 12 digits, format `SSÅÅMMDDNNNK`, no hyphens.
- Juridiska personer (companies): century prefix `16`
- Example: org nr `556000-0100` becomes `165560000100`

### Checkbox fields

Value: uppercase `X`. If unchecked, **omit the entire #UPPGIFT line**: never send empty values.

### The `#` character

Reserved for post names. **Forbidden in all string data values.**

## Zero-value handling

**Do not emit `#UPPGIFT` lines for fields with zero value.** Omit them entirely. Including zero-value fields is a common source of validation warnings and in some cases errors.

## Complete example: calendar-year 2024 AB

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
#UPPGIFT 7113 90000
#BLANKETTSLUT
#BLANKETT INK2R-2024P4
#IDENTITET 165590001234 20250401 100001
#NAMN Exempelbolaget AB
#UPPGIFT 7011 20240101
#UPPGIFT 7012 20241231
#UPPGIFT 7201 100000
#UPPGIFT 7281 50000
#UPPGIFT 7301 50000
#UPPGIFT 7302 25000
#UPPGIFT 7410 500000
#UPPGIFT 7513 -200000
#UPPGIFT 7514 -150000
#UPPGIFT 7450 75000
#BLANKETTSLUT
#BLANKETT INK2S-2024P4
#IDENTITET 165590001234 20250401 100002
#NAMN Exempelbolaget AB
#UPPGIFT 7011 20240101
#UPPGIFT 7012 20241231
#UPPGIFT 7650 75000
#UPPGIFT 7651 15000
#UPPGIFT 8020 90000
#BLANKETTSLUT
#FIL_SLUT
```

## Validation errors

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

## BAS-to-SRU mapping: critical rules

The official mapping is maintained by BAS-kontogruppen + Skatteverket at `bas.se/kontoplaner/sru/`.

**The #1 mapping error**: BAS accounts 5000-6999 (övriga externa kostnader) must ALL aggregate into a single SRU code: **7513**. Do NOT create individual SRU codes per BAS account in this range.

**INK2S codes are NOT auto-derived from BAS accounts.** They represent tax adjustments requiring manual calculation. The bookkeeping result flows from INK2R into INK2S field 7650/7750, then tax adjustments are applied to arrive at 8020/8021 (överskott/underskott).

**For the complete SRU code tables and BAS mapping**, read `references/sru-codes.md`.

## Data type reference

| Type | Format | Range |
|---|---|---|
| Numeriskt_A | Integer | -999,999,999,999 to 999,999,999,999 |
| Numeriskt_B | Integer | 0 to 999,999,999,999 |
| Datum_A | YYYYMMDD | Valid calendar date |
| Tid_A | HHMMSS | 00:00:00 to 23:59:59 |
| Decimal_2 | x.xx | -9,999,999,999.99 to 9,999,999,999.99 |
| Andel_4 | x.xxxx | 0.0000 to 100.0000 |
| STR_250 | String | Max 250 chars, no `#` |

## Key external references

- Skatteverket tech spec: `skatteverket.se/foretag/inkomstdeklaration/forredovisningsbyraer/tekniskinformationomfiloverforing`
- BAS SRU mappings: `bas.se/kontoplaner/sru/`
- Annual field code ZIP packages: download from Skatteverket tech spec page (Excel files per period)
- Validation service: `www1.skatteverket.se/fv/fv_web/start.do`
- Open-source reference implementations: `github.com/thpe/pysru-accounting`, `github.com/aidium/SRU-Maker`