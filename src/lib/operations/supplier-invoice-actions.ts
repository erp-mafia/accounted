/**
 * Supplier-invoice actions outside create/approve/book/pay/credit: delete an
 * unbooked invoice, undo a credit, change the header (numbers, dates,
 * reference, notes), move one line to another account (inline rättelse of the
 * registration verifikat), and the "inlagd i banken" mark. Rules live in
 * lib/supplier-invoices/manage.ts, lib/supplier-invoices/update-header.ts and
 * lib/supplier-invoices/item-account.ts, shared with the dashboard routes
 * under /api/supplier-invoices/[id].
 *
 * MCP: delete, uncredit, the header change and the line move stage for
 * approval. The header change has no v1 binding of its own: the hand-written
 * PATCH /supplier-invoices/{id} is its v1 door (it keeps a narrower public
 * contract) and calls the same service. The bank mark
 * is v1 only: it books nothing, and an agent that paid an invoice records the
 * payment instead (mark-paid or the bank match).
 */
import { z } from 'zod'
import type { SupplierInvoice } from '@/types'
import { accountNumberSchema } from '@/lib/invariants/zod'
import {
  deleteSupplierInvoice,
  setSupplierInvoiceBankEntered,
  uncreditSupplierInvoice,
} from '@/lib/supplier-invoices/manage'
import { moveSupplierInvoiceItemAccount } from '@/lib/supplier-invoices/item-account'
import { updateSupplierInvoiceHeader } from '@/lib/supplier-invoices/update-header'
import { UpdateSupplierInvoiceSchema } from '@/lib/api/schemas'
import { defineOperation } from './types'

const META = { request_id: 'req_…', api_version: '2026-05-12' }

const SUPPLIER_INVOICE_ID = z.string().uuid().describe('The supplier invoice id, from GET /supplier-invoices.')

const SupplierInvoiceState = z.object({
  supplier_invoice_id: z.string().uuid(),
  arrival_number: z.number().nullable(),
  supplier_invoice_number: z.string().nullable(),
  status: z.string(),
  invoice_date: z.string(),
  due_date: z.string().nullable(),
  currency: z.string(),
  total: z.number(),
  remaining_amount: z.number().nullable(),
  registration_journal_entry_id: z.string().uuid().nullable(),
})

function toState(row: SupplierInvoice): z.infer<typeof SupplierInvoiceState> {
  return {
    supplier_invoice_id: row.id,
    arrival_number: row.arrival_number ?? null,
    supplier_invoice_number: row.supplier_invoice_number ?? null,
    status: row.status,
    invoice_date: row.invoice_date,
    due_date: row.due_date ?? null,
    currency: row.currency,
    total: row.total,
    remaining_amount: row.remaining_amount ?? null,
    registration_journal_entry_id: row.registration_journal_entry_id ?? null,
  }
}

// ---------------------------------------------------------------------------
// supplier-invoices.delete
// ---------------------------------------------------------------------------

export const supplierInvoicesDelete = defineOperation({
  id: 'supplier-invoices.delete',
  kind: 'write',
  scope: 'suppliers:write',
  risk: 'medium',
  reversible: false,
  docs: {
    summary: 'Delete an unbooked, unpaid supplier invoice (no verifikat, no payment).',
    description:
      'Removes a supplier invoice that never reached the books: status registered, approved or overdue, no registration verifikat, no payment, no accrual schedule and no payment-batch row. Its lines go with it. A booked invoice is never deleted: withdraw it with a credit note (POST /supplier-invoices/{id}/credit), which keeps both verifikat in the audit trail (BFL 5 kap 5 §). Idempotent. Dry-runnable.',
    useWhen:
      'A supplier invoice was registered by mistake (a duplicate, the wrong company, a quote) under defer_invoice_booking or kontantmetoden, so no verifikat exists yet.',
    doNotUseFor:
      'Booked invoices (credit them), credit notes (undo the credit on the original: POST /supplier-invoices/{id}/uncredit) or discarding an inbox item (DELETE /inbox-items/{id}).',
    pitfalls: [
      'An invoice with a registration verifikat, a payment or an accrual schedule answers 400 SI_DELETE_HAS_BOOKING with details.reason (registration_journal_entry, payments, accrual_schedule).',
      'A credit note answers 400 SI_DELETE_CREDIT_NOTE; paid, partially paid or credited invoices answer 400 SI_DELETE_INVALID_STATUS.',
      'An invoice in a payment batch (even a cancelled one) answers 409 SI_DELETE_IN_PAYMENT_BATCH: the batch rows document the payment instruction.',
      'The ankomstnummer the invoice held is not reused.',
    ],
    example: {
      response: { data: { supplier_invoice_id: '3b4c…', deleted: true }, meta: META },
    },
  },
  input: z.object({ supplier_invoice_id: SUPPLIER_INVOICE_ID }),
  output: z.object({ supplier_invoice_id: z.string().uuid(), deleted: z.literal(true) }),
  errorCodes: [
    'SI_NOT_FOUND',
    'SI_DELETE_CREDIT_NOTE',
    'SI_DELETE_INVALID_STATUS',
    'SI_DELETE_HAS_BOOKING',
    'SI_DELETE_IN_PAYMENT_BATCH',
  ],
  http: {
    method: 'DELETE',
    path: '/api/v1/companies/:companyId/supplier-invoices/:id',
    pathParams: { id: 'supplier_invoice_id' },
  },
  mcp: {
    name: 'gnubok_delete_supplier_invoice',
    title: 'Delete Supplier Invoice',
    description:
      'Stage deleting an unbooked, unpaid supplier invoice (no verifikat, payment, accrual or payment batch). Refused for credit notes and anything booked: credit a booked invoice instead.',
    keywords: ['ta bort leverantörsfaktura', 'radera leverantörsfaktura', 'felregistrerad leverantörsfaktura', 'dubblett leverantörsfaktura'],
    stage: { pendingType: 'delete_supplier_invoice', title: () => 'Ta bort leverantörsfaktura' },
  },
  run: (ctx, { supplier_invoice_id }, { dryRun }) => deleteSupplierInvoice(ctx, supplier_invoice_id, { dryRun }),
})

// ---------------------------------------------------------------------------
// supplier-invoices.uncredit
// ---------------------------------------------------------------------------

export const supplierInvoicesUncredit = defineOperation({
  id: 'supplier-invoices.uncredit',
  kind: 'write',
  scope: 'suppliers:write',
  risk: 'high',
  reversible: false,
  docs: {
    summary: 'Undo the credit of a supplier invoice ("Ångra kreditering"): storno the credit note\'s verifikat and restore the invoice.',
    description:
      'For an original supplier invoice with status credited: posts a storno cancelling the live credit note\'s verifikat (dated on that verifikat\'s date, never an edit or delete), marks the credit note reversed (the row is kept for the archive and the ankomstnummer series), and restores the original\'s status and remaining amount from its payments (paid, partially_paid, overdue, approved when it was attested, else registered, where it waits for attest again). The invoice can be credited again afterwards. An invoice that is not credited is an idempotent no-op (changed=false). Dry-runnable: the preview names the storno and the restored status.',
    useWhen: 'A supplier invoice was credited by mistake and the credit should be taken back.',
    doNotUseFor:
      'Crediting an invoice (POST /supplier-invoices/{id}/credit), deleting an unbooked invoice (DELETE /supplier-invoices/{id}) or reversing an arbitrary verifikat.',
    pitfalls: [
      'Pass the ORIGINAL invoice id, not the credit note\'s: a credit note\'s id answers 400 SI_UNCREDIT_CREDIT_NOTE, on a dry run too, and details.credited_invoice_id names its original.',
      'The credit note\'s verifikat must lie in an open, unlocked period: otherwise the dry run answers 400 PERIOD_LOCKED and the commit 400 SI_UNCREDIT_FAILED.',
      'A credit verifikat already reversed by hand is fine: the row cleanup still runs and reversal_entry_id is null.',
    ],
    example: {
      response: {
        data: {
          supplier_invoice: {
            supplier_invoice_id: '3b4c…',
            arrival_number: 118,
            supplier_invoice_number: '55012',
            status: 'approved',
            invoice_date: '2026-09-03',
            due_date: '2026-10-03',
            currency: 'SEK',
            total: 6250,
            remaining_amount: 6250,
            registration_journal_entry_id: '6d7e…',
          },
          reversal_entry_id: '9a8b…',
          reversed_credit_note_id: '5c6d…',
          changed: true,
        },
        meta: META,
      },
    },
  },
  input: z.object({ supplier_invoice_id: SUPPLIER_INVOICE_ID.describe('The ORIGINAL (credited) supplier invoice id, not the credit note.') }),
  output: z.object({
    supplier_invoice: SupplierInvoiceState,
    reversal_entry_id: z.string().uuid().nullable().describe('The storno verifikat, when the credit note had a posted one.'),
    reversed_credit_note_id: z.string().uuid().nullable(),
    changed: z.boolean().describe('False when the invoice was not credited (nothing done).'),
  }),
  errorCodes: ['SI_NOT_FOUND', 'SI_UNCREDIT_CREDIT_NOTE', 'PERIOD_LOCKED', 'SI_UNCREDIT_FAILED'],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/supplier-invoices/:id/uncredit',
    pathParams: { id: 'supplier_invoice_id' },
  },
  mcp: {
    name: 'gnubok_uncredit_supplier_invoice',
    title: 'Uncredit Supplier Invoice',
    description:
      'Stage undoing a supplier invoice credit: a storno cancels the credit note\'s verifikat, the credit note is kept as reversed and the original is restored from its payments. Pass the original invoice id. No-op when not credited.',
    keywords: ['ångra kreditering', 'ångra kreditfaktura', 'återställ leverantörsfaktura', 'felaktig kreditering'],
    stage: { pendingType: 'uncredit_supplier_invoice', title: () => 'Ångra kreditering av leverantörsfaktura' },
  },
  run: async (ctx, { supplier_invoice_id }, { dryRun }) => {
    const outcome = await uncreditSupplierInvoice(ctx, supplier_invoice_id, { dryRun })
    if (!outcome.ok || outcome.dryRun) return outcome
    return {
      ok: true,
      data: {
        supplier_invoice: toState(outcome.data.supplier_invoice),
        reversal_entry_id: outcome.data.reversal_entry_id,
        reversed_credit_note_id: outcome.data.reversed_credit_note_id,
        changed: outcome.data.changed,
      },
    }
  },
})

// ---------------------------------------------------------------------------
// supplier-invoices.update
// ---------------------------------------------------------------------------

const HEADER = UpdateSupplierInvoiceSchema.shape

/** What the header change reads and answers: the header, and the columns its rules need. */
const HEADER_COLUMNS =
  'id, arrival_number, supplier_invoice_number, invoice_date, due_date, delivery_date, payment_reference, notes, status, currency, total, remaining_amount, registration_journal_entry_id, is_credit_note, is_self_billed, approved_at'

const SupplierInvoiceHeaderState = SupplierInvoiceState.extend({
  delivery_date: z.string().nullable(),
  payment_reference: z.string().nullable(),
  notes: z.string().nullable(),
})

/** The stored row under the qualified id, without the columns only the rules read. */
function toHeaderState(row: Record<string, unknown>): Record<string, unknown> {
  const { id, is_credit_note: _creditNote, is_self_billed: _selfBilled, approved_at: _approvedAt, ...header } = row
  return { supplier_invoice_id: id, ...header }
}

export const supplierInvoicesUpdate = defineOperation({
  id: 'supplier-invoices.update',
  kind: 'write',
  scope: 'suppliers:write',
  // Medium although nothing is booked: the due date and the payment reference
  // decide when and with which reference the invoice is paid.
  risk: 'medium',
  reversible: true,
  docs: {
    summary: 'Change the header of an unpaid supplier invoice: number, dates, payment reference, notes.',
    description:
      'Changes the header of a supplier invoice that is still unsettled (registered, approved or overdue): due_date, delivery_date, payment_reference, notes, and, while no registration verifikat exists, invoice_date and supplier_invoice_number. Never an amount, an account or a line, and never a journal entry: once the registration verifikat is posted, invoice_date and supplier_invoice_number are on it and are refused here. The overdue label follows the new due date at once. Dry-runnable: the preview answers the resulting header with `changes` (each changed field, from and to).',
    useWhen:
      'The due date, the OCR or payment reference, the delivery date or the notes of an unpaid supplier invoice are wrong or missing, e.g. a reading that found no due date and fell back on invoice date + 30 days.',
    doNotUseFor:
      'Amounts, VAT or lines (credit the invoice and register a new one), the account of a line (gnubok_update_supplier_invoice_item_account), paid, credited or reversed invoices, or the date and number of a booked invoice (correct the verifikat: gnubok_correct_entry).',
    pitfalls: [
      'A paid, partially paid, credited or reversed invoice answers 400 SI_EDIT_INVALID_STATUS.',
      'invoice_date or supplier_invoice_number on an invoice with a registration verifikat answers 400 SI_EDIT_VERIFIKAT_LOCKED with details.fields and details.journal_entry_id. Resending the stored value is accepted.',
      'An issued self-billing invoice keeps its number and date: 409 SI_SELF_BILL_IMMUTABLE.',
      'At least one field beside supplier_invoice_id is required: otherwise 400 VALIDATION_ERROR.',
      'A payment, attest or booking that lands between staging and approval answers 409 SI_EDIT_CONFLICT (or SI_EDIT_VERIFIKAT_LOCKED): read the invoice again and stage anew.',
    ],
    example: {
      request: { due_date: '2026-10-15' },
      response: {
        data: {
          supplier_invoice_id: '3b4c…',
          arrival_number: 118,
          supplier_invoice_number: '55012',
          status: 'approved',
          invoice_date: '2026-09-03',
          due_date: '2026-10-15',
          delivery_date: null,
          payment_reference: '5501200018',
          notes: null,
          currency: 'SEK',
          total: 6250,
          remaining_amount: 6250,
          registration_journal_entry_id: '6d7e…',
        },
        meta: META,
      },
    },
  },
  input: z.object({
    supplier_invoice_id: SUPPLIER_INVOICE_ID,
    due_date: HEADER.due_date.describe('New due date, YYYY-MM-DD.'),
    payment_reference: HEADER.payment_reference.describe('OCR or other payment reference.'),
    notes: HEADER.notes,
    delivery_date: HEADER.delivery_date.describe('Delivery date, YYYY-MM-DD.'),
    invoice_date: HEADER.invoice_date.describe('Only while the invoice has no registration verifikat.'),
    supplier_invoice_number: HEADER.supplier_invoice_number.describe(
      "The supplier's own invoice number. Only while the invoice has no registration verifikat.",
    ),
  }),
  output: SupplierInvoiceHeaderState,
  errorCodes: [
    'SI_NOT_FOUND',
    'VALIDATION_ERROR',
    'SI_EDIT_INVALID_STATUS',
    'SI_SELF_BILL_IMMUTABLE',
    'SI_EDIT_VERIFIKAT_LOCKED',
    'SI_EDIT_CONFLICT',
  ],
  mcp: {
    name: 'gnubok_update_supplier_invoice',
    title: 'Update Supplier Invoice',
    description:
      'Stage a change to the header of an unpaid supplier invoice: due_date, payment_reference, notes, delivery_date. invoice_date and supplier_invoice_number only before the registration verifikat exists. Never amounts, accounts or lines; books nothing.',
    keywords: [
      'ändra förfallodatum',
      'förfallodag leverantörsfaktura',
      'ändra leverantörsfaktura',
      'uppdatera leverantörsfaktura',
      'ocr leverantörsfaktura',
      'betalningsreferens',
      'update supplier invoice',
      'due date',
    ],
    stage: {
      pendingType: 'update_supplier_invoice',
      title: (_input, preview) => {
        const number = preview?.supplier_invoice_number ?? (preview?.arrival_number != null ? `ankomst ${String(preview.arrival_number)}` : '')
        return `Ändra leverantörsfaktura ${String(number)}`.trim()
      },
    },
  },
  run: async (ctx, { supplier_invoice_id, ...patch }, { dryRun }) => {
    const outcome = await updateSupplierInvoiceHeader(ctx, supplier_invoice_id, patch, { dryRun, columns: HEADER_COLUMNS })
    if (!outcome.ok) return outcome
    if (outcome.dryRun) return { ok: true, dryRun: true, preview: toHeaderState(outcome.preview) }
    return { ok: true, data: toHeaderState(outcome.data) as z.infer<typeof SupplierInvoiceHeaderState> }
  },
})

// ---------------------------------------------------------------------------
// supplier-invoices.update-item-account
// ---------------------------------------------------------------------------

export const supplierInvoicesUpdateItemAccount = defineOperation({
  id: 'supplier-invoices.update-item-account',
  kind: 'write',
  scope: 'suppliers:write',
  risk: 'high',
  reversible: true,
  docs: {
    summary: 'Move one supplier-invoice line to another account, correcting the registration verifikat inline.',
    description:
      'Changes the account of one line on an unsettled supplier invoice (registered, approved, overdue). When the invoice has a posted registration verifikat, the same verifikat is corrected inside itself through the inline rättelse (the old line is struck and replaced, split when the verifikat carries one line per account), logged with who and when (BFL 5 kap 5 §); that is only allowed in an open, unlocked period. Without a verifikat only the line changes. A standard BAS account missing from the chart is added. Idempotent. Dry-runnable: the preview carries the planned rättelse lines.',
    useWhen: 'A supplier invoice line was booked on the wrong cost account (e.g. 6580 instead of 6550) and the period is still open.',
    doNotUseFor:
      'Settled invoices (paid, credited), locked or closed periods (storno through POST /journal-entries/{id}/reverse and a new verifikat), or changing amounts or VAT.',
    pitfalls: [
      'A settled invoice answers 409 SI_ITEM_ACCOUNT_SETTLED.',
      'A locked or closed period answers 409 JOURNAL_RATTELSE_PERIOD_LOCKED: past a lock, storno is the only lawful correction.',
      'When the verifikat was already corrected by hand and holds no matching line on the old account, the answer is 409 SI_ITEM_ACCOUNT_NO_MATCHING_LINE and nothing changes.',
      'A foreign-currency line moves the kronor the registration booked (the line at the invoice\'s stored rate); an invoice without that rate answers 409 SI_ITEM_ACCOUNT_FX_RATE_UNKNOWN and nothing changes.',
      'account_number is a STRING ("6550"), never a number.',
    ],
    example: {
      request: { account_number: '6550' },
      response: { data: { changed: true, corrected: true }, meta: META },
    },
  },
  input: z.object({
    supplier_invoice_id: SUPPLIER_INVOICE_ID,
    supplier_invoice_item_id: z.string().uuid().describe('The line id (items[].id from GET /supplier-invoices/{id}?expand=items).'),
    account_number: accountNumberSchema.describe('The BAS account to move the line to, as a string, e.g. "6550".'),
  }),
  output: z.object({
    changed: z.boolean().describe('False when the line was already on that account.'),
    corrected: z.boolean().optional().describe('True when the registration verifikat was corrected inline.'),
  }),
  errorCodes: [
    'SI_NOT_FOUND',
    'SI_ITEM_NOT_FOUND',
    'SI_ITEM_ACCOUNT_SETTLED',
    'SI_ITEM_ACCOUNT_NO_MATCHING_LINE',
    'SI_ITEM_ACCOUNT_FX_RATE_UNKNOWN',
    'JOURNAL_RATTELSE_PERIOD_LOCKED',
    'JOURNAL_RATTELSE_REFUSED',
    'SI_ITEM_ACCOUNT_UPDATE_FAILED',
  ],
  http: {
    method: 'PATCH',
    path: '/api/v1/companies/:companyId/supplier-invoices/:id/items/:itemId',
    pathParams: { id: 'supplier_invoice_id', itemId: 'supplier_invoice_item_id' },
  },
  mcp: {
    name: 'gnubok_update_supplier_invoice_item_account',
    title: 'Move Supplier Invoice Line',
    description:
      'Stage moving one supplier invoice line to another account. A posted registration verifikat is corrected inline in the same verifikat (open, unlocked period only; storno otherwise). Refused for settled invoices.',
    keywords: ['byt konto leverantörsfaktura', 'fel konto', 'flytta rad', 'rätta konto', 'omkontering'],
    stage: {
      pendingType: 'update_supplier_invoice_item_account',
      title: (input) => `Flytta leverantörsfakturarad till konto ${String(input.account_number)}`,
    },
  },
  run: (ctx, { supplier_invoice_id, supplier_invoice_item_id, account_number }, { dryRun }) =>
    moveSupplierInvoiceItemAccount(ctx, supplier_invoice_id, supplier_invoice_item_id, account_number, { dryRun }),
})

// ---------------------------------------------------------------------------
// supplier-invoices.mark-bank-entered
// ---------------------------------------------------------------------------

export const supplierInvoicesMarkBankEntered = defineOperation({
  id: 'supplier-invoices.mark-bank-entered',
  kind: 'write',
  scope: 'suppliers:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Mark a supplier invoice as entered in the internet bank ("inlagd i banken"), or clear the mark.',
    description:
      'Records that the payment was entered in the bank by hand, so the invoice stops showing as waiting to be paid. A mark, not a payment: it books nothing and changes no amount or status; the payment is still recorded by :mark-paid or the bank match, and the mark clears itself when one of those lands. entered=true needs an unpaid, payable invoice (approved, overdue, partially_paid, and registered under kontantmetoden, which has no attest step; never a credit note); entered=false clears it in any status. Marking an already marked invoice keeps the first timestamp. Idempotent. Dry-runnable.',
    useWhen: 'The user paid the invoice by typing it into the internet bank (not through a betalfil) and wants the list to say so until the bank transaction arrives.',
    doNotUseFor: 'Recording the payment itself (POST /supplier-invoices/{id}/mark-paid) or payment batches (betalfil).',
    pitfalls: [
      'A registered invoice still waiting for attest (faktureringsmetoden), a paid or credited invoice, or a credit note, answers 400 SI_BANK_ENTERED_NOT_PAYABLE with details.currentStatus.',
      'details.reason race means a payment landed between the read and the write: reload.',
    ],
    example: {
      request: { entered: true },
      response: { data: { supplier_invoice_id: '3b4c…', bank_entered_at: '2026-09-06T10:00:00.000Z' }, meta: META },
    },
  },
  input: z.object({
    supplier_invoice_id: SUPPLIER_INVOICE_ID,
    entered: z.boolean().describe('true marks the invoice as entered in the bank, false clears the mark.'),
  }),
  output: z.object({ supplier_invoice_id: z.string().uuid(), bank_entered_at: z.string().nullable() }),
  errorCodes: ['SI_NOT_FOUND', 'SI_BANK_ENTERED_NOT_PAYABLE'],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/supplier-invoices/:id/bank-entered',
    pathParams: { id: 'supplier_invoice_id' },
  },
  run: async (ctx, { supplier_invoice_id, entered }, { dryRun }) => {
    const outcome = await setSupplierInvoiceBankEntered(ctx, supplier_invoice_id, entered, { dryRun })
    if (!outcome.ok || outcome.dryRun) return outcome
    return { ok: true, data: { supplier_invoice_id: outcome.data.id, bank_entered_at: outcome.data.bank_entered_at } }
  },
})
