---
name: sim-company
description: Prove a change on a simulated Swedish company with real books. An aktiebolag lives through 2024, 2025 and part of 2026 via the real MCP tools in a throwaway Docker database, and an answer key worked out from the same events judges moms, AGI, INK2 and the årsredovisning to the öre. Use when a change touches bookkeeping, reports, VAT, payroll, year-end or the årsredovisning, when you need a company with years of realistic data, or when a bug needs several months of books to show. Covers building it, reading a failure, and adding a case.
---

# The simulated company

`tests/sim/` holds one company and the arithmetic of what its books must say:

- `generate.ts`: the company as facts. Seed in, events out, no database.
- `answer-key.ts`: what the books must say, from those facts and Swedish rules. Imports no product code but `roundOre`.
- `build.ts`: plays the events through the MCP tools, stage and approve, with the clock set to each event's day.
- `*.sim.test.ts`: read the built company and compare it to the key. They never write.

It lives in the tool-pg Docker stack: Postgres and PostgREST on this machine, never hosted Supabase or prod. Everything but the seed is thrown away, and the same seed rebuilds the same company. Nothing leaves the machine: `network.ts` answers Skatteverket's tax tables and VIES and refuses all else.

## Run it

```bash
npm run tools:pg:reset     # the database: about 3 minutes, once
npm run sim:build          # the small company: about 3 minutes
npm run test:sim           # the judge: seconds, and rerun as often as you like
npm run test:sim -- arsredovisning
```

`test:sim` runs your code against the books already built, so a change to a report needs no rebuild. A change to anything that happens on a write, a booking or a stored file like the AGI XML, does: rerun `sim:build`. `npm run sim:build -- --until 2024-06-30` stops partway through the company's life. `SIM_SCALE=full` is the nightly company: 5,681 events in about 10 minutes. Tool logs land in `.local/sim/build.log`.

To click around in the same company: `npm run local:up -- --sim`, then log in with what it prints. `local:check` on `/transactions` then reports a CORS error and a 414: the local gateway stops URLs at 8 KB, and prod's does not.

## Read a failure

A failed test means the product and the key disagree. Neither is right by default.

1. Find the verifikat behind the number: `docker exec tool-pg-postgres-1 psql -U postgres`, then `journal_entries` joined to `journal_entry_lines` by the `companyId` in `.local/sim/state.json`.
2. Decide from the law, not from the code: load the matching `swedish-*` skill.
3. The key is wrong: fix the key, and put the rule in the list at the top of `answer-key.ts`.
4. The product is wrong: fix it, or if that is out of scope, leave a `it.fails` test that names the gap and say so in the pull request. It goes red the day the gap closes.

A build that stops prints the event and the tool's own refusal. A refusal is often the finding: a customer's agent would hit it too.

## Add a case

For a new report or feature, add a `<name>.sim.test.ts` that reads what the key already knows. When the company lacks the case (a dividend, a periodiseringsfond, a customer loss):

1. Add an event type in `generate.ts`, and create it at a date a real company would.
2. Add what it posts in `answer-key.ts`. Every event must balance, and the rule comes from the `swedish-*` skill, never from the product's code.
3. Add the tool calls in `build.ts`.
4. Run `npx vitest run --project unit tests/sim/answer-key.test.ts`, then build and test.

The key must stay independent: if it imports the code it judges, it can only agree.

Amounts in `generate.ts` are whole kronor before moms, so moms stays exact and every rounding in the books is the product's. Fictional parties only, and personnummer stay samordningsnummer.
