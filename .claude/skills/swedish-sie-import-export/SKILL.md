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

SIE4 (Standard Import Export) is Sweden's universal accounting data interchange format. Tagged plain-text, one record per line, `#LABEL` prefix, space-delimited fields. `.SE` = export, `.SI` = import. Current spec: utgåva 4C (2025-08-06), which still allows only CP437 (`#FORMAT PC8`). SIE 5 is a separate XML format; this skill covers SIE 4.

## Reference files

| File | When to read |
|------|-------------|
| `references/record-types.md` | Every record label and its fields, the five subtypes (1, 2, 3, 4E, 4I), field format rules, verification example, series conventions, multi-year handling, record ordering, #KSUMMA |
| `references/encoding.md` | Encoding detection, byte tables, mojibake diagnosis, per-software behaviour, normalization on import |
| `references/validation-rules.md` | Common-error lookup, all validation rules and severities, validation order, remediation workflow, post-import issues, file diffing |
| `references/bas-sru.md` | BAS account classes, #KTYP, key accounts, SRU codes, year-end closing and IB/UB flow, #KPTYP |
| `references/migration-and-audit-trail.md` | Migrating between systems, what SIE does not carry, post-migration validation, retention and audit trail under BFL |

## Core invariants (never violate)

1. **Verification balance**: Sum of all #TRANS amounts within a #VER block = 0.00 exactly
2. **IB/UB continuity**: UB(year N, account) = IB(year N+1, account) for all balance sheet accounts (1xxx-2xxx)
3. **Result account reset**: IB for income statement accounts (3xxx-9xxx) must be zero at year start
4. **#FLAGGA idempotency**: 0 = not imported, 1 = already imported. Prevents double-import.
5. **Sequential numbering**: Verifications within a series appear in ascending verno order
6. **Sign convention**: Debit = positive, Credit = negative (in #TRANS, #IB, #UB, #RES)

## Procedure for any SIE file

1. **Detect the encoding before parsing.** `#FORMAT PC8` is unreliable: cloud programs declare PC8 and export UTF-8. Detection order in `encoding.md`; skip #KSUMMA unless CP437.
2. **Check #FLAGGA.** `1` means the file has already been read in: don't import it.
3. **Validate in order**: structure → encoding → parsing → chart of accounts → balances → verifications → fiscal year boundaries → dimensions → KSUMMA (CP437 only). Checks and severities in `validation-rules.md`.
4. **Diagnose before adjusting.** Any difference (unbalanced #VER, IB/UB mismatch, non-zero IB on result accounts): keep the file untouched, report the exact difference, compare with the source ledger, fix the cause, re-export. A rättelsepost only when the books themselves are wrong, in the period the error is discovered.
5. **Generating files**: write CP437, every verification balanced and in ascending verno order per series, every account declared, `#FLAGGA 0`.

## Never guess these

| Situation | Why | What to do |
|---|---|---|
| The file's actual encoding | PC8 is declared even by UTF-8 exporters, and mojibake is silent | Run the detection order in `encoding.md` on the raw bytes |
| An unbalanced verification | The cause decides the fix; a balancing line hides a missing cost | Compare with the source voucher and re-export. Never add a balancing line |
| An IB/UB difference | IB must equal the previous year's UB (ÅRL 2:4 p.7) | Diagnose per account against the source. Never adjust the opening or a closed period undiagnosed |
| Resetting #FLAGGA to 0 | It defeats the double-import guard (spec 7.4) | Confirm the vouchers are not in the target, and document why |
| VAT codes after an import | SIE carries no moms information | Configure them manually in the target system |
| The series to import into | Collisions create duplicate verification numbers | Remap to an unused series, document the mapping |

## Related skills

| Question | Skill |
|---|---|
| SRU codes and the files sent to Skatteverket | `swedish-sru-filing` |
| BFL bookkeeping duties, verifikationer, archiving | `swedish-accounting-compliance` |
| The closing entries behind UB and next year's IB | `swedish-year-end-closing` |
| Moms codes and rules to configure after an import | `swedish-vat` |
| Project dimensions (#DIM 6 / #OBJEKT) in the books | `swedish-project-accounting` |
| Årsredovisning and INK2 from the same balances | `swedish-financial-reporting` |
