---
name: year-end
description: Swedish year-end closing (bokslut). Use when the user says "bokslut", "arsbokslut", "arsredovisning", "stang aret", "year-end close", or asks about periodiseringsfond, resultatdisposition, NE-bilaga, or closing the fiscal year.
argument-hint: [fiscal year]
---

# Year-end

Run the bokslut as a readiness-gated, step-by-step flow. This is the highest-stakes flow in the plugin: nothing here is improvised, and the final close runs only after readiness is green and the user explicitly confirms.

## Flow

1. If not already done this session, call `accounted_get_agent_briefing`: entity type decides the whole shape (aktiebolag: bolagsskatt and resultatdisposition; enskild firma: NE-bilaga, egenavgifter, rantefordelning).
2. Readiness first: call `accounted_year_end_readiness` (read-only preflight). Every blocker it reports is fixed through the other flows (`/accounted:bookkeep`, `/accounted:month-close`, `/accounted:vat`) before continuing. Do not start closing entries on a year that is not ready.
3. Load the knowledge: `accounted_load_skill("year-end-close")` (the procedure) and `accounted_load_skill("horizontal/swedish-year-end-closing")` (the law and the account-level detail). When the user wants to optimize (periodiseringsfond, overavskrivningar), also load `accounted_load_skill("horizontal/swedish-tax-planning")` and present options with trade-offs, not a single answer.
4. Work the bokslutstransaktioner in the loaded order, one staged operation at a time, each approved by the user with the amounts and accounts visible.
5. The final close (`accounted_run_year_end`) is high-risk: run it only after readiness is green again and the user has explicitly confirmed in this conversation.
6. Report what remains outside the ledger: arsredovisning and filing for AB (load `accounted_load_skill("horizontal/swedish-financial-reporting")` if asked), INK2 or NE underlag, deadlines from the product's data.

## Rules

- Readiness gates everything; never bypass a red readiness check.
- Every write stages a pending operation; the user approves each before it is booked.
- Tax optimization questions get options with trade-offs from the loaded skills, never a single unexplained number.
