/**
 * The dimension-rule policy table, alone in a dependency-free module (it
 * imports a type only). lib/api/schemas.ts derives the v1 voucher doors'
 * accepted source types from it while it loads, and many tests mock
 * dimension-rules.ts (the service that applies the rules); keeping the
 * table out of that module means such a mock can never break loading the
 * API schemas. dimension-rules.ts re-exports both names.
 */
import type { JournalEntrySourceType } from '@/types'

export type DimensionRulePolicy = 'enforced' | 'exempt'

/**
 * Dimension-rule policy for EVERY journal source type. A Record over the
 * JournalEntrySourceType union, so a new source type fails the typecheck
 * (and dimension-rules.test.ts, which pins every value of the Zod enum)
 * until someone decides which bucket it belongs in. Nothing is exempt by
 * omission.
 *
 * ENFORCED: the new business events the policy exists for. A user authors
 * or reviews the lines and can tag them, or the producer carries the tags of
 * the document it books:
 *   - manual, bank_transaction, inbox_item: lines written in a booking form;
 *   - invoice_* and supplier_invoice_* registrations, payments and cash
 *     payments, salary_payment: flows a user drives from the document; the
 *     registrations carry the invoice's bags and payroll the employee's;
 *   - webshop_order, expense_claim: the order dialog and the claim lines
 *     take tags;
 *   - reminder_fee: new revenue (3990) of the reminded invoice; both legs
 *     carry that invoice's bag, so a required rule is met whenever the
 *     invoice was tagged, and a fee whose booking fails is not charged.
 *
 * EXEMPT: entries that carry no user-supplied tag and replay, derive or
 * settle something already decided. A required rule could never be
 * satisfied there, and a default/fixed rule would re-tag one side only:
 *   - opening_balance, import: historical/derived data must land verbatim;
 *     injecting defaults or refusing untagged history would falsify the
 *     record (BFL 5 kap);
 *   - year_end, result_appropriation, currency_revaluation: bokslut
 *     mechanics; a rule on a result account must not be able to block
 *     closing or opening the year;
 *   - storno, correction, credit_note, supplier_credit_note: HOW history
 *     gets fixed. Blocking them on entries that pre-date a rule would make
 *     old mistakes permanent. Credit notes COPY the original's bags (PR7) so
 *     the reversal nets against the same dimension cells: if the original
 *     satisfied the rules, so does the copy; if it pre-dates them, enforcing
 *     would demand an ASYMMETRIC tag (a credit in P001 with no original in
 *     P001), the project-P&L skew this feature exists to prevent;
 *   - system: asset disposals and skattekonto bookings, derived from the
 *     asset register and Skatteverket's rows;
 *   - accrual: dissolutions replay the schedule's bag on BOTH lines so the
 *     interim 17xx/29xx account nets per dimension. A default/fixed rule
 *     would re-tag one side only, and a required rule added after the
 *     schedule would strand every remaining installment (the daily cron
 *     retries the same impossible entry while the interim account stays
 *     overstated);
 *   - vat_settlement, rot_rut_payout, rot_rut_reclaim, expense_payout,
 *     stripe_payout: settlements computed from balances already booked
 *     (26xx, 1513, 2820/2893, the Stripe balance). Their only result lines
 *     (öresavrundning, Stripe fees) belong to no single project.
 */
export const DIMENSION_RULE_POLICY: Readonly<Record<JournalEntrySourceType, DimensionRulePolicy>> = {
  manual: 'enforced',
  bank_transaction: 'enforced',
  inbox_item: 'enforced',
  invoice_created: 'enforced',
  invoice_paid: 'enforced',
  invoice_cash_payment: 'enforced',
  supplier_invoice_registered: 'enforced',
  supplier_invoice_paid: 'enforced',
  supplier_invoice_cash_payment: 'enforced',
  supplier_invoice_privately_paid: 'enforced',
  salary_payment: 'enforced',
  webshop_order: 'enforced',
  pos_daily_sales: 'enforced',
  expense_claim: 'enforced',
  reminder_fee: 'enforced',
  opening_balance: 'exempt',
  import: 'exempt',
  year_end: 'exempt',
  result_appropriation: 'exempt',
  currency_revaluation: 'exempt',
  storno: 'exempt',
  correction: 'exempt',
  credit_note: 'exempt',
  supplier_credit_note: 'exempt',
  system: 'exempt',
  accrual: 'exempt',
  vat_settlement: 'exempt',
  rot_rut_payout: 'exempt',
  rot_rut_reclaim: 'exempt',
  expense_payout: 'exempt',
  stripe_payout: 'exempt',
}
