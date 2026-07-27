---
name: start
description: Connect and orient in the user's Accounted bookkeeping. Use on first contact with Accounted in a session, when the user says "kom igang", "get started", "connect my bookkeeping", "vad behover jag gora", or asks what this plugin can do.
---

# Start

Verify the connection, learn who this company is, and surface what needs attention. Run this before any other Accounted flow in a session.

## Flow

1. Call `accounted_get_agent_briefing`. This is the single source for company facts: entity type (aktiebolag or enskild firma), accounting method (faktureringsmetoden or kontantmetoden), VAT period, employees, and ledger context. Never assume these; the flows below behave differently depending on them.
   - If the call fails with an auth error, the MCP server is not connected yet: tell the user to run `/mcp` and authenticate with Accounted (OAuth consent screen; read-only scopes by default, write scopes are ticked explicitly). Self-hosted users: see the plugin README.
   - If the user has no Accounted account at all, say so plainly and point them at https://app.accounted.se to create one. The plugin drives an existing ledger; it cannot bookkeep without one. Do not attempt any other flow until a company is connected.
2. Read `Accounted://attention` and `Accounted://period/active`.
3. Present a short orientation in the user's language: company name and form, active fiscal period and its lock status, and the top 3 items needing attention.
4. Point at the flows, matched to what attention showed:
   - `/accounted:bookkeep` - clear unbooked transactions and receipts (daily)
   - `/accounted:check` - read-only health check of the books
   - `/accounted:month-close` - close the month
   - `/accounted:vat` - prepare the momsdeklaration
   - `/accounted:payroll` - monthly salary run and AGI
   - `/accounted:year-end` - bokslut
5. Mention that deeper, company-tailored guides exist on the server: `accounted_list_skills` lists them (workflow guides plus Swedish regulatory skills, filtered to this company), and `accounted_load_skill(slug)` loads any of them.

## Rules

- Ground every statement in the briefing and resources; never guess company facts.
- Swedish accounting or tax questions are answered from loaded skills, never from memory.
- Every write in Accounted stages a pending operation for the user to approve. Nothing is ever booked without explicit approval.
