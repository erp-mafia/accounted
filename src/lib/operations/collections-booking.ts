/**
 * Collections booking operations: read what the collections provider
 * collected and paid out, book a payment a debtor made to the provider
 * (step C), and book a payout (step D). The same services as the
 * Avräkningar routes (lib/collections/collected-payments.ts,
 * settlements.ts, settlements-view.ts); never named after the provider.
 *
 * Obligation paths (build spec rule 3): they serve whatever the start
 * gates and the paid capability say, so a company can always finish
 * booking what the provider already paid. Registered with the other
 * collections operations only while COLLECTIONS_ENABLED is set (registry.ts);
 * a booking staged earlier still commits.
 *
 * A staged payout booking pins the lines the approver saw (position, kind,
 * amount, VAT) and the payout amount: the commit refuses with
 * COLLECTION_SETTLEMENT_CHANGED when the stored payout differs, and the
 * booking itself re-checks balance, periods and every rule. A possible
 * duplicate of a payout booked by hand is a person's answer in the web UI.
 *
 * The booking services are imported when an operation runs: they reach the
 * payment record's PDF renderer, which the registry (imported by every
 * door and many tests) must not load.
 */
import { z } from 'zod'
import type {
  CollectedPaymentListItem as CollectedPaymentListItemView,
  SettlementDetail,
  SettlementListItem as SettlementListItemView,
} from '@/lib/collections/settlements-view'
import { roundOre } from '@/lib/money'
import { accountNumberSchema, isoDateSchema } from '@/lib/invariants/zod'
import { createServiceClient } from '@/lib/supabase/server'
import type { OperationContext, OperationOutcome } from './types'
import { defineOperation } from './types'

const META = { request_id: 'req_…', api_version: '2026-05-12' }

const SettlementListItem = z.object({
  settlement_id: z.string().uuid(),
  provider_settlement_ref: z.string(),
  payment_date: z.string(),
  amount: z.number(),
  currency: z.string(),
  status: z.string().describe('received (to book), booked, needs_mapping (waits for a person), failed (the provider marked it invalid; never booked) or ignored (handled elsewhere).'),
  needs_mapping_reason: z.string().nullable().describe('Why it waits, e.g. vat_unconfirmed, unknown_line, possible_duplicate, period_locked.'),
  journal_entry_id: z.string().nullable(),
  voucher: z.string().nullable(),
  bank_reference: z.string().nullable(),
  acknowledged: z.boolean(),
  duplicate_cleared: z.boolean(),
  ignored_reason: z.string().nullable(),
})

const CollectedPaymentItem = z.object({
  collected_payment_id: z.string().uuid(),
  case_id: z.string(),
  invoice_id: z.string(),
  invoice_number: z.string().nullable(),
  customer_name: z.string().nullable(),
  paid_at: z.string(),
  capital_paid: z.number().describe('The capital the debtor paid: what the booking settles on the invoice.'),
  to_agency: z.number(),
  status: z.string().describe('pending (to book), booked, needs_review (the books refused it; see review_reason) or ignored.'),
  review_reason: z.string().nullable(),
  journal_entry_id: z.string().nullable(),
  voucher: z.string().nullable(),
  settlement_id: z.string().nullable().describe('The payout that settled it, once paid out.'),
})

const SettlementLine = z.object({
  position: z.number().int(),
  kind: z.string(),
  in_payout: z.boolean(),
  amount: z.number(),
  tax_amount: z.number(),
  account_number: z.string().nullable().describe('Where the line books: recorded, or planned while the payout waits to be booked.'),
  vat_account_number: z.string().nullable(),
  chosen_by_person: z.boolean(),
  needs_account: z.enum(['vat', 'any']).nullable().describe("'vat': choose 2641 (deductible) or 6062 (cost); 'any': an account of the chart."),
  needs_vat_account: z.boolean().describe('The fee line\'s own VAT needs 2641 or 6062.'),
})

const VoucherPreviewLine = z.object({ account_number: z.string(), debit: z.number(), credit: z.number() })

const SettlementDetailSchema = SettlementListItem.extend({
  settlement_date: z.string().nullable(),
  provider_status_ok: z.boolean(),
  document_id: z.string().nullable().describe('The archived settlement PDF.'),
  duplicate_of: z.object({ journal_entry_id: z.string(), voucher: z.string().nullable() }).nullable(),
  lines: z.array(SettlementLine),
  voucher_preview: z
    .array(VoucherPreviewLine)
    .nullable()
    .describe('The voucher booking would post now, while it waits to be booked and every line is placed; null otherwise.'),
})

type SettlementListValue = z.infer<typeof SettlementListItem>

function settlementItemOut(item: SettlementListItemView): SettlementListValue {
  return {
    settlement_id: item.id,
    provider_settlement_ref: item.providerSettlementRef,
    payment_date: item.paymentDate,
    amount: item.amount,
    currency: item.currency,
    status: item.status,
    needs_mapping_reason: item.needsMappingReason,
    journal_entry_id: item.journalEntryId,
    voucher: item.voucher,
    bank_reference: item.bankReference,
    acknowledged: item.acknowledged,
    duplicate_cleared: item.duplicateCleared,
    ignored_reason: item.ignoredReason,
  }
}

function collectedPaymentOut(item: CollectedPaymentListItemView): z.infer<typeof CollectedPaymentItem> {
  return {
    collected_payment_id: item.id,
    case_id: item.caseId,
    invoice_id: item.invoiceId,
    invoice_number: item.invoiceNumber,
    customer_name: item.customerName,
    paid_at: item.paidAt,
    capital_paid: item.capitalPaid,
    to_agency: item.toAgency,
    status: item.status,
    review_reason: item.reviewReason,
    journal_entry_id: item.journalEntryId,
    voucher: item.voucher,
    settlement_id: item.settlementId,
  }
}

function settlementDetailOut(detail: SettlementDetail): z.infer<typeof SettlementDetailSchema> {
  return {
    ...settlementItemOut(detail),
    settlement_date: detail.settlementDate,
    provider_status_ok: detail.providerStatusOk,
    document_id: detail.documentAttachmentId,
    duplicate_of: detail.duplicateOf ? { journal_entry_id: detail.duplicateOf.journalEntryId, voucher: detail.duplicateOf.voucher } : null,
    lines: detail.lines.map((line) => ({
      position: line.position,
      kind: line.kind,
      in_payout: line.inPayout,
      amount: line.amount,
      tax_amount: line.taxAmount,
      account_number: line.accountNumber,
      vat_account_number: line.vatAccountNumber,
      chosen_by_person: line.chosenByPerson,
      needs_account: line.needsAccount,
      needs_vat_account: line.needsVatAccount,
    })),
    voucher_preview: detail.voucherPreview
      ? detail.voucherPreview.map((row) => ({ account_number: row.accountNumber, debit: row.debit, credit: row.credit }))
      : null,
  }
}

// ---------------------------------------------------------------------------
// collections.settlements.list
// ---------------------------------------------------------------------------

export const collectionsSettlementsList = defineOperation({
  id: 'collections.settlements.list',
  kind: 'read',
  scope: 'invoices:read',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'List the payments debtors made to the collections provider and the provider\'s payouts, with how far each is booked.',
    description:
      'Newest first, up to 200 of each. With settlement_id it also returns that payout\'s lines: the account each books to and the choices a person (or an approved staged booking) must make before it books. Served whatever the collections start gates say.',
    useWhen: 'Before booking a collected payment or a payout, or to see what waits in Avräkningar.',
    doNotUseFor: 'Open collection cases (gnubok_get_collection_case) or invoices not handed over.',
    pitfalls: ['A payout in needs_mapping with reason possible_duplicate is answered by a person in the web UI, not by an agent.'],
    example: {
      request: { settlement_id: '5c1e…' },
      response: {
        data: {
          provider: 'Acme Inkasso',
          settlements: [{ settlement_id: '5c1e…', amount: 843.75, status: 'needs_mapping', needs_mapping_reason: 'vat_unconfirmed' }],
          collected_payments: [{ collected_payment_id: '8a2b…', capital_paid: 1000, status: 'pending' }],
          settlement: { settlement_id: '5c1e…', lines: [{ position: 1, kind: 'agency_fee_vat', needs_account: 'vat' }], voucher_preview: null },
        },
        meta: META,
      },
    },
  },
  input: z.object({
    settlement_id: z.uuid().optional().describe('A payout to read with its lines.'),
  }),
  output: z.object({
    provider: z.string().nullable(),
    settlements: z.array(SettlementListItem),
    collected_payments: z.array(CollectedPaymentItem),
    settlement: SettlementDetailSchema.nullable(),
  }),
  errorCodes: ['COLLECTION_SETTLEMENT_NOT_FOUND'],
  mcp: {
    name: 'gnubok_list_collection_settlements',
    title: 'List Collection Settlements',
    description:
      'List payments debtors made to the collections provider and its payouts, with booking status. Pass settlement_id for one payout\'s lines and the account choices it waits for.',
    keywords: ['avräkning', 'avräkningar', 'inkasso utbetalning', 'inbetalning via inkasso', 'bokför avräkning', '1689'],
  },
  run: async (ctx, input) => {
    const { loadSettlementDetail, loadSettlementsOverview } = await import('@/lib/collections/settlements-view')
    // Read with the caller's own client: RLS shows a member their company's rows.
    const overview = await loadSettlementsOverview(ctx.supabase, ctx.companyId)
    let settlement: SettlementDetail | null = null
    if (input.settlement_id) {
      settlement = await loadSettlementDetail(ctx.supabase, ctx.companyId, input.settlement_id)
      if (!settlement) return { ok: false, code: 'COLLECTION_SETTLEMENT_NOT_FOUND' }
    }
    return {
      ok: true,
      data: {
        provider: overview.provider,
        settlements: overview.settlements.map(settlementItemOut),
        collected_payments: overview.collectedPayments.map(collectedPaymentOut),
        settlement: settlement ? settlementDetailOut(settlement) : null,
      },
    }
  },
})

// ---------------------------------------------------------------------------
// collections.payments.book
// ---------------------------------------------------------------------------

const PAYMENT_REFUSALS = {
  not_found: 'COLLECTED_PAYMENT_NOT_FOUND',
  ignored: 'COLLECTED_PAYMENT_IGNORED',
  busy: 'COLLECTED_PAYMENT_BUSY',
} as const

export const collectionsPaymentsBook = defineOperation({
  id: 'collections.payments.book',
  kind: 'write',
  scope: 'invoices:write',
  // Posts a voucher (the invoice's payment against the clearing account);
  // corrected only through the rebook in Avräkningar.
  risk: 'high',
  reversible: false,
  docs: {
    summary: 'Book a payment a debtor made to the collections provider as a payment of the invoice.',
    description:
      'Books the capital the debtor paid on the day they paid, against the clearing account for money the provider holds (default 1689), with the provider\'s payment data rendered as the voucher\'s underlag. A payment the books refuse (a locked period, an invoice already paid) answers outcome needs_review with the reason and waits for a person. The dry run reads only and names the invoice and the clearing account; the staged booking pins the payment day.',
    useWhen: 'gnubok_list_collection_settlements lists a collected payment as pending or needs_review.',
    doNotUseFor: 'Payments the customer made to the company itself (mark the invoice paid; it is reported to the provider).',
    pitfalls: ['A booked payment is corrected only with "Bokför om" under Avräkningar; a generic storno of its voucher is refused.'],
    example: {
      request: { collected_payment_id: '8a2b…' },
      response: { data: { outcome: 'booked', journal_entry_id: 'je…', already_booked: false }, meta: META },
    },
  },
  input: z.object({
    collected_payment_id: z.uuid().describe('The collected payment, from gnubok_list_collection_settlements.'),
    payment_date: isoDateSchema.optional().describe('Pinned at staging: the day the debtor paid, which the booking is dated.'),
  }),
  output: z.object({
    outcome: z.enum(['booked', 'needs_review']),
    journal_entry_id: z.string().nullable().optional(),
    invoice_payment_id: z.string().optional(),
    write_off_id: z.string().optional().describe('On a written-off invoice: the recovered customer loss decision it was booked as.'),
    already_booked: z.boolean().optional(),
    reason: z.string().optional().describe('Why the books refused it (needs_review).'),
  }),
  errorCodes: ['COLLECTED_PAYMENT_NOT_FOUND', 'COLLECTED_PAYMENT_IGNORED', 'COLLECTED_PAYMENT_BUSY', 'COLLECTED_PAYMENT_CHANGED'],
  mcp: {
    name: 'gnubok_book_collected_payment',
    title: 'Book Collected Payment',
    description:
      'Stage booking a payment a debtor made to the collections provider: the invoice\'s payment on the day paid, against the clearing account (1689). Nothing is booked until approved. List them with gnubok_list_collection_settlements.',
    keywords: ['bokför inbetalning', 'inkasso', 'inbetalning via inkasso', 'avräkning', '1689'],
    stage: {
      pendingType: 'book_collected_payment',
      title: () => 'Bokför inbetalning via inkasso',
      // The payment day the approver saw; it also gives the staging answer its period status.
      pinParams: (input, preview) => ({ ...input, payment_date: typeof preview.paid_at === 'string' ? preview.paid_at : undefined }),
    },
  },
  run: async (ctx, input, { dryRun }) => {
    const { bookCollectedPayment, loadCollectedPayment, previewCollectedPayment } = await import('@/lib/collections/collected-payments')
    const db = createServiceClient()
    if (dryRun) {
      const found = await previewCollectedPayment(db, ctx.companyId, input.collected_payment_id)
      if (!found) return { ok: false, code: PAYMENT_REFUSALS.not_found }
      const { row } = found
      if (row.status === 'ignored') return { ok: false, code: PAYMENT_REFUSALS.ignored }
      return {
        ok: true,
        dryRun: true,
        preview: {
          collected_payment_id: row.id,
          invoice_id: row.invoice_id,
          invoice_number: found.invoiceNumber,
          paid_at: row.paid_at,
          capital_paid: row.capital_paid,
          clearing_account: found.clearingAccount,
          status: row.status,
          already_booked: row.status === 'booked',
        },
      }
    }
    if (input.payment_date !== undefined) {
      const row = await loadCollectedPayment(db, ctx.companyId, input.collected_payment_id)
      if (row && row.paid_at !== input.payment_date) return { ok: false, code: 'COLLECTED_PAYMENT_CHANGED' }
    }
    const result = await bookCollectedPayment({ db, companyId: ctx.companyId, log: ctx.log }, input.collected_payment_id, { userId: ctx.userId })
    if (!result.ok && result.outcome !== 'needs_review') return { ok: false, code: PAYMENT_REFUSALS[result.outcome] }
    return {
      ok: true,
      data: result.ok
        ? {
            outcome: 'booked' as const,
            journal_entry_id: result.journalEntryId,
            invoice_payment_id: result.invoicePaymentId ?? undefined,
            write_off_id: result.writeOffId ?? undefined,
            already_booked: result.alreadyBooked,
          }
        : { outcome: 'needs_review' as const, reason: result.reason },
    }
  },
})

// ---------------------------------------------------------------------------
// collections.settlements.book
// ---------------------------------------------------------------------------

const LineChoice = z.object({
  position: z.number().int().min(0),
  account_number: accountNumberSchema.optional().describe('For a line that needs_account: 2641 or 6062 for the VAT on the provider\'s fees, else an account of the chart.'),
  vat_account_number: accountNumberSchema.optional().describe('For a fee line that needs_vat_account: 2641 or 6062.'),
})

const PinnedLine = z.object({
  position: z.number().int().min(0),
  kind: z.string(),
  amount: z.number(),
  tax_amount: z.number(),
})

const VoucherLine = z.object({
  account_number: z.string(),
  debit: z.number(),
  credit: z.number(),
})
type VoucherLineValue = z.infer<typeof VoucherLine>

const SETTLEMENT_REFUSALS = {
  not_found: 'COLLECTION_SETTLEMENT_NOT_FOUND',
  not_bookable: 'COLLECTION_SETTLEMENT_NOT_BOOKABLE',
  busy: 'COLLECTION_SETTLEMENT_BUSY',
  document_unavailable: 'COLLECTION_SETTLEMENT_DOCUMENT_PENDING',
} as const

type PinnableLine = Pick<z.infer<typeof PinnedLine>, 'position' | 'kind' | 'amount' | 'tax_amount'>

function pinnedLinesOf(lines: readonly PinnableLine[]): z.infer<typeof PinnedLine>[] {
  return [...lines]
    .sort((a, b) => a.position - b.position)
    .map((line) => ({ position: line.position, kind: line.kind, amount: roundOre(line.amount), tax_amount: roundOre(line.tax_amount) }))
}

/** The planned voucher as the approver sees it: account, debit and credit per line, in posting order. */
function voucherLinesOf(lines: readonly { account_number: string; debit_amount: number; credit_amount: number }[]): VoucherLineValue[] {
  return lines.map((line) => ({ account_number: line.account_number, debit: roundOre(line.debit_amount), credit: roundOre(line.credit_amount) }))
}

function sameVoucher(a: readonly VoucherLineValue[], b: readonly VoucherLineValue[]): boolean {
  const norm = (lines: readonly VoucherLineValue[]) => lines.map((l) => [l.account_number, roundOre(l.debit), roundOre(l.credit)])
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b))
}

/** True when the stored payout still is what the approver saw. */
export function settlementMatchesPin(
  current: { amount: number; paymentDate?: string; lines: readonly PinnableLine[] },
  pin: { expected_amount?: number; payment_date?: string; expected_lines?: z.infer<typeof PinnedLine>[] },
): boolean {
  if (pin.expected_amount !== undefined && roundOre(pin.expected_amount) !== roundOre(current.amount)) return false
  if (pin.payment_date !== undefined && pin.payment_date !== current.paymentDate) return false
  if (pin.expected_lines === undefined) return true
  return JSON.stringify(pinnedLinesOf(current.lines)) === JSON.stringify(pinnedLinesOf(pin.expected_lines))
}

function refusal(code: string, details?: Record<string, unknown>): Extract<OperationOutcome<never>, { ok: false }> {
  return details ? { ok: false, code, details } : { ok: false, code }
}

export const collectionsSettlementsBook = defineOperation({
  id: 'collections.settlements.book',
  kind: 'write',
  scope: 'bookkeeping:write',
  // Posts one voucher for the payout and tells the provider it is booked;
  // corrected only by a storno of the payout voucher, which returns the
  // payout to a person.
  risk: 'high',
  reversible: false,
  docs: {
    summary: 'Book a payout from the collections provider as one voucher, with the settlement PDF as its underlag.',
    description:
      'Records the accounts chosen for the lines the ledger could not place (lines), books the payout\'s pending collected payments first, then posts one voucher dated the payout day: principal against the clearing account, the provider\'s fees and their VAT, the payout to the payout account. The dry run reads only and previews that voucher (voucher_lines); it refuses a payout the ledger cannot book with the choices given (409 COLLECTION_SETTLEMENT_NEEDS_PERSON with the reason). The staged booking pins the payout\'s day, amount, lines and voucher: a payout or voucher that changed before approval answers 409 COLLECTION_SETTLEMENT_CHANGED. A payout that still needs a person at commit answers outcome needs_mapping with the reason.',
    useWhen: 'gnubok_list_collection_settlements lists a payout as received or needs_mapping, and its lines show the choices to make.',
    doNotUseFor: 'A payout held as a possible duplicate of one booked by hand: a person answers that in Avräkningar.',
    pitfalls: [
      'Pass a choice for every line with needs_account or needs_vat_account; VAT takes 2641 (deductible) or 6062 (cost) only.',
      '409 COLLECTION_SETTLEMENT_POSSIBLE_DUPLICATE: a bank row of the payout already sits on a voucher.',
      '409 COLLECTION_SETTLEMENT_CHANGED: read the payout again and stage a new booking.',
      '409 COLLECTION_SETTLEMENT_NEEDS_PERSON at staging: details.reason and details.issues say what is missing (a line without an account, an unbooked collected payment, a payout that does not balance).',
    ],
    example: {
      request: { settlement_id: '5c1e…', lines: [{ position: 1, account_number: '2641' }] },
      response: { data: { outcome: 'booked', journal_entry_id: 'je…', acknowledged: true }, meta: META },
    },
  },
  input: z.object({
    settlement_id: z.uuid().describe('The payout, from gnubok_list_collection_settlements.'),
    lines: z.array(LineChoice).max(200).optional().describe('The accounts for the lines that wait for a choice.'),
    payment_date: isoDateSchema.optional().describe('Pinned at staging: the payout day, which the voucher is dated.'),
    expected_amount: z.number().optional().describe('Pinned at staging: the payout amount the approver saw.'),
    expected_lines: z.array(PinnedLine).max(500).optional().describe('Pinned at staging: the payout\'s lines the approver saw.'),
    expected_voucher: z.array(VoucherLine).max(600).optional().describe('Pinned at staging: the voucher lines the approver saw.'),
  }),
  output: z.object({
    outcome: z.enum(['booked', 'needs_mapping']),
    journal_entry_id: z.string().optional(),
    already_booked: z.boolean().optional(),
    acknowledged: z.boolean().optional().describe('The provider was told the payout is booked (retried by the sync run otherwise).'),
    reason: z.string().optional(),
    issues: z.array(z.object({ reason: z.string(), position: z.number().nullable() })).optional(),
  }),
  errorCodes: [
    'COLLECTION_SETTLEMENT_NOT_FOUND',
    'COLLECTION_SETTLEMENT_NOT_BOOKABLE',
    'COLLECTION_SETTLEMENT_BUSY',
    'COLLECTION_SETTLEMENT_DOCUMENT_PENDING',
    'COLLECTION_SETTLEMENT_LINE_INVALID',
    'COLLECTION_SETTLEMENT_CHANGED',
    'COLLECTION_SETTLEMENT_POSSIBLE_DUPLICATE',
    'COLLECTION_SETTLEMENT_NEEDS_PERSON',
  ],
  mcp: {
    name: 'gnubok_book_collection_settlement',
    title: 'Book Collection Settlement',
    description:
      'Stage booking a payout from the collections provider as one voucher, with account choices for lines the ledger could not place. The preview shows the voucher; its day, lines and amount are pinned. Read it first with gnubok_list_collection_settlements.',
    keywords: ['bokför avräkning', 'avräkning', 'inkasso utbetalning', 'provision inkasso', 'moms avgift inkasso'],
    stage: {
      pendingType: 'book_collection_settlement',
      title: () => 'Bokför avräkning från inkasso',
      pinParams: (input, preview) => ({
        ...input,
        payment_date: typeof preview.payment_date === 'string' ? preview.payment_date : undefined,
        expected_amount: typeof preview.amount === 'number' ? preview.amount : undefined,
        expected_lines: Array.isArray(preview.lines) ? pinnedLinesOf(preview.lines as PinnableLine[]) : undefined,
        expected_voucher: Array.isArray(preview.voucher_lines) ? (preview.voucher_lines as VoucherLineValue[]) : undefined,
      }),
    },
  },
  run: async (ctx: OperationContext, input, { dryRun }) => {
    const { chooseSettlementLineAccounts, loadSettlementDetail, validateSettlementLineChoices } = await import('@/lib/collections/settlements-view')
    const { bookSettlement, loadSettlementLines, previewSettlementVoucher } = await import('@/lib/collections/settlements')
    const db = createServiceClient()
    const detail = await loadSettlementDetail(db, ctx.companyId, input.settlement_id)
    if (!detail) return refusal(SETTLEMENT_REFUSALS.not_found)
    if (detail.status === 'needs_mapping' && detail.needsMappingReason === 'possible_duplicate') {
      return refusal('COLLECTION_SETTLEMENT_POSSIBLE_DUPLICATE', { duplicate_of: detail.duplicateOf?.journalEntryId ?? null })
    }
    const lines = await loadSettlementLines(db, ctx.companyId, input.settlement_id)
    if (!settlementMatchesPin({ amount: detail.amount, paymentDate: detail.paymentDate, lines }, input)) return refusal('COLLECTION_SETTLEMENT_CHANGED')
    const choices = (input.lines ?? []).map((line) => ({ position: line.position, accountNumber: line.account_number, vatAccountNumber: line.vat_account_number }))
    const booked = detail.status === 'booked'
    if (!booked) {
      const checked = validateSettlementLineChoices(detail.status, lines, choices)
      if (!checked.ok) return refusal(checked.code, checked.position !== undefined ? { position: checked.position } : undefined)
    }
    // The voucher the booking would post now, with the choices applied but not written.
    const plan = booked ? null : await previewSettlementVoucher({ db }, ctx.companyId, input.settlement_id, choices)

    if (dryRun) {
      // Never stage a booking that would book nothing: say what a person (or the choices) must settle first.
      if (plan && !plan.ok) return refusal('COLLECTION_SETTLEMENT_NEEDS_PERSON', { reason: plan.reason, issues: plan.issues })
      const accounts = new Map((plan?.lineAccounts ?? []).map((a) => [a.position, a]))
      return {
        ok: true,
        dryRun: true,
        preview: {
          settlement_id: detail.id,
          provider_settlement_ref: detail.providerSettlementRef,
          payment_date: detail.paymentDate,
          amount: detail.amount,
          status: detail.status,
          already_booked: booked,
          journal_entry_id: detail.journalEntryId,
          lines: lines.map((line) => ({
            position: line.position,
            kind: line.kind,
            in_payout: line.in_payout,
            amount: line.amount,
            tax_amount: line.tax_amount,
            account_number: accounts.get(line.position)?.account ?? line.account_number,
            vat_account_number: accounts.get(line.position)?.vatAccount ?? line.vat_account_number,
          })),
          voucher_lines: plan?.ok ? voucherLinesOf(plan.lines) : undefined,
        },
      }
    }

    // The approver saw this voucher: book it only while it is still the one the books would post.
    if (input.expected_voucher !== undefined && plan?.ok && !sameVoucher(voucherLinesOf(plan.lines), input.expected_voucher)) {
      return refusal('COLLECTION_SETTLEMENT_CHANGED')
    }
    if (choices.length > 0 && !booked) {
      const chosen = await chooseSettlementLineAccounts(db, ctx.companyId, input.settlement_id, ctx.userId, choices)
      if (!chosen.ok) return refusal(chosen.code, chosen.position !== undefined ? { position: chosen.position } : undefined)
    }
    const result = await bookSettlement({ db, log: ctx.log }, ctx.companyId, input.settlement_id, { userId: ctx.userId })
    if (!result.ok && result.outcome !== 'needs_mapping') return refusal(SETTLEMENT_REFUSALS[result.outcome])
    return {
      ok: true,
      data: result.ok
        ? { outcome: 'booked' as const, journal_entry_id: result.journalEntryId, already_booked: result.alreadyBooked, acknowledged: result.acknowledged }
        : { outcome: 'needs_mapping' as const, reason: result.reason, issues: result.issues },
    }
  },
})

export const COLLECTIONS_BOOKING_OPERATION_LIST = [collectionsSettlementsList, collectionsPaymentsBook, collectionsSettlementsBook] as const
