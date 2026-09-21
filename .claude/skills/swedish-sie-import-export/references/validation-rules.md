# SIE4 Validation Rules and Error Patterns

## Table of contents
1. [Structural validation](#structural-validation)
2. [Verification integrity](#verification-integrity)
3. [Balance continuity](#balance-continuity)
4. [Account and dimension validation](#account-and-dimension-validation)
5. [Verification numbering](#verification-numbering)
6. [Fiscal year boundaries](#fiscal-year-boundaries)
7. [Encoding errors](#encoding-errors)
8. [Post-import issues](#post-import-issues)
9. [Validation severity levels](#validation-severity-levels)
10. [SIE file diffing](#sie-file-diffing)

---

## Structural validation

### Missing required records
- **Check**: #FLAGGA present and first
- **Check**: #PROGRAM, #FORMAT, #GEN present
- **Check**: #FNAMN present
- **Check**: #SIETYP present for types 2-4
- **Check**: #RAR present for types 1-3 and 4E (with both year 0 and year -1)
- **Check**: #OMFATTN present for types 2-3
- **Severity**: FATAL for missing compulsory records

### Truncated file detection
- **Check**: If opening `#KSUMMA` (empty) exists, closing `#KSUMMA value` must also exist
- **If missing**: File was truncated during export or transfer
- **Severity**: FATAL. Reject the file. Re-export from source system.

### Wrong SIE type
- **Symptom**: Importing .SI (4I) file expecting .SE (4E) format
- **Difference**: 4I lacks balances, results, fiscal year definitions, chart of accounts
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
- **Detection**: Parse each VER block, sum all TRANS amounts, check for exact zero
- **Common cause**: VAT rounding across multiple line items producing 0.01 SEK discrepancy
- **Remediation**: Add öresutjämning line using account 3740 (Öres- och kronutjämning) for the difference; BAS has no 3741
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
- **Rule**: For every balance sheet account (1xxx-2xxx): UB(year -1) = IB(year 0)
- **Detection**: Compare `#UB -1 account balance` with `#IB 0 account balance` for all accounts
- **Common cause**: Incomplete year-end closing, post-closing manual adjustments, mixed-date exports
- **Remediation**: Create adjustment verification in opening period to reconcile
- **Severity**: WARNING. Flag discrepancy with exact amounts. Do not silently proceed.

### Result account IB validation
- **Rule**: IB for income statement accounts (3xxx-9xxx) must be zero
- **Detection**: Check `#IB 0 account balance` for all accounts where first digit is 3-9
- **Common cause**: Source system did not complete year-end closing before export
- **Remediation**: Run closing entries in source system and re-export, or create closing entries in target
- **Severity**: WARNING

### UB/RES consistency
- **Check**: For current year, UB values for balance sheet accounts should be derivable from IB + sum of relevant TRANS
- **Check**: RES values for income statement accounts should equal sum of relevant TRANS
- **Severity**: INFO (advisory check, complex to validate fully)

### Missing balances
- **Check**: All accounts referenced in #TRANS have corresponding #IB/#UB or #RES records
- **Check**: #UB for year 0 exists for all balance sheet accounts with activity
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
- **Significance**: Gaps may indicate deleted verifications. BFL requires unbroken sequences for customer invoices.
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