---
name: clients
description: Cross-company view for a person who belongs to several companies (byrå with clients, koncern, several own bolag). Use when the user says "mina klienter", "alla bolag", "all my companies", "vilka klienter", "portfölj", "kör för alla", asks which company needs attention first, or wants one task done for every company at once.
argument-hint: [filter such as "moms inom 14 dagar", or a task to run for every client]
---

# Clients

One table over every company this connection reaches, most urgent first, then per-company follow-ups through the existing flows. Read-only unless the user explicitly asks to stage something.

## Flow

1. If not already done this session, call `accounted_get_agent_briefing` and `accounted_list_companies`. One company only: say so and hand over to `/accounted:start`; this flow is for two or more.
2. Call `accounted_client_overview` with `scope: { companies: "team" }` when the user is a byrå member working on client companies, otherwise `scope: { companies: "all" }`. Map the argument onto the tool's filters (`deadline_kind`, `deadline_within_days`, `min_unbooked`) and put companies the user wants left out in `exclude`.
3. Present one table in the user's language: company, unbooked, inbox, next deadline (kind, date, days left; mark overdue and due within 7 days), last booked. Sort by deadline urgency, then by unbooked count. One line under the table: how many companies are clean.
4. Offer per-company follow-ups with the existing flows (`/accounted:bookkeep`, `/accounted:vat`, `/accounted:month-close`, `/accounted:payroll`, `/accounted:year-end`), each with the company named; inside that flow pass its `company_id` on every call.
5. "Is everyone ready for moms / bokslut?": call `accounted_portfolio_readiness` with `kind: "vat"` or `kind: "year_end"` and the same scope, and report blockers per company.
6. "Run X for every client":
   - Reads: `accounted_run_across_companies` with the tool name and its arguments. It runs once per company and returns a summary by default; ask for full results only when the user needs the detail.
   - Writes: `accounted_stage_across_companies`. Every staged operation shares one `batch_id`. Show the batch as a table (company, operation, risk, preview) and stop there. Approve only on the user's explicit word: one operation at a time, or the whole batch through `accounted_approve_pending_operation` with `batch_id` (that approves the low- and medium-risk members; high-risk operations must be approved one by one, and the tool says which). `accounted_list_pending_operations` with `batch_id` shows the batch again, and with `all_companies: true` everything waiting across the account.
7. Finish with what changed and what still waits, per company.

## Rules

- Read-only unless the user asks to stage: the overview, readiness and run-across-companies never write.
- Never stage or approve for a company the user excluded or did not name; "alla" means the scope shown in the table, nothing more.
- Approve only on explicit word, and never a high-risk operation through a batch approval.
- Company context: if the working directory (or a parent, nearest wins) contains `.accounted.json` with `{ "company_id": "<uuid>", "name": "<name>" }`, pass that `company_id` on every company-scoped call and say the company name once at the start. Otherwise, if `accounted_list_companies` returns more than one company, ask once which company the task concerns (or whether it spans all of them) before any write. Never write to a company the user did not name in a multi-company account. Every tool result begins with `company: { company_id, name, is_default }`: read it back to the user whenever it is not the company they named.
