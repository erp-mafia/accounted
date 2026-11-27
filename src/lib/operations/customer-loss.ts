/**
 * invoices.customer-loss.record: book a kundförlust decision on an invoice
 * (befarad, konstaterad or återvunnen) through lib/customer-loss. Served as
 * an MCP tool only while CUSTOMER_LOSS_ENABLED is set at module load
 * (registry.ts); an operation staged while it was on still commits, and
 * run() checks the flag again.
 *
 * Agent-approvable (high risk): the decision is a bookkeeping judgement the
 * company owns, it is undone by a storno, and konstaterad needs an evidence
 * document already in the archive.
 */
import { z } from 'zod'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import { recordConfirmedLoss } from '@/lib/customer-loss/confirmed'
import { recordDoubtfulLoss } from '@/lib/customer-loss/doubtful'
import type { CustomerLossOutcome } from '@/lib/customer-loss/errors'
import { customerLossEnabled } from '@/lib/env/customer-loss-switch'
import { recordRecoveredLoss } from '@/lib/customer-loss/recovered'
import { loadCustomerLossState } from '@/lib/customer-loss/state'
import { buildCustomerLossView } from '@/lib/customer-loss/view'
import { accountNumberSchema } from '@/lib/invariants/zod'
import { defineOperation } from './types'
import { todayIsoStockholm } from '@/lib/dates/iso'

const META = { request_id: 'req_…', api_version: '2026-05-12' }

const KIND_TITLES_SV = {
  doubtful: 'Bokför befarad kundförlust',
  confirmed: 'Bokför konstaterad kundförlust',
  recovered: 'Bokför återvunnen kundförlust',
} as const

export const invoicesRecordCustomerLoss = defineOperation({
  id: 'invoices.customer-loss.record',
  kind: 'write',
  scope: 'invoices:write',
  // Books a voucher on 1510/1519/26xx and, for konstaterad, writes the
  // invoice off. Undone only by a storno of that voucher.
  risk: 'high',
  reversible: true,
  docs: {
    summary: 'Book a customer loss (kundförlust) on a sent SEK invoice: doubtful (befarad), confirmed (konstaterad) or a recovery after a write-off.',
    description:
      'doubtful books a valuation reserve (Dr 6352 / Cr 1519) for the open amount net of VAT; the invoice keeps its status and VAT is untouched. confirmed writes the claim off (Dr 6351 net and Dr the output VAT accounts for the open VAT, Cr 1510, plus any reserve back) and gives the invoice the status written_off; it needs an evidence document showing the customer cannot pay, and the momsdeklaration lowers ruta 05 with ruta 10 to 12. recovered books a later payment on a written-off invoice as income (Dr bank / Cr 3950 net and the output VAT reported again). Under kontantmetoden an invoice that never reached the ledger as a receivable gets no voucher.',
    useWhen: 'An overdue customer invoice will probably not be paid (doubtful), the customer is shown unable to pay, e.g. bankruptcy or a fruitless enforcement (confirmed), or money arrives on an invoice already written off (recovered).',
    doNotUseFor: 'Crediting an invoice that was wrong (credit the invoice) or recording an ordinary payment (mark the invoice paid).',
    pitfalls: [
      'confirmed needs evidence_document_id: upload the konkursbesked or the Kronofogden decision first.',
      'Only SEK invoices without a ROT/RUT share (422 CUSTOMER_LOSS_CURRENCY_UNSUPPORTED / CUSTOMER_LOSS_DEDUCTION_UNSUPPORTED).',
      'recovered needs amount and is capped at what was written off (422 CUSTOMER_LOSS_RECOVERY_EXCEEDS), except that a payment of what the invoice asked for (its rounded Att betala, or its exact total, less what was already paid and recovered) closes the claim with the öre on 3740; after a credit note only what is left closes it. It is refused while the invoice has an open collection case (409 CUSTOMER_LOSS_RECOVERY_CASE_OPEN).',
      'A mistake is undone by reversing (storno) the voucher, latest decision first.',
    ],
    example: {
      request: { invoice_id: '7d1e…', kind: 'confirmed', reason: 'Konkurs', evidence_document_id: '5a2c…' },
      response: { data: { write_off_id: '9f3b…', journal_entry_id: 'c41d…', invoice_status: 'written_off', amount: 1250 }, meta: META },
    },
  },
  input: z.object({
    invoice_id: z.uuid().describe('The customer invoice.'),
    kind: z.enum(['doubtful', 'confirmed', 'recovered']),
    reason: z.string().trim().min(1).max(500).describe('Why, in a few words (shown on the voucher).'),
    entry_date: z.iso.date().optional().describe('The voucher date; today when omitted.'),
    evidence_document_id: z.uuid().nullable().optional().describe('For confirmed: the archived document that shows the customer cannot pay.'),
    amount: z.number().positive().max(1_000_000_000).optional().describe('For recovered: the amount received, VAT included.'),
    payment_account: accountNumberSchema.optional().describe("For recovered: the account the money reached; the company's primary bank account when omitted."),
  }),
  output: z.object({
    write_off_id: z.string(),
    journal_entry_id: z.string().nullable(),
    invoice_status: z.string(),
    amount: z.number(),
  }),
  errorCodes: [
    'CUSTOMER_LOSS_DISABLED',
    'CUSTOMER_LOSS_INVOICE_NOT_FOUND',
    'CUSTOMER_LOSS_INVOICE_NOT_OPEN',
    'CUSTOMER_LOSS_CURRENCY_UNSUPPORTED',
    'CUSTOMER_LOSS_DEDUCTION_UNSUPPORTED',
    'CUSTOMER_LOSS_INVOICE_NOT_BOOKED',
    'CUSTOMER_LOSS_DOUBTFUL_NOT_BOOKED',
    'CUSTOMER_LOSS_LEDGER_MISMATCH',
    'CUSTOMER_LOSS_ALREADY_RESERVED',
    'CUSTOMER_LOSS_EVIDENCE_REQUIRED',
    'CUSTOMER_LOSS_EVIDENCE_NOT_FOUND',
    'CUSTOMER_LOSS_NOT_WRITTEN_OFF',
    'CUSTOMER_LOSS_RECOVERY_EXCEEDS',
    'CUSTOMER_LOSS_RECOVERY_CASE_OPEN',
    'CUSTOMER_LOSS_RECOVERY_NOT_BOOKED',
    'CUSTOMER_LOSS_NO_FISCAL_PERIOD',
    'CUSTOMER_LOSS_RACE',
  ],
  mcp: {
    name: 'gnubok_record_customer_loss',
    title: 'Record Customer Loss',
    description:
      'Stage a kundförlust on a customer invoice: doubtful (befarad reserve), confirmed (konstaterad write-off with evidence; the invoice becomes written_off and ruta 05 drops with the output VAT) or recovered (a payment after the write-off).',
    keywords: ['kundförlust', 'befarad kundförlust', 'konstaterad kundförlust', 'osäker fordran', 'avskriven fordran', 'återvunnen kundförlust', 'konkurs kund'],
    stage: {
      pendingType: 'record_customer_loss',
      title: (input) => KIND_TITLES_SV[input.kind as keyof typeof KIND_TITLES_SV] ?? 'Bokför kundförlust',
    },
  },
  run: async (ctx, input, { dryRun }) => {
    if (!customerLossEnabled()) return { ok: false, code: 'CUSTOMER_LOSS_DISABLED' }
    if (dryRun) {
      const loaded = await loadCustomerLossState(ctx.supabase, ctx.companyId, input.invoice_id)
      if (!loaded.ok) return { ok: false, code: loaded.code }
      const view = buildCustomerLossView(loaded.state, { enabled: true, today: todayIsoStockholm() })
      return { ok: true, dryRun: true, preview: { kind: input.kind, ...view } as unknown as Record<string, unknown> }
    }
    const common = {
      invoiceId: input.invoice_id,
      entryDate: input.entry_date ?? todayIsoStockholm(),
      reason: input.reason,
      decidedBy: ctx.userId,
    }
    let outcome: CustomerLossOutcome
    try {
      if (input.kind === 'doubtful') {
        outcome = await recordDoubtfulLoss(ctx.supabase, ctx.companyId, ctx.userId, common)
      } else if (input.kind === 'confirmed') {
        outcome = await recordConfirmedLoss(ctx.supabase, ctx.companyId, ctx.userId, {
          ...common,
          evidenceDocumentId: input.evidence_document_id ?? null,
        })
      } else {
        if (input.amount === undefined) {
          return { ok: false, code: 'VALIDATION_ERROR', details: { field: 'amount' } }
        }
        outcome = await recordRecoveredLoss(ctx.supabase, ctx.companyId, ctx.userId, {
          ...common,
          amount: input.amount,
          paymentAccount: input.payment_account,
        })
      }
    } catch (error) {
      if (isBookkeepingError(error)) return { ok: false, code: (error as { code: string }).code, error }
      throw error
    }
    if (!outcome.ok) return { ok: false, code: outcome.code, details: outcome.details }
    return {
      ok: true,
      data: {
        write_off_id: outcome.writeOffId,
        journal_entry_id: outcome.journalEntryId,
        invoice_status: outcome.invoiceStatus,
        amount: outcome.amount,
      },
    }
  },
})

/** Registered only while CUSTOMER_LOSS_ENABLED is set (registry.ts). */
export const CUSTOMER_LOSS_OPERATION_LIST = [invoicesRecordCustomerLoss] as const
