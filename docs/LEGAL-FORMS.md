# Legal Forms: Capability Profiles

A legal form (`EntityType`: `enskild_firma`, `aktiebolag`, `ideell_forening`, next `ekonomisk_forening` and `bostadsrattsforening`) changes what the ledger must do: which equity account a year closes to, whether an owner exists, which tax return is filed, which report exists. This document is the contract for how that variation is expressed in code so that the fourth and fifth form cost one file each, not another sweep of the codebase.

Status: proposed 2026-09-17. Merging this document adopts the contract. It applies to every change under `src/lib/company/**` and to every site that today compares `entity_type` to a string.

## The problem in numbers (main, 2026-09-17)

`src/lib/company/entity-type.ts` already holds the form-dependent facts behind `byEntityType`, whose `Record<EntityType, T>` arms make the compiler reject a new form until every fact has an answer. That part is right. Everything that bypasses it grows per form:

- 69 literal comparisons (`=== 'aktiebolag'`, `=== 'enskild_firma'`) in 45 non-test files. Each sends a new form down whichever branch it was not written for, and nothing forces an edit. The four ledger-affecting förening defects found in the 2026-09-17 audit all live here (SIE opening balance on a hard-coded 2099, the year-end dispositions step, the dispositions route, the MCP EF preview).
- `isEf ? … : …` copy ternaries with paired `_ef` / `_ab` i18n keys, in two languages.
- 93 form-name tags in `src/lib/bookkeeping/booking-templates.ts`, plus `entityOnly` in `src/lib/reports/catalog.ts` and form conditions in `src/lib/tax/deadline-config.ts`. Payroll templates are aktiebolag-only today because nobody widened a tag, not because of law.
- `seed_chart_of_accounts` re-declared in full in seven migrations.
- 1,582 distinct BAS account literals in 176 files. That is the jurisdiction weld, not the form weld, but every form change adds a few.

## The rule

Code asks what a company can do. It never asks which form it is.

A form is data: one profile object. A capability is the API: a named field on the profile. A call site that needs to know whether to show the INK2 page reads `profile.filings.incomeReturn === 'INK2'`, never `entityType === 'aktiebolag'`. Adding a form is one profile file plus one line in `supported_entity_types()`, with zero call-site edits.

The contributor design for ekonomisk förening (PR #2652) reached the same conclusion and started it: `usesInk2`, `booksCurrentTax`, `supportsCorporateTaxDispositions`, `supportsAccountingFramework`, `requiresAuditorRegardlessOfSize`, `supportsMemberCapital`, and array-valued `entity_applicability`. Those become fields of the profile below; the functions stay as thin readers during the transition.

## The contract

```ts
// src/lib/company/forms/types.ts
export interface LegalFormProfile {
  jurisdiction: 'SE'
  /** DB value and v1 API value. Never renamed. */
  code: EntityType
  /** Statutory Swedish name, shown as-is in both locales. */
  label: string
  /** NEXT_PUBLIC_* gate while the form is in beta; absent when open. */
  creationFlag?: string

  identity: { orgId: 'personnummer' | 'organisationsnummer' }
  fiscalYear: { calendarOnly: boolean }
  bookkeeping: {
    defaultMethod: 'cash' | 'accrual'
    /** Regelverk label for the 5 000 kr accrual threshold. */
    simplifiedRegelverk: 'K1' | 'K2'
    /** Which booking-template column the form reads: base (written for EF) or the `_ab` override. */
    templateColumn: 'base' | 'ab'
  }
  equity: {
    /** Account the year's result closes to, and the carry at next year start. */
    closing: string
    closingName: string
    priorYearCarry: string | null
    hasOwners: boolean
    /** Money settled with the owner or member: EF 2013/2018, AB 2893, förening 2890. */
    settlement: { withdrawal: string; contribution: string }
  }
  filings: {
    /** The return the product prepares for the form; null when none is modelled (ideell: INK3 not built). */
    incomeReturn: 'INK2' | 'NE' | 'INK3' | null
    booksCurrentTax: boolean
    corporateTaxDispositions: boolean
    arsredovisning: boolean
    frameworks: ReadonlyArray<'K1' | 'K2' | 'K3'>
  }
  /** Swedish words that differ by law. Everything else in copy stays form-neutral. */
  glossary: { entity: string; owner: string; meeting: string }
}
```

- `src/lib/company/forms/index.ts` exports `LEGAL_FORMS: Record<EntityType, LegalFormProfile>`. The `Record` keeps compile-time exhaustiveness at the one place it belongs: profile construction.
- `src/lib/company/entity-type.ts` keeps `ENTITY_TYPES`, `parseEntityType`, `resolveCompanyEntityType` and the flag helpers. Its fact functions (`resultClosingAccounts`, `ownerSettlementAccount`, `preparesArsredovisning`, `fiscalYearLockedToCalendar`, `usesPersonnummerAsOrgNumber`, `defaultAccountingMethod`, `simplifiedYearEndRegelverk`, and the seven from #2652) become one-line readers of the profile and stay exported, so existing callers keep working.
- `byEntityType` is not used outside `src/lib/company/forms/**`.
- The registry is keyed by `(jurisdiction, code)` from the first day. `jurisdiction` is the literal type `'SE'` until a second country exists. No DB column, no API change, no migration now: the 2026-08-25 jurisdiction analysis owns that step.
- Every profile's account numbers must exist in `src/lib/bookkeeping/bas-data`, and the closing and settlement accounts in the chart that `seed_chart_of_accounts` produces for that form. A unit test asserts the first, a pg-real test the second (the carry account is left to the engine's on-demand creation, as the AB seed does with 2098).
- A field every form answers the same way is a constant, not a capability, and a unit test refuses it. Fields for a form that is not shipped (member capital, a mandatory revisor) arrive with that form.

## Rules for the code around it

1. **No form names at call sites.** `entity_type === '…'`, `isEf`, `isAb`, and `?? 'enskild_firma'` defaults are replaced by a profile field as the file is touched. A file that needs a form name for a reason the profile cannot express (a Bolagsverket registry mapping, a migration, a test fixture) says why in a comment.
2. **Data is tagged by capability, form lists only when the law is form-specific.** A booking template, pack, report or deadline that applies to every employer says `requires: 'employer'`; one that needs an owner says `requires: 'hasOwners'`. A list of form codes is allowed only when the rule is genuinely about that form (an AB-only aktiekapital template), and it is an array, never a single string.
3. **Copy is form-neutral by default.** Write "företaget" and "verksamheten" where the law does not differ. Where it does, read the word from `profile.glossary`. No new `_ef` / `_ab` key pairs in `messages/*.json`.
4. **Account numbers come from the profile or the chart data.** New code does not add inline BAS literals for equity, settlement or result accounts; it reads them from the profile. Other account literals follow the existing chart data path (`getBASReference()`).
5. **SQL stays thin.** The three CHECK constraints keep validating through `supported_entity_types()`; a new form appends one value in one migration. The chart seed moves from a re-declared function to a `chart_seed_accounts(entity_type, …)` table read by one generic function when the next form is scheduled, so a form becomes an INSERT, not a seventh copy.
6. **Presentation may order forms.** The onboarding picker shows aktiebolag and enskild firma as the two primary cards and every other form under "Förening eller annan form", each marked creatable or coming soon from the registry. That is the only place a form name is a UI concern, and it is data-driven.

## Enforcement

The document does not enforce anything. These do:

- **Type exhaustiveness** at `LEGAL_FORMS: Record<EntityType, LegalFormProfile>`: a widened union does not compile until the profile exists.
- **Ratchet `literalLegalForm`** in `scripts/checks/no-new-antipatterns.mjs`, baseline in `antipatterns-baseline.json`: counts form-code string literals in comparisons, ternaries, defaults and single-string tags under `src/lib/`, `app/`, `components/`, `extensions/`, excluding tests and `src/lib/company/forms/**`. Baseline is the count at implementation time (69 comparisons today, tags counted separately). It may only go down. `npm run check:guards` fails on an increase.
- **Ratchet on inline BAS literals in new files**, per-file like `providerHosts`: grandfathers the 176 files that carry them today, fails a new file that introduces one outside the chart data.
- **pg-real test per form** (`<form>-entity-type.pg.test.ts`): CHECK accepts the value, the three create RPCs accept it, and the seeded chart contains the profile's equity accounts.
- **This rule file**: `.claude/rules/legal-forms.md` loads for agents touching the affected paths and points here.

## What "supported" means

A form is not supported when onboarding accepts its label. It is supported when it flows through every surface below. The creation flag stays on until the list is green; a flag switched on with red items is a beta, and the picker says "beta".

| Surface | Where |
|---|---|
| Creation: lookup mapping, picker, BankID picker, `POST /api/v1/companies`, MCP `gnubok_create_company` | `src/lib/company-lookup`, `components/onboarding`, `src/lib/company/create-company.ts` |
| Chart seed with the form's equity block and its typical income and cost accounts | `seed_chart_of_accounts` |
| Booking templates, packs, category mapping, AI categorisation defaults | `src/lib/bookkeeping`, `src/lib/packs`, `src/lib/agent/categorize` |
| Customer invoices, supplier invoices, expense claims (settlement account and wording) | `src/lib/invoices`, `src/lib/expenses` |
| VAT: registration default, deadline schedule, non-registered booking | `src/lib/vat`, `src/lib/tax/deadline-config.ts` |
| SIE import and export: equity accounts, opening-balance difference account, prior-year result | `src/lib/import` |
| Payroll: allowed, personnel accounts, form-specific rules | `src/lib/salary` |
| Year-end: closing account, carry, wizard steps, documents | `src/lib/core/bookkeeping`, `src/lib/bokslut`, `components/bookkeeping/year-end` |
| Filings: the right return is reachable, the wrong ones are hidden and refuse | `src/lib/reports`, `src/lib/bokslut/arsredovisning` |
| Deadlines: at least the form's statutory set, no empty-list banner | `src/lib/tax/deadline-config.ts` |
| Reports and navigation | `src/lib/reports/catalog.ts`, `components/dashboard` |
| MCP tools, v1 API enums, agent skills and atoms say the same as the app | `extensions/general/mcp-server`, `app/api/v1` |
| Copy in `sv` and `en`, help page, docs | `messages/*.json`, `app/(dashboard)/help` |
| Change of form for a company created under the wrong one | `correct_company_entity_type` and the posted-history path |

## Migration path

No big-bang refactor. The contract is adopted by the next changes that would otherwise add literals:

1. **Slice 1, with the ideell förening pre-flip fixes.** The six fixes from the 2026-09-17 audit are each a literal gate that should become a profile read: the SIE opening-balance account (`equity.closing`), the dispositions step and route (`filings.incomeReturn`, `filings.corporateTaxDispositions`), the "Skapa årsredovisning" button (`filings.arsredovisning`), the MCP EF preview and year-end text (`filings.incomeReturn`, `equity.closing`). The `literalLegalForm` ratchet ships in the same PR with the baseline set there.
2. **Slice 2, as files are touched.** The remaining literal sites are converted when a PR edits them for any reason. The ratchet guarantees the count never rises; no sweep is scheduled.
3. **Slice 3, when the next form is scheduled.** The chart-seed table. Two days, worth doing only when it saves a migration.
4. **The #2652 stack** rebases onto the profile: its seven capability functions map one-to-one to profile fields, and its array tags are rule 2.

## Non-goals

- Renaming DB or v1 API values (`aktiebolag` stays `aktiebolag`; no namespacing).
- Legal forms as extensions. A form varies law that the kernel and the triggers must know at commit time; a form whose extension is off would book wrongly rather than fail. Extensions stay for connectors and verticals.
- A jurisdiction layer, SEK column renames, or changes to the `rutaNN` VAT contract. Those wait for a second country as the forcing function.
- Abstractions with one implementation. Every profile field must have at least two forms that answer it differently, or it is a constant and does not belong here.

## Open founder decisions

1. Adopt this contract (merge), so that Emil, the ekonomisk förening contributor and agents build against the same shape.
2. Rebase order: the contributor rebases #2652 onto the profile, rather than the profile adapting to #2652.
3. Timing of the chart-seed table: with `ekonomisk_forening`, or later.
