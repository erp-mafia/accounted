---
name: check
description: Read-only health check of the books. Use when the user asks "hur ligger vi till", "check my books", "ar bokforingen i ordning", "status", "veckokoll", "manadskoll", or wonders whether anything looks wrong or is overdue.
---

# Check

A read-only pass over the books that ends in a short prioritized list. This flow never writes anything; it routes each finding to the flow that fixes it.

## Flow

1. If not already done this session, call `accounted_get_agent_briefing`.
2. Read `Accounted://attention`, `Accounted://period/active`, and `Accounted://recent-activity`.
3. Assess, in this order:
   - Unbooked backlog: how many items, how old is the oldest?
   - Unreconciled bank transactions in the active period.
   - Overdue customer invoices and unpaid supplier invoices.
   - Unapproved pending operations waiting on the user (`accounted_list_pending_operations`).
   - Upcoming deadlines: moms, AGI, F-skatt, bokslut. Use dates from the product, not memorized ones.
   - Period status: is a period that should be closed still open?
4. Present a short table in the user's language: finding, severity, and which flow fixes it (`/accounted:bookkeep`, `/accounted:month-close`, `/accounted:vat`, `/accounted:payroll`, `/accounted:year-end`).
5. If everything is clean, say so plainly and state the next deadline.

## Rules

- Strictly read-only: do not stage or approve anything in this flow, even if the fix is obvious. Offer the fixing flow instead.
- Report only what the data shows; no speculative findings.
