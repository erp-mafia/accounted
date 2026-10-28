/**
 * Kvittning (lib/invoices/counterparty-setoff): a counterparty that is both
 * customer and supplier, read as one relation with its net balance, and a
 * customer invoice set off against a supplier invoice of the same
 * counterparty. Served as v1 routes and MCP tools only while
 * COUNTERPARTY_SETOFF_ENABLED is set at module load (registry.ts); an
 * operation staged while it was on still commits, and run() checks the flag
 * again.
 *
 * Agent-approvable (high risk): the set-off books a verifikat and lowers both
 * invoices, and is undone only by a storno of that verifikat.
 */
import { z } from 'zod'
import { bookCounterpartySetoff } from '@/lib/invoices/counterparty-setoff/book'
import { loadCounterpartyBalance } from '@/lib/invoices/counterparty-setoff/open-items'
import { counterpartySetoffEnabled } from '@/lib/env/counterparty-setoff-switch'
import { defineOperation } from './types'

const META = { request_id: 'req_…', api_version: '2026-05-12' }
const V1 = '/api/v1/companies/:companyId/setoffs'

const ineligibleReason = z
  .enum(['credit_note', 'not_open', 'currency', 'deduction', 'not_booked', 'no_party', 'collection_open', 'payment_in_flight'])
  .nullable()

const balanceOutput = z.object({
  party: z.object({ party_id: z.string(), name: z.string(), org_number: z.string().nullable() }),
  customers: z.array(z.object({ customer_id: z.string(), name: z.string() })),
  suppliers: z.array(z.object({ supplier_id: z.string(), name: z.string() })),
  receivables: z.array(
    z.object({
      invoice_id: z.string(),
      customer_id: z.string().nullable(),
      number: z.string().nullable(),
      invoice_date: z.string(),
      due_date: z.string().nullable(),
      currency: z.string(),
      total: z.number(),
      remaining_amount: z.number(),
      status: z.string(),
      setoff_eligible: z.boolean(),
      ineligible_reason: ineligibleReason,
    }),
  ),
  payables: z.array(
    z.object({
      supplier_invoice_id: z.string(),
      supplier_id: z.string().nullable(),
      number: z.string().nullable(),
      arrival_number: z.number().nullable(),
      invoice_date: z.string(),
      due_date: z.string().nullable(),
      currency: z.string(),
      total: z.number(),
      remaining_amount: z.number(),
      status: z.string(),
      setoff_eligible: z.boolean(),
      ineligible_reason: ineligibleReason,
    }),
  ),
  totals: z.array(
    z.object({
      currency: z.string(),
      receivable: z.number(),
      payable: z.number(),
      net: z.number(),
      direction: z.enum(['they_pay', 'we_pay', 'settled']),
    }),
  ),
  setoffs: z.array(
    z.object({
      setoff_id: z.string(),
      setoff_date: z.string(),
      amount: z.number(),
      status: z.enum(['booked', 'reversed']),
      invoice_id: z.string(),
      supplier_invoice_id: z.string(),
      journal_entry_id: z.string(),
      note: z.string().nullable(),
    }),
  ),
})

export const invoicesCounterpartyBalanceGet = defineOperation({
  id: 'invoices.counterparty-balance.get',
  kind: 'read',
  scope: 'reports:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'A counterparty that is both customer and supplier, as one relation: its open customer and supplier invoices, the net per currency and its set-offs.',
    description:
      'Name the counterparty by exactly one of party_id, customer_id or supplier_id. Every customer and supplier card of the same legal person (one party, linked by organisation number) is included. Each open invoice says whether it can be set off now and why not (ineligible_reason). The net is receivable minus payable: above zero they pay us, below zero we pay them. Credit notes are not included.',
    useWhen: 'Deciding what to set off between a customer that is also a supplier, or checking what is left to pay or receive after a set-off.',
    doNotUseFor: 'The full kund- or leverantörsreskontra (use the ledger reports).',
    pitfalls: [
      'A card without an organisation number has no party until it is merged in Motparter (404 SETOFF_PARTY_NOT_FOUND).',
      'Totals are per currency; only SEK invoices can be set off.',
    ],
    example: {
      request: { customer_id: '6b0e…' },
      response: {
        data: {
          party: { party_id: '7fc2…', name: 'Exempel Energi AB', org_number: '5599887766' },
          totals: [{ currency: 'SEK', receivable: 1388, payable: 4504, net: -3116, direction: 'we_pay' }],
        },
        meta: META,
      },
    },
  },
  input: z.object({
    party_id: z.uuid().optional().describe('The counterparty (Motparter).'),
    customer_id: z.uuid().optional().describe('A customer card of the counterparty.'),
    supplier_id: z.uuid().optional().describe('A supplier card of the counterparty.'),
  }),
  output: balanceOutput,
  errorCodes: ['SETOFF_DISABLED', 'SETOFF_PARTY_NOT_FOUND', 'VALIDATION_ERROR'],
  http: { method: 'GET', path: `${V1}/counterparty` },
  mcp: {
    name: 'gnubok_get_counterparty_balance',
    title: 'Get Counterparty Balance',
    keywords: ['kvittning', 'kvitta', 'motpart netto', 'nettosaldo', 'kund och leverantör', 'set-off', 'motpart'],
  },
  run: async (ctx, input) => {
    if (!counterpartySetoffEnabled()) return { ok: false, code: 'SETOFF_DISABLED' }
    const given = [input.party_id, input.customer_id, input.supplier_id].filter(Boolean)
    if (given.length !== 1) {
      return { ok: false, code: 'VALIDATION_ERROR', details: { field: 'party_id', reason: 'exactly one of party_id, customer_id, supplier_id' } }
    }
    const ref = input.party_id
      ? { partyId: input.party_id }
      : input.customer_id
        ? { customerId: input.customer_id }
        : { supplierId: input.supplier_id as string }
    const balance = await loadCounterpartyBalance(ctx.supabase, ctx.companyId, ref)
    if (!balance) return { ok: false, code: 'SETOFF_PARTY_NOT_FOUND' }
    return { ok: true, data: balance }
  },
})

const netOutput = z.object({ direction: z.enum(['we_pay', 'they_pay', 'settled']), amount: z.number() })

export const invoicesSetoffBook = defineOperation({
  id: 'invoices.setoff.book',
  kind: 'write',
  scope: 'invoices:write',
  // Books a verifikat on 244x/151x and lowers both invoices. Undone only by
  // a storno of that verifikat, which restores both.
  risk: 'high',
  reversible: true,
  docs: {
    summary: 'Set off (kvitta) an open customer invoice against an open supplier invoice of the same counterparty: one verifikat, both invoices lowered, the net left to pay or receive.',
    description:
      'Books Dr accounts payable / Cr accounts receivable (the accounts the invoices\' own vouchers booked) for amount, at most the smaller remaining amount (the default). VAT is untouched. Both invoices get a payment row dated setoff_date and their remaining amounts go down; the net is then matched to the bank line like any part payment. A kvittningsavräkning is archived on the verifikat as underlag. SEK only; refused for credit notes, ROT/RUT invoices, invoices not booked as receivable or payable (kontantmetoden), an open collection case, or a supplier invoice with a payment on its way.',
    useWhen: 'A company sells to and buys from the same legal person and settles the two against each other instead of paying both in full.',
    doNotUseFor: 'Settling a credit note against its invoice (credit the invoice), or recording a payment received or made (mark the invoice paid or match the bank line).',
    pitfalls: [
      'Both cards must belong to the same counterparty (same organisation number, or merged in Motparter): 422 SETOFF_PARTY_MISMATCH / SETOFF_NO_PARTY.',
      'A supplier invoice entered at the bank, in a payment file or in an open payment order is refused (409 SETOFF_PAYMENT_IN_FLIGHT): the bank would pay the full amount.',
      'A mistake is undone by reversing (storno) the set-off verifikat; it is never corrected in place.',
    ],
    example: {
      request: { invoice_id: '2a9c…', supplier_invoice_id: '79f1…', setoff_date: '2026-09-30', note: 'Kvittning enligt flexavtal' },
      response: {
        data: {
          setoff_id: '5d1e…',
          journal_entry_id: 'c41d…',
          amount: 1388,
          invoice: { invoice_id: '2a9c…', status: 'paid', remaining_amount: 0 },
          supplier_invoice: { supplier_invoice_id: '79f1…', status: 'partially_paid', remaining_amount: 3116 },
          net: { direction: 'we_pay', amount: 3116 },
        },
        meta: META,
      },
    },
  },
  input: z.object({
    invoice_id: z.uuid().describe('The open customer invoice.'),
    supplier_invoice_id: z.uuid().describe('The open supplier invoice of the same counterparty.'),
    amount: z.number().positive().max(1_000_000_000).optional().describe('In SEK; the smaller of the two remaining amounts when omitted.'),
    setoff_date: z.iso.date().optional().describe('The verifikat date; today when omitted.'),
    note: z.string().trim().max(500).optional().describe('The agreement or notice the set-off rests on.'),
    party_id: z.uuid().optional().describe('The counterparty the approver saw; refused if the invoices belong to another.'),
  }),
  output: z.object({
    setoff_id: z.string(),
    journal_entry_id: z.string(),
    voucher_series: z.string().nullable(),
    voucher_number: z.number().nullable(),
    party_id: z.string(),
    amount: z.number(),
    setoff_date: z.string(),
    invoice: z.object({ invoice_id: z.string(), status: z.string(), remaining_amount: z.number() }),
    supplier_invoice: z.object({ supplier_invoice_id: z.string(), status: z.string(), remaining_amount: z.number() }),
    net: netOutput,
    underlag_document_id: z.string().nullable(),
  }),
  errorCodes: [
    'SETOFF_DISABLED',
    'SETOFF_FORBIDDEN',
    'SETOFF_INVOICE_NOT_FOUND',
    'SETOFF_SUPPLIER_INVOICE_NOT_FOUND',
    'SETOFF_INVOICE_NOT_ELIGIBLE',
    'SETOFF_SUPPLIER_INVOICE_NOT_ELIGIBLE',
    'SETOFF_INVOICE_NOT_OPEN',
    'SETOFF_SUPPLIER_INVOICE_NOT_OPEN',
    'SETOFF_CURRENCY_UNSUPPORTED',
    'SETOFF_DEDUCTION_UNSUPPORTED',
    'SETOFF_INVOICE_NOT_BOOKED',
    'SETOFF_NO_PARTY',
    'SETOFF_PARTY_MISMATCH',
    'SETOFF_COLLECTION_OPEN',
    'SETOFF_PAYMENT_IN_FLIGHT',
    'SETOFF_INVALID_AMOUNT',
    'SETOFF_AMOUNT_EXCEEDS_REMAINING',
    'SETOFF_DATE_INVALID',
    'SETOFF_NO_FISCAL_PERIOD',
    'SETOFF_PERIOD_LOCKED',
    'SETOFF_LEDGER_MISMATCH',
    'SETOFF_RACE',
    'SETOFF_BOOKING_FAILED',
  ],
  http: { method: 'POST', path: V1 },
  mcp: {
    name: 'gnubok_book_counterparty_setoff',
    title: 'Book Counterparty Set-off',
    description:
      'Stage a kvittning: an open customer invoice set off against an open supplier invoice of the same counterparty (Dr 2440 / Cr 1510, VAT untouched). Both invoices are lowered; the net is matched to the bank line later.',
    keywords: ['kvittning', 'kvitta', 'kvitta fakturor', 'kvittningsverifikat', 'motpart netto', 'set-off', 'netting'],
    stage: {
      pendingType: 'book_counterparty_setoff',
      title: (_input, preview) => {
        const invoice = (preview?.invoice ?? {}) as { number?: string | null }
        const supplierInvoice = (preview?.supplier_invoice ?? {}) as { number?: string | null; arrival_number?: number | null }
        const supplierLabel = supplierInvoice.number ?? (supplierInvoice.arrival_number != null ? `ankomstnr ${supplierInvoice.arrival_number}` : '')
        return `Kvitta kundfaktura ${invoice.number ?? ''} mot leverantörsfaktura ${supplierLabel}`.replace(/\s+/g, ' ').trim()
      },
      // The approver approves the amount, date and counterparty the preview
      // showed: a commit after the invoices changed is refused instead of
      // setting off something else.
      pinParams: (input, preview) => ({
        ...input,
        amount: input.amount ?? preview.amount,
        setoff_date: input.setoff_date ?? preview.setoff_date,
        party_id: input.party_id ?? preview.party_id,
      }),
      extras: (_input, preview) => ({
        periodDate: typeof preview.setoff_date === 'string' ? preview.setoff_date : undefined,
        next: {
          description: 'Once approved, match the net amount to its bank line like any part payment of the invoice that is still open.',
          tool: 'gnubok_get_counterparty_balance',
          args: typeof preview.party_id === 'string' ? { party_id: preview.party_id } : undefined,
        },
      }),
    },
  },
  run: async (ctx, input, { dryRun }) => {
    if (!counterpartySetoffEnabled()) return { ok: false, code: 'SETOFF_DISABLED' }
    return bookCounterpartySetoff(
      ctx,
      {
        invoiceId: input.invoice_id,
        supplierInvoiceId: input.supplier_invoice_id,
        amount: input.amount ?? null,
        setoffDate: input.setoff_date ?? null,
        note: input.note ?? null,
        expectedPartyId: input.party_id ?? null,
      },
      { dryRun },
    )
  },
})

/** Registered only while COUNTERPARTY_SETOFF_ENABLED is set (registry.ts). */
export const COUNTERPARTY_SETOFF_OPERATION_LIST = [invoicesCounterpartyBalanceGet, invoicesSetoffBook] as const
