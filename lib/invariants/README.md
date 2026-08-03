# `lib/invariants`

Shared **product contracts**: the formats and bounds that more than one consumer
must agree on, with the reason for each rule recorded next to it.

## What belongs here

A rule belongs here only when consumers **outside the owning module** need the
identical invariant to validate input or to generate compatible output.

Our consumers are the web app, the public `/api/v1` surface, the MCP server, the
SIE importer and exporter, and the Skatteverket-bound generators (AGI, KU10,
SRU, iXBRL). When two of those disagree about what a valid value looks like, the
disagreement is invisible until a customer's filing fails.

## What does not belong here

- **Rules specific to one module.** They stay in that module.
- **General helpers.** `lib/utils.ts`, `lib/money.ts`.
- **Database questions.** "Is this account in the company's chart?" is
  `lib/bookkeeping/account-validation.ts`, not a format rule.
- **Business rules.** "Is this fiscal year open?" is a period question.

## Naming

The name must make the owning concept explicit. `isAccountNumber`, not
`isValidNumber`. Two rules in here share a byte-identical regex (`account-number`
and `fiscal-year` are both `/^\d{4}$/`) and mean entirely different things: the
names are the only thing keeping a call site honest, so they carry the weight.

## Layout

| File | Owns |
|---|---|
| `org-number.ts` | Swedish organisationsnummer / personnummer: canonical 10-digit form, Luhn, Skatteverket 12-digit conversion |
| `account-number.ts` | BAS account number format (4 digits, always a string) |
| `iso-date.ts` | `YYYY-MM-DD` shape, plus a real-calendar-date check |
| `fiscal-year.ts` | Four-digit räkenskapsår key |
| `zod.ts` | Zod primitives built from the rules above, for API schemas |

`zod.ts` is separate so that consumers which do not use Zod (the MCP server,
report generators) can import a rule without pulling the dependency in.

## Adding a rule

1. Write the rule and the **reason** in the docblock. A rule without a recorded
   reason gets re-litigated or worked around within a quarter.
2. Export a pure validator (primitives in, boolean or `null` out).
3. Add the Zod primitive to `zod.ts` if an API surface needs it.
4. Replace the hand-rolled copies. `npm run check:guards` tracks how many remain
   and fails if the count goes up.
