# Konteringspaket

Reusable bookkeeping patterns, as data. One YAML file per pattern.

These are the templates a user picks in the app when booking something common:
representation, EU-handel, periodiseringsfond, löneutbetalning. They used to be
rows frozen inside a database migration. They are files now, so correcting one
is a one-line edit and a green CI run instead of a new migration.

## Anatomy

```yaml
meta:
  slug: representation-avdragsgill-25-moms   # filename must match, this is the public key
  order: 13                                  # display order, unique across the catalogue
  name: 'Representation (avdragsgill, 25% moms)'
  category: representation                   # eu_trade | tax_account | private_transfer |
                                             # salary | representation | year_end | vat |
                                             # financial | other
  entity_type: all                           # all | enskild_firma | aktiebolag
  description: >-
    Extern representation med avdragsgill moms. Max 300 kr/person exkl. moms.
lines:
  - account: '6072'                          # BAS account, ALWAYS quoted (it is a string)
    label: 'Representation avdragsgill'
    side: debit
    type: business
    ratio: 0.8
  - account: '2641'
    label: 'Ingående moms'
    side: debit
    type: vat
    vat_rate: 0.25
  - account: '1930'
    label: 'Företagskonto'
    side: credit
    type: settlement
    ratio: 1.0
```

## The three line types

The user types one total amount. The type decides how each line's amount is
derived from it (`applyTemplate()` in `lib/bookkeeping/template-library.ts`):

| Type | Amount | Carries |
|---|---|---|
| `vat` | `total * vat_rate / (1 + vat_rate)` | `vat_rate`, never `ratio` |
| `business` | `total * ratio` | `ratio`, never `vat_rate` |
| `settlement` | `total * ratio` | `ratio`, never `vat_rate` |

`settlement` is the money leg (the bank account, the reskontra). `business` is
the cost or revenue. Putting a `ratio` on a `vat` line silently computes the
wrong amount, so the schema rejects it rather than trusting you to remember.

## Rules the CI gate enforces

Run `npm run validate:packs` before pushing. It checks:

1. The schema, including the `vat_rate` / `ratio` split above.
2. Filename equals `meta.slug`.
3. `meta.slug` and `meta.order` are unique across the catalogue.
4. **Every account exists in the BAS 2026 chart.** A pack may only reference
   standard accounts, because a non-standard one cannot be seeded into a
   company's chart and the template will fail to apply.
5. **The pack balances** at five probe amounts, applied through the real
   `applyTemplate()`. Debits must equal credits or the verifikat cannot post.
6. Both a debit and a credit line are present.

## Account numbers are strings

`account: '1930'`, never `account: 1930`. YAML would read the unquoted form as
a number, and a BAS account is an identifier, not a quantity. The schema
rejects it, but quote it anyway so the file reads correctly.

## Swedish stays Swedish

`name`, `description` and `legal_note` are user-facing Swedish and are not
translated, in either locale. They are statutory content, per
`.claude/rules/i18n.md`.

## Known-broken templates

Four packs ported out of the original migration have pre-existing problems
(an unbalanced salary template, and accounts that no longer exist in BAS 2026).
They are listed in `KNOWN_BROKEN` in `scripts/validate-packs.ts` with the reason
for each. They are quarantined, not accepted: the list may only shrink, and
fixing one means deleting its entry. Each needs a Swedish accounting decision
rather than a code change, which is why they were not fixed during the port.

## Adding a pack

1. Copy the closest existing file, rename it to your slug.
2. Set `meta.order` to one past the current highest.
3. Run `npm run validate:packs`.
4. New user-facing strings go in the YAML, not in `messages/*.json`: a pack
   carries its own Swedish.
