---
paths:
  - "lib/company/**"
  - "lib/company-lookup/**"
  - "lib/bookkeeping/booking-templates.ts"
  - "lib/bookkeeping/category-mapping.ts"
  - "lib/packs/**"
  - "lib/reports/catalog.ts"
  - "lib/tax/deadline-config.ts"
  - "lib/bokslut/**"
  - "lib/import/**"
  - "components/onboarding/**"
  - "components/bookkeeping/year-end/**"
---

# Legal Forms

The contract is `docs/LEGAL-FORMS.md`. Read it before adding or branching on a legal form. The short version:

1. **Never compare `entity_type` to a string at a call site.** Read a capability from the form's profile (`lib/company/forms/**`, or the reader functions in `lib/company/entity-type.ts` until the profile lands): `resultClosingAccounts`, `ownerSettlementAccount`, `preparesArsredovisning`, `fiscalYearLockedToCalendar`, `usesPersonnummerAsOrgNumber`, `defaultAccountingMethod`, `simplifiedYearEndRegelverk`. If no capability expresses what you need, add one to the profile for every form; do not add a literal. The `literalLegalForm` ratchet in `npm run check:guards` fails on a new one.
2. **Never default a missing form** (`?? 'enskild_firma'`, `?? 'aktiebolag'`). Use `resolveCompanyEntityType()`; a wrong form books to the wrong equity account.
3. **Tag data by capability** (`requires: 'employer'`, `requires: 'hasOwners'`), and by an array of form codes only when the law is about that specific form.
4. **Copy is form-neutral** ("företaget", "verksamheten"); words that differ by law come from the profile glossary. No new `_ef` / `_ab` message-key pairs.
5. **Account numbers for equity, result and settlement come from the profile**, never inline.

A form is supported only when it flows through every surface in the checklist in `docs/LEGAL-FORMS.md`. The creation flag stays until then.
