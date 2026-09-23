---
name: swedish-sie-import-export
description: >
  Swedish SIE4 file format: parsing, validation, generation, troubleshooting. All record types
  (#VER, #TRANS, #IB, #UB, #RES, #KONTO, #RAR, #FLAGGA, #KSUMMA, #SRU, etc.), SIE types 1-4,
  encoding detection (CP437/UTF-8/Latin-1), mojibake diagnosis, verification balance integrity,
  IB/UB continuity, multi-year migration, diffing, audit trail under BFL, BAS account classes,
  SRU tax codes, and error patterns. Trigger on ANY SIE question: import, export, parsing,
  validation, encoding issues, garbled å/ä/ö, unbalanced verifications, IB/UB mismatch,
  #FLAGGA, SIE migration between Fortnox/Visma/BL/SpeedLedger/Bokio, .SE/.SI files,
  verification series, or code reading/writing SIE data. Always use over training data.
---

# Swedish SIE4 Import/Export

Deterministic reference for parsing, validating, generating, and troubleshooting SIE4 files.

## Quick orientation

SIE4 (Standard Import Export, version 4B, 2008) is Sweden's universal accounting data interchange format. Tagged plain-text, one record per line, `#LABEL` prefix, space-delimited fields.

**File extensions**: `.SE` = export, `.SI` = import.

**Five subtypes**:
- **Type 1**: Closing balances + chart of accounts + SRU codes (tax returns)
- **Type 2**: Type 1 + monthly period balances (#PSALDO, #PBUDGET)
- **Type 3**: Type 2 + object-level balances, dimensions
- **Type 4E**: Type 3 + all verifications (#VER/#TRANS) = full audit trail
- **Type 4I**: Verifications only, minimal header = subsystem import (payroll, POS)

## Core invariants (never violate)

1. **Verification balance**: Sum of all #TRANS amounts within a #VER block = 0.00 exactly
2. **IB/UB continuity**: UB(year N, account) = IB(year N+1, account) for all balance sheet accounts (1xxx-2xxx)
3. **Result account reset**: IB for income statement accounts (3xxx-9xxx) must be zero at year start
4. **#FLAGGA idempotency**: 0 = not imported, 1 = already imported. Prevents double-import.
5. **Sequential numbering**: Verifications within a series appear in ascending verno order
6. **Sign convention**: Debit = positive, Credit = negative (in #TRANS, #IB, #UB, #RES)

## Field format rules

- **Quoting**: Double quotes around fields with spaces. Escape internal quotes as `\"`
- **Dates**: YYYYMMDD. Periods: YYYYMM
- **Amounts**: Dot decimal separator, max 2 decimals, no plus sign
- **Block delimiters**: `{` and `}` each on own line around #TRANS entries in #VER
- **Object lists**: `{dimension_no "object_no"}` within balance/transaction items
- **Forward compat**: Readers must ignore unknown labels and unknown trailing fields

## When to read reference files

For the **complete record type specification** (all labels, fields, compulsory/optional rules, #KSUMMA CRC-32 details):
→ Read `references/record-types.md`

For **encoding detection, mojibake diagnosis, and per-software encoding behaviors**:
→ Read `references/encoding.md`

For **all validation rules, error patterns, and remediation procedures**:
→ Read `references/validation-rules.md`

For **BAS account classes, SRU code mappings, and account type behaviors**:
→ Read `references/bas-sru.md`

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

## Verification series conventions (Swedish practice)

- **A** = Huvudserie (main/general)
- **B** = Automatkonteringar (auto-postings)
- **F** = Kundfakturor (customer invoices)
- **I** = Inbetalningar (customer payments)
- **J** = Bokslutsverifikationer (year-end closing)
- **L** = Leverantörsfakturor (supplier invoices)
- **N** = Löner (payroll)
- **U** = Utbetalningar (supplier payments)

Series and numbering restart each fiscal year. 4I import files may have empty series/verno.

## Year-end closing and IB/UB flow

1. Closing entries (J-series) zero out all result accounts (3xxx-8xxx) by transferring net result to account 2099 (Årets resultat)
2. After closing: UB for result accounts = 0, UB for equity reflects accumulated result
3. These UB values become IB for next year
4. #RES records capture what result accounts held during the year before closing

## Multi-year handling

- `#RAR 0 20240101 20241231` = current fiscal year
- `#RAR -1 20230101 20231231` = previous year
- Only one chart of accounts per file (current year's)
- Broken fiscal years supported: `#RAR 0 20240701 20250630`
- #PSALDO/#PBUDGET store monthly change (not cumulative), period = YYYYMM

## Migration between systems

Standard path: export SIE4E per fiscal year from source, import into target starting with current year, verify IB/UB continuity, remap verification series to avoid collisions.

**What SIE does NOT carry**: VAT codes (must be manually configured post-import), customer/supplier subledgers (reskontror), processing history, underlying digital documents/vouchers.

Post-migration validation: compare balance reports, trial balances, verification counts per series, Swedish character rendering.

## Audit trail under BFL

- **7-year retention** after calendar year in which fiscal year ended (BFL 7:1)
- **Storage in Sweden** required (EU/EEA with Skatteverket notification; non-EU requires permission)
- **Immutability**: locked entries cannot be modified. Corrections via separate correction verification only.
- **#FLAGGA**: anti-duplication control. Exporter writes 0, importer sets to 1 after success.
- **SIE is not complete archiving**: lacks processing history and system documentation required by BFL.
- As of July 2024, paper originals may be destroyed after proper digitization.

## Encoding quick reference

The spec mandates CP437 (`#FORMAT PC8`), but modern cloud software exports UTF-8. Many programs write `#FORMAT PC8` regardless of actual encoding.

**Detection priority**: UTF-8 BOM → strict UTF-8 decode → CP437 byte scan (0x84/0x86/0x8E/0x8F/0x94/0x99) → Latin-1 byte scan (0xC4/0xC5/0xD6/0xE4/0xE5/0xF6) → check #PROGRAM (cloud = UTF-8, desktop = CP437) → fall back Latin-1.

**Mojibake signatures**: `Ã¥`/`Ã¤`/`Ã¶` = UTF-8 read as Latin-1. `†`/`„`/`"` = CP437 read as Win-1252. `σ`/`Σ`/`÷` = Latin-1 read as CP437.

**#KSUMMA note**: CRC-32 is calculated on CP437 byte values per spec. Skip KSUMMA validation when non-CP437 encoding is detected.

For full encoding tables and per-software behaviors, read `references/encoding.md`.

## Common errors (quick lookup)

| Error | Cause | Fix |
|-------|-------|-----|
| Unbalanced verification | #TRANS sum ≠ 0 | Add öresutjämning (3740) or fix amounts |
| IB/UB mismatch | Incomplete year-end closing | Create adjustment verification in opening period |
| Garbled å/ä/ö | Encoding mismatch | Detect actual encoding, re-decode |
| Duplicate verno | Series collision on import | Remap to unused series |
| Undeclared account | #TRANS references account not in #KONTO | Add #KONTO or map to existing |
| #FLAGGA 1 | File already imported | Verify not duplicate, manually reset to 0 |
| Missing #RAR | Can't determine fiscal year | Reject file or infer from verification dates |
| Non-zero IB on 3xxx-9xxx | Incomplete closing in source | Run closing entries before export |
| Truncated file | #KSUMMA opening present, closing missing | Reject, re-export from source |
| No VAT codes post-import | SIE carries no moms info | Manually configure in target system |

For the full error catalog with detailed remediation, read `references/validation-rules.md`.