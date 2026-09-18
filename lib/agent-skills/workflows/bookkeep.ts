import type { Skill } from '../types'

export const bookkeepSkill: Skill = {
  slug: 'bookkeep',
  name: 'Book transactions',
  summary: 'Work through selected transactions and existing documents, explain booking proposals, obtain approval and verify the resulting records.',
  tags: ['bookkeeping', 'transactions', 'daily'],
  tier: 'workflow',
  body: `# Book transactions

Help the user complete the requested accounting work using live Accounted data.

## Scope and company

Start with gnubok_get_agent_briefing for the explicit company_id. Check the accounting method and available capabilities. Pass that company_id to each company-scoped tool. Resources use the connection's default company and must not be used to infer another company's data.

Respect the supplied period, filters and selected IDs. Bank transactions and skattekonto records are different entities: use their respective tools. If no period or selection is supplied, identify outstanding work and agree on a useful batch. Existing counts are hints; re-read current state. Never broaden an empty explicit selection.

## Evidence and proposals

1. Inspect each record, its linked documents, related invoices and existing pending operations. Skip work already completed. Resolve existing invoices before proposing a new booking of the same event.
2. Read the company's mapping rules and ledger context from the briefing. Historical frequency is evidence, not permission to book or proof that a previous treatment was correct.
3. Load relevant current domain knowledge with gnubok_load_skill, including horizontal/swedish-accounting-compliance and horizontal/swedish-vat when needed. Follow applicable rules and use Accounted calculators; do not reproduce tax formulas or invent missing information.
4. Ask concise questions about ambiguous purchases or missing supporting information. Use documents already available in Accounted; external receipt hunting is outside this workflow.
5. Stage booking proposals with the appropriate tools. Show the transaction, supporting evidence, proposed accounts and VAT treatment, and unresolved issues. Respect locked or closed periods. Do not unlock a period or alter posted records to make this task succeed.

## Approval and completion

Group proposals coherently for review. Await the user's explicit approval, then call gnubok_approve_pending_operation only for the accepted operations and follow its confirmation requirements. Never treat a staged proposal as a completed booking.

After committing, re-read the affected records and report completed bookings with verifikat references, proposals awaiting approval, and skipped or blocked items with reasons. An uncertain or partially failed batch must remain visibly incomplete. On retry, inspect existing operations and records before proposing the same work again.

## Tools

- gnubok_get_agent_briefing: company context and ledger history.
- gnubok_list_skills and gnubok_load_skill: current workflows and domain knowledge.
- gnubok_search_tools: discover the correct listing, document, invoice-matching and booking tools and their exact schemas.
- gnubok_list_uncategorized_transactions: inspect unbooked bank transactions.
- gnubok_categorize_transaction: stage a transaction proposal.
- gnubok_list_pending_operations: inspect existing proposals and render review where supported.
- gnubok_approve_pending_operation: execute only user-approved proposals.
`,
}
