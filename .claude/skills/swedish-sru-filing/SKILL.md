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

SRU files are what Skatteverket's filöverföringstjänst accepts. The canonical source is Skatteverket's "Teknisk information om filöverföring" page (replaced brochure SKV 269 from Jan 1 2024).

**Before writing any SRU generation code**, read both reference files. Almost every failure is a wrong field code, a wrong sign, or the wrong text encoding.

## How to use this skill

| File | When to read |
|---|---|
| `references/file-format.md` | The file itself: post-by-post structure of both files, period suffixes, ISO 8859-1 encoding, amount and org number formatting, the sign convention, zero-value handling, a worked example for a calendar-year AB, validation errors, data types, spec links |
| `references/sru-codes.md` | Deciding what goes in each `#UPPGIFT`: the full field code tables for INK2, INK2R and INK2S with their printed signs, and the BAS-to-SRU account mapping for the räkenskapsschema |

## Architecture: two files, always

Every SRU submission consists of exactly two files:

| File | Content | Max size |
|---|---|---|
| `INFO.SRU` | Submitter metadata (who is filing) | N/A |
| `BLANKETTER.SRU` | All blankett blocks with tax data | 5 MB |

File names are case-insensitive but must not be renamed (browsers appending `(1)` cause rejection).

An aktiebolag filing INK2 needs **three** blankett blocks inside BLANKETTER.SRU: `INK2`, `INK2R` and `INK2S`, each with its own `#IDENTITET` line, all terminated by a single `#FIL_SLUT`.

## Generating a file

1. **Fix the period.** The blankett type is `<FORM>-<inkomstår><P1-P4>`, where the income year is the calendar year the räkenskapsår *ends* and the suffix encodes the ending month. Calendar-year companies are `P4`.
2. **Write INFO.SRU** with the posts in their prescribed order; mandatory are `#PRODUKT`, `#FILNAMN`, `#ORGNR`, `#NAMN`, `#POSTNR`, `#POSTORT`.
3. **Map the trial balance to INK2R** via the BAS-to-SRU tables, then compute INK2S by hand, then carry 4.15/4.16 (7670/7770) to INK2 1.1/1.2 (7104/7114).
4. **Convert every amount** to whole kronor, truncating öre, and to the form's printed sign: not the trial balance's sign. Omit any field whose value is zero.
5. **Write both files as ISO 8859-1**, never UTF-8, and upload them under their exact names.

Field-by-field detail for each step is in the two reference files.

## Never guess these

| Situation | Why | What to do |
|---|---|---|
| A field code for a row | Codes are published per period package, and a code invalid for the blankett type rejects the whole block | Look it up in `sru-codes.md`; never infer one from a neighbouring code |
| The sign of an amount | SIE and most ledgers store credit balances as negative: the opposite of what the form wants | Report the printed sign as positive; see `sru-codes.md` §8 |
| Any single BAS account in 5000-6999 | They ALL aggregate into one code, **7513**; per-account codes are the most common mapping error | Sum the range, write one `#UPPGIFT 7513` |
| An INK2S value | INK2S codes are NOT auto-derived from BAS accounts: they are tax adjustments requiring manual calculation | Take them from the tax computation, not the ledger. The result lands in 7670/7770 (4.15/4.16, carried to INK2 7104/7114); 8020/8021 are 4.17/4.18, the accumulated värdeminskningsavdrag on buildings and land improvements, never the result fields |
| The text encoding | UTF-8 silently corrupts å, ä, ö and is the commonest cause of validation failure | Write ISO 8859-1 explicitly; see `file-format.md` §3 |
| Whether a zero belongs in the file | A `#UPPGIFT` for a zero value causes warnings and sometimes errors | Omit the line entirely |

## Related skills

| Question | Skill |
|---|---|
| Getting the trial balance out of the accounting system | `swedish-sie-import-export` |
| INK2 form logic, skattemässiga justeringar, N9 | `swedish-financial-reporting` |
| Bokslut, closing entries and the result that feeds 4.1 | `swedish-year-end-closing` |
| Periodiseringsfond, koncernbidrag, schablonintäkt | `swedish-tax-planning` |
| Överavskrivningar and värdeminskningsavdrag behind 4.9 | `swedish-asset-accounting` |
