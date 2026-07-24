---
name: month-close
description: Close a month in Accounted. Use when the user says "stang manaden", "manadsavslut", "month-end close", "close the period", or wants the monthly closing routine done.
argument-hint: [month]
---

# Month close

Run the monthly close as a checklist against live data. The authoritative checklist lives server-side and is tailored to this company; this skill orchestrates it, it does not replace it.

## Flow

1. If not already done this session, call `accounted_get_agent_briefing` and read `Accounted://period/active` to confirm which period is being closed.
2. Load the checklist: `accounted_load_skill("month-end-close")`. Follow it step by step with the company's real numbers.
3. Bank first: if unreconciled transactions exist in the period, load `accounted_load_skill("bank-reconciliation")` and clear them before anything else. Unbooked items route through the `/accounted:bookkeep` flow.
4. Work the remaining checklist items (accruals, recurring vouchers, control balances). Every correction is staged and individually approved by the user; use storno-style corrections through the product's tools, never edit posted entries.
5. If the month ends a VAT period, hand over to `/accounted:vat` rather than improvising the momsdeklaration inside this flow.
6. Lock or close the period only as the final step, only after the user explicitly confirms, as its own staged operation.
7. Report in the user's language: closed, or blocked with a concrete list of what stands in the way.

## Rules

- The server-side checklist is authoritative; do not substitute a generic month-end list from memory.
- Every write stages a pending operation; the user approves each before it is booked.
- Never work around a locked or closed period; surface it and stop.
