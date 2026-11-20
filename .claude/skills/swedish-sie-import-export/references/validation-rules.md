# SIE4 Validation Rules and Error Patterns


<!-- toc -->
**Contents**

- [Common errors (quick lookup)](#common-errors-quick-lookup)
- [Structural validation](#structural-validation)
- [Verification integrity](#verification-integrity)
- [Balance continuity](#balance-continuity)
- [Account and dimension validation](#account-and-dimension-validation)
- [Verification numbering](#verification-numbering)
- [Fiscal year boundaries](#fiscal-year-boundaries)
- [Encoding errors](#encoding-errors)
- [Post-import issues](#post-import-issues)
- [Validation severity levels](#validation-severity-levels)
- [Recommended validation order](#recommended-validation-order)
- [Remediation workflow: diagnose before adjusting](#remediation-workflow-diagnose-before-adjusting)
- [SIE file diffing](#sie-file-diffing)

<!-- /toc -->

## Common errors (quick lookup)

| Error | Cause | Fix |
|-------|-------|-----|
| Unbalanced verification | #TRANS sum ≠ 0: line missing from the export, parse error (e.g. #RTRANS or #BTRANS counted), truncated file, or rounding in the source | Don't import or edit the voucher. Report the exact difference, compare with the source voucher, fix the cause and re-export. Never add a balancing line to an imported voucher. Real errors in the books: separate rättelsepost in the current period (see [remediation workflow](#remediation-workflow-diagnose-before-adjusting)) |
| IB/UB mismatch | IB ≠ previous year's UB (ÅRL 2:4 p.7): exports taken at different times, late entries in the previous year, parse error, or a real error | Report the difference per account, diagnose against the source, re-export or update IB in the source. Never post undiagnosed adjustments in the opening or a closed period |
| Garbled å/ä/ö | Encoding mismatch | Detect actual encoding, re-decode |
| Duplicate verno | Series collision on import | Remap to unused series |
| Undeclared account | #TRANS references account not in #KONTO | Add #KONTO or map to existing |
| #FLAGGA 1 | File already imported | Don't import. Resetting #FLAGGA to 0 defeats the double-import guard (spec 7.4); do it only after confirming the vouchers are not already in the target |
| Missing #RAR | Can't determine fiscal year | Reject file or infer from verification dates |
| Non-zero IB on 3xxx-9xxx | Incomplete closing in source | Run closing entries before export |
| Truncated file | #KSUMMA opening present, closing missing | Reject, re-export from source |
| No VAT codes post-import | SIE carries no moms info | Manually configure in target system |

---

## Structural validation

### Missing required records
- **Check**: #FLAGGA present and first
- **Check**: #PROGRAM, #FORMAT, #GEN present
- **Check**: #FNAMN present
- **Check**: #SIETYP present for types 2-4
- **Check**: #RAR present for types 1-3 and 4E (year 0, and year -1 when a previous year exists)
- **Check**: #OMFATTN present for types 2-3
- **Severity**: FATAL for missing compulsory records

### Already imported (#FLAGGA 1)
- **Check**: `#FLAGGA 1` means the file has already been read in
- **Handling**: Don't import. Check whether the file's verifications (series, verno, date, amounts) already exist in the target.
- **Resetting to 0**: Defeats the double-import guard (spec section 7.4). Do it only after confirming the file has not been imported, and document why.
- **Severity**: FATAL for accumulating imports (verifications); may be ignored where re-reading does no harm (spec, #FLAGGA)

### Truncated file detection
- **Check**: If opening `#KSUMMA` (empty) exists, closing `#KSUMMA value` must also exist
- **If missing**: File was truncated during export or transfer
- **Severity**: FATAL. Reject the file. Re-export from source system.

### Wrong SIE type
- **Symptom**: Importing .SI (4I) file expecting .SE (4E) format
- **Difference**: 4I carries no balance or result records (#IB/#UB/#RES/#PSALDO are not allowed); #RAR and #KONTO are optional in 4I
- **Check**: Verify #SIETYP matches expected import type
- **Severity**: FATAL for type mismatch

### Malformed records
- **Check**: All lines starting with # have valid label names
- **Check**: Quoted strings properly closed (matching double quotes)
- **Check**: Escaped quotes `\"` within strings handled correctly
- **Check**: VER blocks have matching `{` and `}` on their own lines
- **Severity**: FATAL for unclosed quotes or unmatched braces

---

## Verification integrity

### Unbalanced verifications (most common error)
- **Rule**: Sum of all #TRANS amounts within a #VER = 0.00
- **Detection**: Parse each VER block, sum the #TRANS amounts, check for exact zero. Don't count #BTRANS lines, and count each #RTRANS + following #TRANS pair once.
- **Common causes**: line missing from the export, parse error (unescaped quote, decimal comma, #RTRANS/#BTRANS counted), truncated file, or rounding in the system that generated the voucher (e.g. per-line VAT in a subsystem)
- **Remediation**: Follow the [remediation workflow](#remediation-workflow-diagnose-before-adjusting). Never add a balancing line (öresutjämning or other) to an imported voucher.
- **Tolerance**: Some parsers (jsisie) offer `AllowUnbalancedVoucher` flag. Use only for analysis, never for production import.
- **Severity**: ERROR. Block import of the specific verification unless tolerance is enabled.

### Missing transaction data
- **Check**: Every #VER block contains at least one #TRANS
- **Check**: #TRANS has valid account_no (numeric) and amount (parseable decimal)
- **Check**: #TRANS amount has max 2 decimal places
- **Severity**: FATAL for empty VER blocks; ERROR for unparseable amounts

### Date validation
- **Check**: verdate in #VER is valid YYYYMMDD
- **Check**: verdate falls within a fiscal year defined by #RAR
- **Check**: If regdate provided, it is a valid date
- **Check**: If transdate in #TRANS provided, it is a valid date
- **Severity**: WARNING for dates outside fiscal year; ERROR for unparseable dates

---

## Balance continuity

### IB/UB cross-year continuity
- **Rule**: For every balance sheet account (1xxx-2xxx): UB(year -1) = IB(year 0). This is balanskontinuitet (ÅRL 2:4 p.7).
- **Detection**: Compare `#UB -1 account balance` with `#IB 0 account balance` for all accounts. A missing record means a zero balance (spec 5.17), not a mismatch.
- **Common cause**: Entries booked in the previous year after IB was transferred, previous year not finally closed, exports or files taken at different times, parse errors
- **Remediation**: Follow the [remediation workflow](#remediation-workflow-diagnose-before-adjusting). Never book an undiagnosed adjustment in the opening period.
- **Severity**: WARNING. Flag discrepancy with exact amounts. Do not silently proceed.

### Result account IB validation
- **Rule**: IB for income statement accounts (3xxx-9xxx) must be zero
- **Detection**: Check `#IB 0 account balance` for all accounts where first digit is 3-9
- **Common cause**: Source system did not complete year-end closing before export
- **Remediation**: Diagnose in the source system (previous year not closed, or the export writes result balances as #IB). Fix there and re-export. Don't book entries in the target's opening period to force the IB to zero.
- **Severity**: WARNING

### UB/RES consistency
- **Check**: For current year, UB values for balance sheet accounts should be derivable from IB + sum of relevant TRANS
- **Check**: RES values for income statement accounts should equal sum of relevant TRANS
- **Severity**: INFO (advisory check, complex to validate fully)

### Missing balances
- **Check**: All accounts referenced in #TRANS have corresponding #IB/#UB or #RES records
- **Check**: #UB for year 0 exists for all balance sheet accounts with activity (records with zero balance may be omitted, spec 5.17)
- **Severity**: WARNING for missing UB; INFO for missing IB on accounts with no prior activity

---

## Account and dimension validation

### Undeclared accounts
- **Rule**: All accounts used in #TRANS must be declared in #KONTO (for types 1-3, 4E)
- **Exception**: Type 4I files may rely on target system's existing chart
- **Detection**: Collect all account numbers from #TRANS, check against #KONTO declarations
- **Remediation**: Add missing #KONTO declarations or map to existing accounts in target
- **Severity**: ERROR for 4E files; WARNING for 4I files

### Duplicate account declarations
- **Rule**: Each account number may only appear once in #KONTO
- **Detection**: Track seen accounts, flag duplicates
- **Severity**: ERROR

### Invalid account numbers
- **Check**: Account numbers are numeric (no letters)
- **Check**: Account numbers are 4 digits (standard BAS) or valid extended length
- **Severity**: ERROR for non-numeric; WARNING for non-standard length

### Account class 9 handling
- **Note**: Class 9 (internal/management accounting) is unsupported by some programs (e.g., Visma Bokföring & Fakturering)
- **Check**: If target system doesn't support class 9, flag any 9xxx accounts
- **Severity**: WARNING

### Dimension/object mismatches
- **Check**: Dimension numbers in TRANS object lists are declared in #DIM or are standard reserved (1,2,6-10)
- **Check**: Object numbers reference objects declared in #OBJEKT
- **Severity**: WARNING for undeclared dimensions; ERROR for malformed object list syntax

---

## Verification numbering

### Duplicate verification numbers
- **Rule**: Within each series, verification numbers must be unique
- **Detection**: Track (series, verno) pairs, flag duplicates
- **Common cause**: Series collision when importing into system with existing verifications
- **Remediation**: Remap to unused series letter or offset numbering
- **Severity**: ERROR

### Gaps in numbering
- **Detection**: Within each series, check for sequential numbering (1, 2, 3...)
- **Significance**: Gaps may indicate deleted verifications. Every verification series must be unbroken and it must be possible to check this in the system (BFNAR 2013:2 p. 5.9). A series that runs across fiscal years may legitimately start above 1 in a one-year file.
- **Severity**: WARNING

### Non-ascending order
- **Rule**: Verifications within a series must appear in ascending verno order in the file
- **Detection**: Track last seen verno per series, flag if current < previous
- **Severity**: WARNING (some parsers tolerate this but it violates spec)

### Empty series/verno in 4I files
- **Rule**: 4I import files are allowed to have empty series and verno
- **Detection**: If #SIETYP 4 and series/verno empty, this is valid for import
- **Handling**: Receiving program must assign series and verno

---

## Fiscal year boundaries

### Transactions outside fiscal year
- **Check**: All #VER dates fall within a #RAR-defined period
- **Detection**: Parse all #RAR records to build valid date ranges, check each VER date
- **Severity**: WARNING. May indicate wrong fiscal year selected for export.

### Overlapping fiscal year definitions
- **Check**: #RAR records for different year indices should not overlap in date range
- **Severity**: ERROR

### Incomplete fiscal year exports
- **Check**: Compare date range of actual verifications against #RAR 0 period
- **If verifications cover only part of the year**: Flag as potentially incomplete
- **Use #OMFATTN**: This record explicitly declares the scope end date
- **Severity**: INFO

### Broken fiscal year validation
- **Check**: If #RAR shows non-calendar year (e.g., July-June), verify all period-dependent logic handles this
- **Check**: First fiscal year may be up to 18 months (AB) or shorter
- **Severity**: INFO (important for correct period assignment)

---

## Encoding errors

### Garbled Swedish characters
- **Symptom**: å/ä/ö appear as garbage in account names, company name, descriptions
- **Diagnosis**: Use mojibake patterns from encoding.md to identify mismatch type
- **Remediation**: Re-decode file with correct encoding
- **Severity**: WARNING (data is recoverable, not lost)

### #FORMAT PC8 mismatch
- **Symptom**: File declares `#FORMAT PC8` but is actually UTF-8
- **Detection**: Encoding detection algorithm identifies non-CP437
- **Impact**: #KSUMMA validation will fail
- **Handling**: Skip KSUMMA, parse with detected encoding
- **Severity**: INFO

---

## Post-import issues

### Missing VAT codes
- **Issue**: SIE format carries no VAT/moms code information
- **Impact**: Momsdeklaration/momsrapporter cannot be generated automatically
- **Remediation**: Manually configure VAT codes for relevant accounts in target system
- **Accounts affected**: 2610-2650 (output VAT), 2640-2649 (input VAT)
- **Severity**: Operational issue, not a file error

### Missing subledger data
- **Issue**: SIE 1-4 does not carry customer/supplier subledger (reskontra) data
- **Impact**: Aged receivables/payables reports unavailable
- **Remediation**: Import subledger data separately or rebuild from individual verifications
- **Severity**: Operational issue

### Verification series remapping
- **Issue**: Target system uses different series conventions than source
- **Remediation**: Map source series to target series, document the mapping
- **Best practice**: Use unused series letters in target to avoid collisions

---

## Validation severity levels

| Level | Meaning | Action |
|-------|---------|--------|
| **FATAL** | File cannot be processed | Reject file, report error, re-export from source |
| **ERROR** | Specific records invalid | Block affected records, allow rest if possible |
| **WARNING** | Data integrity concern | Import with flag, require manual review |
| **INFO** | Advisory | Log for reference, no action required |

## Recommended validation order

1. Structural checks (required records, truncation, type)
2. Encoding detection and normalization
3. Record parsing (field formats, dates, amounts)
4. Chart of accounts validation (duplicates, undeclared)
5. Balance integrity (IB/UB continuity, result account reset)
6. Verification integrity (balance check, numbering)
7. Fiscal year boundary checks
8. Dimension/object validation
9. KSUMMA verification (only if CP437)

---

## Remediation workflow: diagnose before adjusting

Applies to unbalanced verifications, IB/UB mismatches, non-zero IB on result accounts and any other difference between a SIE file and the books. Nothing is adjusted until the cause is known.

### 1. Preserve and report
- Keep the input file untouched (log its hash). Don't edit amounts, add lines or reset #FLAGGA.
- Block the affected verifications (or the whole file for structural errors).
- Report the exact difference. Verifications: series, verno, date, line count, sum. Balances: account, `#UB -1`, `#IB 0`, difference.

### 2. Diagnose against the source
Compare with the source ledger (verifikationslista, huvudbok, balansrapport) or a fresh export:
- **Missing transactions**: line count and per-account amounts per verification versus the source; #TRANS totals per account versus #RES (or #UB − #IB) in the same file
- **Parse errors**: unescaped quotes, decimal commas, truncated lines, wrong encoding shifting fields, #RTRANS counted together with its #TRANS, #BTRANS counted
- **Exports taken at different times**: #GEN and #OMFATTN dates, files from different exports combined, entries registered in the previous year after IB was transferred (regdate on #VER)
- **Rounding**: accept only when the source voucher or its underlying document shows the öre difference (e.g. per-line VAT rounding in a subsystem)

### 3. Fix the cause
- **Parser error**: fix the parser and re-read the unchanged file
- **Incomplete, truncated or mismatched export**: re-export from the source (all years at the same point in time) and validate again
- **Late entries in the previous year**: update IB in the source system so IB = UB (ÅRL 2:4 p.7), then re-export
- **Rounding in a subsystem**: the generating system writes the öresutjämning line (3740 Öres- och kronutjämning) in the voucher it creates; regenerate the file

If the books are right and only the file was wrong, no correction entry is needed.

### 4. Correct real errors with a rättelsepost
Only when the diagnosis shows that the books themselves are wrong:
- Book a separate rättelsepost with its own verifikation (BFNAR 2013:2 p. 2.17-2.18). The original entry stays unchanged and readable.
- Book it in the redovisningsperiod in which the error is discovered (or in the period being reconciled, if the work on that period is not yet finished), never in a period whose work is already closed and never as an opening-balance entry.
- Show when and by whom the correction was made, and make it traceable from the corrected entry, e.g. by noting the rättelsepost's verification number on it (BFL 5:5).
- Document the difference, the source comparison and the cause (BFNAR 2013:2 p. 2.16), and have the correction approved by the person responsible for the bookkeeping before it is booked.

**IB/UB mismatch from a real error in a closed year**: IB must equal the previous year's UB (ÅRL 2:4 p.7), so the closed year and the IB stay as they are and the correction is booked in the current year. For fiscal years beginning after 2025-12-31, the annual report may present the correction by restating the opening balance: under K2 p. 2.12 (BFNAR 2025:2) this is the main rule (the effect may instead go through the income statement), and under K3 a smaller company may restate the opening balance instead of the comparatives. In the bookkeeping, the entry is still made in the current year, in the period the correction is made.

### Never
- Insert a balancing line into an imported voucher
- Book an undiagnosed difference to 3740, a suspense account or equity
- Post adjustments in a closed period or in the opening balance
- Reset #FLAGGA to 0 without confirming the file has not been imported

### Worked example: export omits one transaction

```
#VER L 57 20260314 "Leverantörsfaktura 4471" 20260316
{
    #TRANS 2440 {} -12500.00
    #TRANS 2640 {} 2500.00
}
```

1. **Report**: L 57 sums to -10000.00 over 2 lines. The file is left unchanged and L 57 is blocked.
2. **Diagnose**: The source verifikationslista shows L 57 with 3 lines: 2440 -12 500.00, 2640 2 500.00, 6110 10 000.00. In the same file, the #TRANS lines on 6110 add up to 10 000.00 less than `#RES 0 6110`. The source voucher balances, so the export dropped a line and the books are correct.
3. **Fix**: Re-export from the source (report the fault to the vendor if it recurs) and validate again: L 57 balances and #TRANS totals per account agree with #RES. Import. No correction entry is needed.
4. **Wrong fix**: adding a balancing line (e.g. `#TRANS 3740 {} 10000.00`) to L 57. It hides the missing cost, misstates 6110 and 3740, and the imported voucher no longer matches the source verifikation.

If L 57 had already been imported incomplete, with the difference parked on a suspense account, the target's books are wrong. Book a rättelsepost in the current period that moves 10 000.00 from the suspense account to 6110, references L 57 and the diagnosis, and is approved before booking.

---

## SIE file diffing

### Comparing two SIE files

To detect changes between two exports (e.g., before/after a correction period, or during migration validation):

1. **Balance diff**: Compare #IB/#UB records by account. Flag any amount differences.
2. **Result diff**: Compare #RES records by account.
3. **Verification diff**: Match #VER blocks by (series, verno). Compare:
   - Transaction amounts per account
   - Transaction dates
   - Number of lines
   - Total verification count per series
4. **Added/removed verifications**: Identify VER blocks present in one file but not the other.
5. **Period diff**: Compare #PSALDO month-by-month per account.
6. **Chart diff**: Compare #KONTO declarations (added/removed/renamed accounts).
7. **Metadata diff**: Compare #FNAMN, #ORGNR, #RAR, #KPTYP for structural changes.

### Implementation reference

The .NET library `jsisie` provides `SieDocumentComparer.Compare()` returning a structured diff list. For custom implementations, key data structures are:
- Map<(series, verno), VER_block> for verification matching
- Map<(year_no, account), balance> for IB/UB/RES comparison
- Map<(year_no, period, account), balance> for PSALDO comparison