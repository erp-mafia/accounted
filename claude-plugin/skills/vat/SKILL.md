---
name: vat
description: Prepare and review the Swedish VAT return (momsdeklaration). Use when the user says "moms", "momsdeklaration", "VAT return", "momsrapport", asks about rutor, EU-moms, omvand skattskyldighet, or when a VAT period is ending.
argument-hint: [period]
---

# VAT

Prepare the momsdeklaration underlag from the ledger and reconcile it before anything is booked or filed. VAT is the highest-error area in Swedish bookkeeping: always work from loaded knowledge, never memory.

## Flow

1. If not already done this session, call `accounted_get_agent_briefing`: it gives VAT registration status, period length (monthly, quarterly, yearly), and accounting method. If the company is not VAT registered, say so and stop.
2. Load the knowledge: `accounted_load_skill("quarterly-vat-review")` (the review procedure, valid for any period length) and `accounted_load_skill("horizontal/swedish-vat")` for ruta mapping and edge cases (reverse charge, EU trade, import VAT, representation).
3. Verify the period is fully booked first: any unbooked transactions in the period make the return wrong. Route gaps through `/accounted:bookkeep` before continuing.
4. Generate the VAT report with the product's tools (discover via `accounted_search_tools`, for example "vat report momsdeklaration") and reconcile: report rutor against the 26xx account balances, and against the previous period for anomalies.
5. Present a per-ruta summary in the user's language, flagging anything unusual with the ledger evidence behind it.
6. Booking the VAT settlement (redovisning mot 2650/1650) is a staged operation the user approves. Filing with Skatteverket is the user's action: prepare the underlag, state the deadline, and where the product's Skatteverket integration is connected, point at it.

## Rules

- Never compute or assert a ruta mapping from memory; it must come from the loaded skills and the product's report.
- Every write stages a pending operation; the user approves before anything is booked.
- Never work around a locked period; a locked VAT period means the correction goes in the current one, per the loaded skill's procedure.
- Company context: if the working directory (or a parent, nearest wins) contains `.accounted.json` with `{ "company_id": "<uuid>", "name": "<name>" }`, pass that `company_id` on every company-scoped call and say the company name once at the start. Otherwise, if `accounted_list_companies` returns more than one company, ask once which company the task concerns (or whether it spans all of them) before any write. Never write to a company the user did not name in a multi-company account. Every tool result begins with `company: { company_id, name, is_default }`: read it back to the user whenever it is not the company they named.
