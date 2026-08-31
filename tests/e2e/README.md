# End-to-end environment (local stack)

A production-shaped stack you can run on a laptop: the real schema, the real
auth service, the real storage service, and fakes for the outside world.

**The browser suite lives in `spectest/`**, which boots the same shape inside a
microVM and drives Chromium against it. This directory is the local half: the
stack you can poke at by hand, plus the contract tests that keep the Enable
Banking fake honest against the real client.

## Start it

```bash
bash tests/e2e/setup-env.sh          # Supabase + grants + fake bank + .env.e2e
set -a && . ./.env.e2e && set +a     # load the env into your shell
npm run dev -- --port 3000
```

`setup-env.sh` is idempotent. Re-running it reuses the running stack and the
existing keypair.

## Why it never touches .env.local

`.env.local` points at the **production** database. A suite that drives a
browser through onboarding writes companies, journal entries and bank
connections; pointed at production, that lands in real customer data. So the
setup script generates its own `.env.e2e` from `supabase status` and reads
nothing else. The git worktree deliberately has no `.env.local` at all.

## What is real and what is faked

| Layer | Local | Notes |
|---|---|---|
| Postgres | real | `supabase/postgres`, every migration in `supabase/migrations/` applied, so triggers, RLS and RPCs behave as in production |
| Auth (GoTrue) | real | MFA stays on (`NEXT_PUBLIC_REQUIRE_MFA=true`); the suite enrols TOTP and computes codes via `spectest/lib/totp.ts` |
| Storage | real | storage-api, so underlag upload is exercised rather than stubbed |
| Enable Banking | fake | `fakes/enable-banking-server.mjs` |
| VIES (EU VAT register) | fake | `spectest/fakes/vies.ts`, answering at `ec.europa.eu` |
| Skatteverket, Fortnox, Qvalia, Bedrock | not yet faked | see "Still missing" |

## The Enable Banking fake

`ENABLE_BANKING_API_URL` is an env var, so the production client talks to the
fake without a single line of test-only code in `extensions/`.

It is faithful where it matters:

- The app signs a genuine RS256 JWT and the fake **verifies the signature**
  against the test keypair. A regression in `lib/jwt.ts` fails here.
- Handelsbanken carries a *hidden* DECOUPLED Mobile BankID method and Lunar a
  *visible* one, which is exactly the distinction
  `selectPreferredAuthMethod()` exists to make (the PR #854 regression).
- `/auth` returns an SCA page that looks like a bank's BankID step, so a
  browser replay shows a real-looking consent flow.
- Transactions paginate via `continuation_key`, so the pagination loop in
  `getAllTransactions()` is actually covered.

Unhappy paths are driven from the test:

```js
fake.scenario.sessionStatus = 'CLOSED'   // consent died bank-side
fake.scenario.transactionsError = 429    // upstream rate limit
fake.scenario.authError = 500            // /auth fails
```

Or over HTTP when the server runs standalone:

```bash
curl -X POST localhost:4010/__fake/scenario -d '{"sessionStatus":"CLOSED"}'
curl localhost:4010/__fake/state    # what the app actually asked for
curl -X POST localhost:4010/__fake/reset
```

## Tests

```bash
npx vitest run tests/e2e --project unit
```

**Do not run the rest of the suite in a shell that has sourced `.env.e2e`.**
The unit tests mock Supabase and expect a clean environment; with real
`NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` in scope,
`ensureInitialized()` takes a different path and around 700 of them fail for
reasons that have nothing to do with the code. Use a fresh shell for
`npm test`.

- `enable-banking-fake.test.ts` is the contract test: the real client against
  the fake, no database. Runs anywhere, including CI.
- `enable-banking-sync.e2e.test.ts` runs the real `syncAccountTransactions()`
  into the real local Postgres and checks what landed: signs, öre, stable
  external ids, idempotency on re-sync, and that no transaction lands without
  a description. Skips itself unless `NEXT_PUBLIC_SUPABASE_URL` points at
  localhost, so `npm test` and CI stay green without the stack.

## Three tests are red on purpose

None is flaky and none is broken. Each pins a filed bug, and each fails with
the bug stated in its assertion message.

| Test | Issue |
|---|---|
| `kontantmetod.ts` → the payment is recorded in the reskontra, not only in the ledger | [#2019](https://github.com/erp-mafia/accounted/issues/2019) |
| `reverse-charge.ts` → an EU customer cannot be saved with Sweden as its country | [#2025](https://github.com/erp-mafia/accounted/issues/2025) |
| `reverse-charge.ts` → the periodiska sammanställningen files an ISO country code | [#2028](https://github.com/erp-mafia/accounted/issues/2028) |

The first is a money bug. `settleInvoicePayment` books the entry and flips the
status but never inserts into `invoice_payments`, so a manually registered
payment exists as a verifikat and nowhere else. The year-end cut-off under
kontantmetoden reads the payment DATE from that table, by design, and treats a
fully paid invoice as outstanding when the row is missing: a kundfordran plus
vilande moms for revenue already booked.

The other two share a root: `customers.country` is free text with no defined
format, defaulting to the English word "Sweden", while the reports read it as
an ISO code. One consequence is that an "EU-företag" in Sweden saves without
complaint and unlocks a 0 % invoice; the other is that the SKV 5740 file
carries `GERMANY811234567` where the buyer's VAT number belongs. Fixing the
format fixes both.

Fix the bugs or park the tests before wiring this into a merge gate. Do not
"fix" them by weakening the assertions.

Two red tests became green when the branch caught up with `main` on
2026-08-31: `booking.ts` → a partially booked transaction is still work to do
([#1947](https://github.com/erp-mafia/accounted/issues/1947), fixed by
`f0af4ad4e`) and `storno.ts` → storno puts the bank transaction back on the
worklist ([#1950](https://github.com/erp-mafia/accounted/issues/1950), fixed by
`cb9ae15d4`). They are ordinary regression tests now. That is what these are
for: the tests were written against the bug and kept the shape of the fix
honest without anyone re-deriving it.

Tests that read the DB after a UI action go through `ctx.poll`, including the
negative ones. Reading straight after the click made #2025's test pass for the
wrong reason: the row it was asserting the absence of had merely not been
written yet.

## Both correction tracks are covered

BFL 5 kap. 5 § allows exactly two ways to correct a posted verifikat, and the
suite walks both:

- `storno.ts`: cancel with a mirroring entry. The original survives, marked
  reversed, and the pair nets to zero.
- `inline-rattelse.ts`: strike and replace lines inside the same verifikat
  while the period is open and unlocked. No new voucher number, the struck
  original preserved in `journal_entry_rattelse_log`, and the log refused an
  UPDATE and a DELETE issued with the SERVICE ROLE, so the guarantee is proven
  at the table rather than at the policy.

The third test in that file is the refusal that makes the pair a system rather
than two features: an entry matched to a bank transaction may not have its
bank-account lines struck OR replaced, in either direction, because the ledger
would stop agreeing with the bank while every entry still balanced. The RPC
says so and names storno as the track that does apply.

## The VIES fake

`lib/vat/vies-client.ts` hardcodes `https://ec.europa.eu/...`, so there is no
base URL to redirect. The fake answers at that hostname instead, the same
arrangement the Enable Banking fake uses, and the app calls the address it
calls in production.

It matters because the app gates the 0 % rate on a verified number:
`getAvailableVatRates` only offers omvänd skattskyldighet to an EU business
whose VAT number came back valid. Without the fake that branch is unreachable
and the rule is untested, which is the wrong thing to leave untested: invoicing
0 % without a verified number leaves the seller owing the VAT they never
charged.

`DE811234567` is registered. Anything else comes back unknown, and
`ctx.fakes.vies.setOutage(true)` makes the register answer 503 so a test can
prove an outage does not read as "verified".

## Fixtures go in spectest/tests/fixtures/

Only `spectest/tests/**` is excluded from the environment's cache key. A file
anywhere else under `spectest/` changes the key, so adding one fixture in
`spectest/fixtures/` triggered a full cold rebuild of the app image, about ten
minutes. Keep fixtures next to the tests that read them, which is also where
the Spectest docs put them.

Lessons that cost time across this suite. The first two are now largely
handled by the SDK itself (0.67 spells out invisible characters, suggests
near-miss locators, and accepts a RegExp in `toContainText`), but the shapes
are still worth knowing:

- **Amounts and field values live in inputs, not text nodes.** `getByText` will
  not find them. Use `inputValue()`, or assert against the database. Asserting
  arithmetic against the ledger rather than the screen is the better habit
  regardless.
- **Swedish number formatting separates thousands with a non-breaking space.**
  `toContainText(/15\s000 kr/)` works; the same string with an ordinary space
  does not, against text that renders identically.
- **Strict mode surfaces as "not visible", not as "matched 2 elements".** A
  label that legitimately appears twice (two fiscal years created in the same
  run) fails with a message that reads like the element is missing. Reach for
  `.first()` when the text is a row label rather than a heading.

**When a browser step fails, download the page.** The failure block prints
`spectest artifact download art_… -o -`, which returns the accessibility tree
the locators resolve against. It is a few kilobytes of text and it answers in
one command what DOM probing answers in five.

## Three company branches

The suite forks three companies from the same sign-up, so all three are paid
for once:

- **Aktiebolag**, faktureringsmetoden, quarterly VAT, broken into the invoice,
  bank, payroll, supplier, credit-note, reverse-charge, rättelse and
  SIE-migration chains. This is most of the suite.
- **Enskild firma**, kontantmetoden, yearly VAT, calendar year forced by law
  (`enskild-firma.ts`, `kontantmetod.ts`). The wizard asks different questions,
  the NE-bilaga replaces INK2, and an invoice books on payment instead of on
  issue.
- **Not momsregistrerad**, an aktiebolag under the omsättningsgräns
  (`no-vat.ts`). The wizard stops asking about reporting periods, the invoice
  editor drops the Moms column rather than zeroing it, revenue books to 3004
  instead of 3001, no 26xx line is ever written, and the momsdeklaration says
  why it is empty instead of rendering zeros that look like something to file.

Each branch changes what the app does, not only what it says. Put new
sole-trader tests under `enterTheAppAsEnskildFirma` and new
non-registered tests under `onboardWithoutVatRegistration` rather than
re-walking a wizard.

## Still missing

- **A seeded parent carrying real books.** Forks are free, so sign-up and
  onboarding are already paid only once. What is missing is a company with a
  year of history to report on, which is what momsdeklaration and bokslut
  tests need. Loading a SIE file into one parent would give that, and would
  test the migration path at the same time. It would also buy back most of the
  wall-clock the serial ordering costs.
- **Payroll.** The employee form is mapped (`#first_name`, `#personnummer`,
  `#monthly_salary`, comboboxes for `salary_type` / `f_skatt_status`, and
  `#tax_municipality`). The skattetabell is **derived from the kommun**, not
  typed: `#tax_table_number` only exists when the user opts into overriding it
  manually. Pick a municipality and the table and rate follow.
- **Skattekonto.** Blocked: it calls Skatteverket, which has no fake. It fails
  gracefully ("Kunde inte hämta skattekontot"), so the page is honest, but
  nothing beyond that is testable. Skatteverket reads six base URLs from env,
  so the fake is cheap when someone wants it.
- **Import VAT** (2615, rutorna 50 and 60) and **domestic reverse charge**
  (byggtjänster, 2647). The EU cases are covered on both sides now
  (`reverse-charge.ts`, `purchase-reverse-charge.ts`).
- **Representation**, where the VAT deduction is capped at a 300 kr base per
  person. The template carries the rule as a note and is flagged HIGH risk, but
  nothing asserts the user ever sees it. Needs a restaurant row in the bank
  fixture, which busts the env cache, so it was left out rather than bodged.
- **N:1 reconciliation**, several bank rows settling one verifikat. The 1:N
  direction is covered (`reconcile-one-to-many.ts`).
- **Closing a year for real**, and filing. Readiness is covered; what is not is
  resolving the reminders and locking the period, which needs the subledgers
  reconstructed after the migration.
- **Fakes for the remaining external APIs.** They are not equally cheap:
  - **Skatteverket** is the easy one. It already reads six base URLs from env
    (`SKATTEVERKET_API_BASE_URL`, `SKATTEVERKET_OAUTH_BASE_URL`,
    `SKATTEVERKET_SKATTEKONTO_API_BASE_URL`, the two AGD ones,
    `SKATTEVERKET_SYSTEM_OAUTH_TOKEN_URL`), so a fake drops in the same way
    the bank fake did.
  - **Fortnox and Qvalia hardcode their hosts** (`https://api.fortnox.se`,
    `https://api.qvalia.com`). Faking either means first making the base URL
    configurable, which is a small change to shipped code and should be its
    own PR rather than something the test harness sneaks in.
  - **Bedrock** goes through the AWS SDK, so it is intercepted at the client
    level, not by a URL swap.
