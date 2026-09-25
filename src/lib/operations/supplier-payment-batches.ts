/**
 * Supplier payment batch (betalfil) operations: preview which supplier
 * invoices can be paid, create a batch (an ISO 20022 pain.001 payment file
 * the customer uploads to their bank), list and read batches, download the
 * file, cancel a batch. Rules live in lib/payments/batch-service.ts and
 * lib/payments/batch-operations.ts; the dashboard routes under
 * /api/supplier-invoices/payment-batches call the same services.
 *
 * A batch books NOTHING and settles nothing: settlement stays with
 * mark-paid or bank matching once the bank has executed the payments.
 *
 * The file download has no MCP binding on purpose: an XML payment file is
 * not something an agent should carry through a chat transcript, and the
 * bank upload is a human step anyway. gnubok_get_supplier_payment_batch
 * answers the file's name and where to download it over v1.
 */
import { z } from 'zod'
import { isoDateSchema } from '@/lib/invariants/zod'
import { MAX_LIMIT, DEFAULT_LIMIT } from '@/lib/api/v1/pagination'
import { ORE_TOLERANCE } from '@/lib/money'
import { previewSupplierPaymentBatch, supplierPaymentBatchFilename } from '@/lib/payments/batch-service'
import {
  cancelPaymentBatch,
  createPaymentBatch,
  downloadPaymentBatchFile,
  getPaymentBatch,
  listPaymentBatches,
  payeeOf,
} from '@/lib/payments/batch-operations'
import { formatPayeeLabel } from '@/lib/payments/supplier-payee'
import type { SupplierPaymentBatch } from '@/types'
import { defineOperation } from './types'

const FORMAT = z
  .enum(['pain001'])
  .default('pain001')
  .describe('File format. pain001 (ISO 20022 pain.001.001.03, accepted by every Swedish bank) is the only one.')

const BATCH_ID = z
  .string()
  .uuid()
  .describe('The payment batch id (supplier_payment_batch_id from the list or create answer).')

const WARNING = z
  .enum(['unattested', 'already_batched', 'ocr_invalid', 'payee_city_missing'])
  .describe(
    'unattested: not attested yet; already_batched: sits in another active batch; ocr_invalid: the OCR fails its check digit, so the invoice number is sent as a message instead; payee_city_missing: the supplier has no city, which some banks (Swedbank) reject.',
  )

const Payee = z.object({
  type: z.enum(['bankgiro', 'plusgiro', 'bank_account']),
  label: z.string().describe('Display form, e.g. "BG 5050-1055".'),
})

const Reference = z.object({
  type: z.enum(['ocr', 'invoice_number']),
  value: z.string(),
})

const BatchSummary = z.object({
  supplier_payment_batch_id: z.string().uuid(),
  format: z.literal('pain001'),
  status: z.enum(['created', 'cancelled']),
  currency: z.string(),
  total_amount: z.number(),
  item_count: z.number().int(),
  settled_count: z
    .number()
    .int()
    .describe('Member invoices with nothing left to pay, from the live invoices (paid via mark-paid or bank matching).'),
  msg_id: z.string().describe('pain.001 MsgId, fixed at creation; the bank de-duplicates on it.'),
  file_generated_at: z.string().nullable().describe('Last download of the file, or null if never downloaded.'),
  download_count: z.number().int(),
  created_at: z.string(),
  cancelled_at: z.string().nullable(),
  supplier_invoice_ids: z.array(z.string().uuid()),
})

type BatchSummaryOut = z.infer<typeof BatchSummary>

function toSummary(
  batch: SupplierPaymentBatch,
  settledCount: number,
  supplierInvoiceIds: string[],
): BatchSummaryOut {
  return {
    supplier_payment_batch_id: batch.id,
    format: 'pain001',
    status: batch.status as 'created' | 'cancelled',
    currency: batch.currency,
    total_amount: batch.total_amount,
    item_count: batch.item_count,
    settled_count: settledCount,
    msg_id: batch.msg_id,
    file_generated_at: batch.file_generated_at ?? null,
    download_count: batch.download_count ?? 0,
    created_at: batch.created_at,
    cancelled_at: batch.cancelled_at ?? null,
    supplier_invoice_ids: supplierInvoiceIds,
  }
}

/** expected_payees from a create dry run's preview items. */
function pinnedPayees(preview: Record<string, unknown>): Array<{ supplier_invoice_id: string; payee_fingerprint: string; amount: number }> {
  const items = Array.isArray(preview.items) ? (preview.items as Array<Record<string, unknown>>) : []
  return items.map((item) => ({
    supplier_invoice_id: String(item.supplier_invoice_id),
    payee_fingerprint: String((item.payee as Record<string, unknown> | undefined)?.fingerprint ?? ''),
    amount: Number(item.amount),
  }))
}

const FILE_PATH = '/api/v1/companies/{companyId}/supplier-payment-batches/{supplier_payment_batch_id}/file'

const META = { request_id: 'req_…', api_version: '2026-05-12' }
const EXAMPLE_BATCH_ID = '5b0c…'
const EXAMPLE_INVOICE_ID = '9e2f…'

const EXAMPLE_SUMMARY = {
  supplier_payment_batch_id: EXAMPLE_BATCH_ID,
  format: 'pain001',
  status: 'created',
  currency: 'SEK',
  total_amount: 12500,
  item_count: 2,
  settled_count: 0,
  msg_id: 'ACCOUNTED-5566778899-B5B0C1A2F',
  file_generated_at: null,
  download_count: 0,
  created_at: '2026-09-25T09:00:00Z',
  cancelled_at: null,
  supplier_invoice_ids: [EXAMPLE_INVOICE_ID, '0a7d…'],
}

// ─────────────────────────────────────────────────────────────────
// preview
// ─────────────────────────────────────────────────────────────────

export const supplierPaymentBatchesPreview = defineOperation({
  id: 'supplier-payment-batches.preview',
  kind: 'read',
  scope: 'suppliers:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Check which supplier invoices can go into a payment file (betalfil), with amounts, payees and warnings.',
    description:
      'Evaluates the given supplier invoices exactly as create will: eligible lines with the default amount (the remaining amount), payment date (the due date, or today when it has passed), payee (bankgiro, plusgiro or bank account from the supplier) and reference (OCR when valid, else the invoice number), plus non-blocking warnings; excluded invoices with the reason; and whether the company\'s own bank details (IBAN, BIC, org number: the pain.001 debtor) are complete. Reads only; creates nothing.',
    useWhen: 'Before creating a payment batch, to see what would be paid and what blocks it.',
    doNotUseFor:
      'Creating the batch (POST /supplier-payment-batches) or listing unpaid supplier invoices (GET /supplier-invoices).',
    pitfalls: [
      'Excluded reasons: not_payable (draft, paid, credited...), nothing_remaining, credit_note, foreign_currency (only SEK), payee_missing / payee_invalid (fix the supplier\'s bankgiro, plusgiro or clearing + account number), not_found.',
      'debtor_ok false means create will refuse with SI_BATCH_DEBTOR_INCOMPLETE: debtor_missing names the company setting to fill in (iban, bic or org_number).',
      'already_batched is a warning here but a refusal at create unless confirm_already_batched is true: paying the same invoice twice is the risk.',
      'Only SEK invoices; at most 100 per call.',
    ],
    example: {
      request: { supplier_invoice_ids: [EXAMPLE_INVOICE_ID] },
      response: {
        data: {
          eligible: [
            {
              supplier_invoice_id: EXAMPLE_INVOICE_ID,
              supplier_name: 'Derome Bygg AB',
              supplier_invoice_number: 'CD3014794407',
              amount: 737.5,
              payment_date: '2026-10-01',
              payee: { type: 'bankgiro', label: 'BG 5050-1055' },
              reference: { type: 'invoice_number', value: 'CD3014794407' },
              warnings: ['payee_city_missing'],
              active_supplier_payment_batch_id: null,
            },
          ],
          excluded: [],
          total_amount: 737.5,
          currency: 'SEK',
          debtor_ok: true,
          debtor_missing: null,
        },
        meta: META,
      },
    },
  },
  input: z.object({
    format: FORMAT,
    supplier_invoice_ids: z
      .array(z.string().uuid())
      .min(1)
      .max(100)
      .describe('The supplier invoices to evaluate (supplier_invoice_id), 1-100.'),
  }),
  output: z.object({
    eligible: z.array(
      z.object({
        supplier_invoice_id: z.string().uuid(),
        supplier_name: z.string(),
        supplier_invoice_number: z.string(),
        amount: z.number(),
        payment_date: z.string(),
        payee: Payee,
        reference: Reference,
        warnings: z.array(WARNING),
        active_supplier_payment_batch_id: z.string().uuid().nullable(),
      }),
    ),
    excluded: z.array(
      z.object({
        supplier_invoice_id: z.string(),
        reason: z.enum([
          'not_payable',
          'nothing_remaining',
          'credit_note',
          'foreign_currency',
          'payee_missing',
          'payee_invalid',
          'not_found',
        ]),
      }),
    ),
    total_amount: z.number(),
    currency: z.literal('SEK'),
    debtor_ok: z.boolean(),
    debtor_missing: z.enum(['iban', 'bic', 'org_number']).nullable(),
  }),
  http: { method: 'POST', path: '/api/v1/companies/:companyId/supplier-payment-batches/preview' },
  mcp: {
    name: 'gnubok_preview_supplier_payment_batch',
    title: 'Preview Supplier Payment Batch',
    description:
      'Check which supplier invoices can go into a betalfil (pain.001): per invoice the amount, payment date, payee, reference and warnings, or why it is excluded, and whether the company bank details are complete. Read-only; call before gnubok_create_supplier_payment_batch.',
    keywords: ['betalfil', 'betala leverantörer', 'betalningsfil', 'pain.001', 'leverantörsbetalning', 'utbetalning', 'förhandsgranska betalfil'],
  },
  run: async (ctx, input) => {
    const preview = await previewSupplierPaymentBatch(ctx.supabase, ctx.companyId, { ids: input.supplier_invoice_ids })
    return {
      ok: true,
      data: {
        eligible: preview.eligible.map((line) => ({
          supplier_invoice_id: line.id,
          supplier_name: line.supplier_name,
          supplier_invoice_number: line.invoice_number,
          amount: line.amount,
          payment_date: line.payment_date,
          payee: line.payee as z.infer<typeof Payee>,
          reference: line.reference,
          warnings: line.warnings,
          active_supplier_payment_batch_id: line.active_batch_id,
        })),
        excluded: preview.excluded.map((line) => ({ supplier_invoice_id: line.id, reason: line.reason })),
        total_amount: preview.total,
        currency: 'SEK' as const,
        debtor_ok: preview.debtor_ok,
        debtor_missing: preview.debtor_missing ?? null,
      },
    }
  },
})

// ─────────────────────────────────────────────────────────────────
// create
// ─────────────────────────────────────────────────────────────────

export const supplierPaymentBatchesCreate = defineOperation({
  id: 'supplier-payment-batches.create',
  kind: 'write',
  scope: 'suppliers:write',
  risk: 'high',
  reversible: false,
  docs: {
    summary: 'Create a supplier payment file (betalfil, pain.001) for one or more supplier invoices.',
    description:
      'Creates a payment batch: an immutable snapshot of one credit transfer per invoice (amount, payment date, the supplier\'s bankgiro / plusgiro / bank account, OCR or invoice-number reference) and the company\'s own bank details as debtor, with a pain.001 MsgId fixed at creation. Every invoice is re-read and re-checked inside one transaction, so an invoice settled or already batched meanwhile is refused. Books nothing and marks nothing paid. Download the XML with GET /supplier-payment-batches/{id}/file and upload it in the bank, where the payments are signed; afterwards settle each invoice with mark-paid or bank matching. Idempotent. Dry-runnable.',
    useWhen:
      'The user wants to pay approved supplier invoices through their bank\'s file upload (typically the weekly or monthly payment run).',
    doNotUseFor:
      'Marking invoices paid (POST /supplier-invoices/{id}/mark-paid), paying salaries (salary-runs/{id}/payment-file) or sending anything to the bank: this only produces the file.',
    pitfalls: [
      'Money leaves the company\'s account once the file is uploaded and signed in the bank: preview first (POST /supplier-payment-batches/preview) and check amounts and payees.',
      'An invoice already in an active batch answers 409 SI_BATCH_DUPLICATE_INVOICE with details.invoices; resend with confirm_already_batched true only when paying it twice is intended, otherwise cancel the old batch.',
      'Incomplete company bank details answer 400 SI_BATCH_DEBTOR_INCOMPLETE; details.missing is iban, bic or org_number (company settings).',
      'An ineligible invoice fails the whole request with 400 SI_BATCH_INELIGIBLE_INVOICE and a reason per invoice; amount above the remaining amount answers 400 SI_BATCH_AMOUNT_EXCEEDS_REMAINING.',
      'A payment_date in the past is moved to today (banks reject passed execution dates). Only SEK invoices; at most 100 per batch.',
      'Between two requests (dry run, then create) a supplier\'s bank details can change: pass expected_payees from the dry run\'s items (payee.fingerprint, amount) and create answers 409 SI_BATCH_PAYEE_CHANGED instead of paying a changed account. A staged MCP create is pinned this way automatically.',
    ],
    example: {
      request: { items: [{ supplier_invoice_id: EXAMPLE_INVOICE_ID }, { supplier_invoice_id: '0a7d…', amount: 5000 }] },
      response: {
        data: {
          supplier_payment_batch_id: EXAMPLE_BATCH_ID,
          msg_id: 'ACCOUNTED-5566778899-B5B0C1A2F',
          format: 'pain001',
          status: 'created',
          currency: 'SEK',
          total_amount: 12500,
          item_count: 2,
          created_at: '2026-09-25T09:00:00Z',
          file: { filename: 'betalfil_20260925_5b0c1a2f.xml', download: FILE_PATH },
        },
        meta: META,
      },
    },
  },
  input: z.object({
    format: FORMAT,
    items: z
      .array(
        z.object({
          supplier_invoice_id: z.string().uuid(),
          amount: z
            .number()
            .positive()
            .optional()
            .describe('Amount to pay in SEK; defaults to the invoice\'s remaining amount. Never above it.'),
          payment_date: isoDateSchema
            .optional()
            .describe('Execution date YYYY-MM-DD; defaults to the due date, or today when that has passed.'),
        }),
      )
      .min(1)
      .max(100)
      .describe('One line per supplier invoice, 1-100.'),
    confirm_already_batched: z
      .boolean()
      .optional()
      .describe('true includes invoices that already sit in another active batch (pays them twice if both files are uploaded).'),
    expected_payees: z
      .array(
        z.object({
          supplier_invoice_id: z.string().uuid(),
          payee_fingerprint: z.string().regex(/^[0-9a-f]{64}$/).describe('items[].payee.fingerprint from a dry run.'),
          amount: z.number().positive(),
        }),
      )
      .max(100)
      .optional()
      .describe(
        'Optional lock: per invoice the payee fingerprint and amount a dry run showed. Create refuses with 409 SI_BATCH_PAYEE_CHANGED if either changed. Staging over MCP fills this in itself.',
      ),
  }),
  output: z.object({
    supplier_payment_batch_id: z.string().uuid(),
    msg_id: z.string(),
    format: z.literal('pain001'),
    status: z.literal('created'),
    currency: z.string(),
    total_amount: z.number(),
    item_count: z.number().int(),
    created_at: z.string(),
    file: z.object({ filename: z.string(), download: z.string() }),
  }),
  errorCodes: [
    'SI_BATCH_DEBTOR_INCOMPLETE',
    'SI_BATCH_INELIGIBLE_INVOICE',
    'SI_BATCH_INVALID_AMOUNT',
    'SI_BATCH_AMOUNT_EXCEEDS_REMAINING',
    'SI_BATCH_DUPLICATE_INVOICE',
    'SI_BATCH_PAYEE_CHANGED',
    'SI_BATCH_CREATE_FAILED',
  ],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/supplier-payment-batches' },
  mcp: {
    name: 'gnubok_create_supplier_payment_batch',
    title: 'Create Supplier Payment Batch',
    description:
      'Stage a betalfil (pain.001) for supplier invoices: one payment per invoice to the supplier\'s bankgiro/plusgiro/account. Books nothing; money moves only when the file is uploaded and signed in the bank. Run gnubok_preview_supplier_payment_batch first.',
    keywords: ['betalfil', 'skapa betalfil', 'betala leverantörsfakturor', 'betalningsfil', 'pain.001', 'leverantörsbetalning', 'betalningsuppdrag'],
    stage: {
      pendingType: 'create_supplier_payment_batch',
      title: (input) => {
        const count = Array.isArray(input.items) ? input.items.length : 0
        return `Ny betalfil: ${count} ${count === 1 ? 'leverantörsfaktura' : 'leverantörsfakturor'}`
      },
      // The approver approves the payees and amounts the preview showed; the
      // commit refuses (SI_BATCH_PAYEE_CHANGED) if a supplier's payment
      // details or the amount changed in between, rather than paying the new
      // account. Fingerprints only: no account number lands in the params.
      pinParams: (input, preview) => ({
        ...input,
        expected_payees: pinnedPayees(preview),
      }),
    },
  },
  run: async (ctx, input, { dryRun }) => {
    const outcome = await createPaymentBatch(ctx, input, { dryRun })
    if (!outcome.ok || outcome.dryRun) return outcome
    const batch = outcome.data
    return {
      ok: true,
      created: true,
      data: {
        supplier_payment_batch_id: batch.id,
        msg_id: batch.msg_id,
        format: 'pain001' as const,
        status: 'created' as const,
        currency: batch.currency,
        total_amount: batch.total_amount,
        item_count: batch.item_count,
        created_at: batch.created_at,
        file: { filename: supplierPaymentBatchFilename(batch), download: FILE_PATH },
      },
    }
  },
})

// ─────────────────────────────────────────────────────────────────
// list / get
// ─────────────────────────────────────────────────────────────────

export const supplierPaymentBatchesList = defineOperation({
  id: 'supplier-payment-batches.list',
  kind: 'read',
  scope: 'suppliers:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'List supplier payment batches (betalfiler), newest first, with settlement progress.',
    description:
      'Returns the company\'s payment batches, newest first, cursor-paginated: status, total, item count, how many member invoices are settled (derived from the live invoices), download count and the member supplier_invoice_ids. Pass next_cursor from the answer as cursor to get the next page; it is null on the last page.',
    useWhen: 'Checking which betalfiler exist, whether one has been downloaded, or which invoices are already in an active batch.',
    doNotUseFor: 'The lines of one batch (GET /supplier-payment-batches/{id}).',
    pitfalls: [
      'next_cursor rides in data (not meta): pass it back as ?cursor= until it is null.',
      'settled_count counts invoices with nothing left to pay, however they were settled; a created batch is not proof the bank executed it.',
    ],
    example: {
      response: { data: { supplier_payment_batches: [EXAMPLE_SUMMARY], next_cursor: null }, meta: META },
    },
  },
  input: z.object({
    status: z
      .enum(['created', 'cancelled', 'all'])
      .default('all')
      .describe('created (active), cancelled, or all (default).'),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .default(DEFAULT_LIMIT)
      .describe(`Page size, 1-${MAX_LIMIT} (default ${DEFAULT_LIMIT}).`),
    cursor: z.string().optional().describe('next_cursor from the previous page. Omit for the first page.'),
  }),
  output: z.object({
    supplier_payment_batches: z.array(BatchSummary),
    next_cursor: z.string().nullable(),
  }),
  http: { method: 'GET', path: '/api/v1/companies/:companyId/supplier-payment-batches' },
  mcp: {
    name: 'gnubok_list_supplier_payment_batches',
    title: 'List Supplier Payment Batches',
    description:
      'List betalfiler (supplier payment batches), newest first: status, total, settled count, download count and member supplier_invoice_ids. Paginate with cursor = next_cursor.',
    keywords: ['betalfiler', 'lista betalfiler', 'leverantörsbetalningar', 'betalningsfiler'],
  },
  run: async (ctx, input) => {
    const outcome = await listPaymentBatches(ctx, input)
    if (!outcome.ok || outcome.dryRun) return outcome
    const { batches, progress, nextCursor } = outcome.data
    return {
      ok: true,
      data: {
        supplier_payment_batches: batches.map((batch) =>
          toSummary(
            batch,
            progress.settledCounts.get(batch.id) ?? 0,
            progress.invoiceIdsByBatch.get(batch.id) ?? [],
          ),
        ),
        next_cursor: nextCursor,
      },
    }
  },
})

const BatchItemOut = z.object({
  supplier_payment_batch_item_id: z.string().uuid(),
  supplier_invoice_id: z.string().uuid(),
  supplier_invoice_number: z.string().nullable(),
  arrival_number: z.number().int().nullable(),
  amount: z.number(),
  payment_date: z.string(),
  payee_name: z.string(),
  payee: Payee,
  reference: Reference,
  invoice_status: z.string().nullable().describe('The invoice\'s status now (live), not at batch creation.'),
  remaining_amount: z.number().nullable().describe('What is left to pay on the invoice now (live).'),
  settled: z.boolean(),
})

export const supplierPaymentBatchesGet = defineOperation({
  id: 'supplier-payment-batches.get',
  kind: 'read',
  scope: 'suppliers:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Read one supplier payment batch (betalfil) with its lines and live settlement.',
    description:
      'Returns the batch, the company bank details it debits (as snapshotted at creation), and one line per invoice: amount, payment date, payee, reference, and the invoice\'s live status and remaining amount. file names the download filename and the v1 path that serves the XML (available only while the batch is not cancelled).',
    useWhen: 'Checking what a betalfil pays, or which of its invoices are settled.',
    doNotUseFor: 'Getting the XML itself: GET /supplier-payment-batches/{id}/file.',
    pitfalls: ['The payee and amount per line are the snapshot the file pays, even if the supplier\'s details changed since.'],
    example: {
      response: {
        data: {
          ...EXAMPLE_SUMMARY,
          debtor: { name: 'Testbolaget AB', iban: 'SE3550000000054910000003', bic: 'ESSESESS' },
          items: [
            {
              supplier_payment_batch_item_id: '71c4…',
              supplier_invoice_id: EXAMPLE_INVOICE_ID,
              supplier_invoice_number: 'CD3014794407',
              arrival_number: 12,
              amount: 7500,
              payment_date: '2026-10-01',
              payee_name: 'Derome Bygg AB',
              payee: { type: 'bankgiro', label: 'BG 5050-1055' },
              reference: { type: 'invoice_number', value: 'CD3014794407' },
              invoice_status: 'approved',
              remaining_amount: 7500,
              settled: false,
            },
          ],
          file: {
            filename: 'betalfil_20260925_5b0c1a2f.xml',
            content_type: 'application/xml',
            available: true,
            download: FILE_PATH,
          },
        },
        meta: META,
      },
    },
  },
  input: z.object({ supplier_payment_batch_id: BATCH_ID }),
  output: BatchSummary.extend({
    debtor: z.object({ name: z.string(), iban: z.string(), bic: z.string() }),
    items: z.array(BatchItemOut),
    file: z.object({
      filename: z.string(),
      content_type: z.literal('application/xml'),
      available: z.boolean().describe('false for a cancelled batch: its file is no longer served.'),
      download: z.string().describe('The v1 path that returns the file (GET, suppliers:write). Not served over MCP.'),
    }),
  }),
  errorCodes: ['SI_BATCH_NOT_FOUND'],
  http: {
    method: 'GET',
    path: '/api/v1/companies/:companyId/supplier-payment-batches/:id',
    pathParams: { id: 'supplier_payment_batch_id' },
  },
  mcp: {
    name: 'gnubok_get_supplier_payment_batch',
    title: 'Get Supplier Payment Batch',
    description:
      'Read one betalfil: its lines (amount, date, payee, reference), each invoice\'s live status, and the file name. The XML itself is not returned here: the user downloads it in Accounted or over the v1 file endpoint.',
    keywords: ['betalfil', 'visa betalfil', 'betalfilens rader', 'leverantörsbetalning'],
  },
  run: async (ctx, { supplier_payment_batch_id }) => {
    const outcome = await getPaymentBatch(ctx, supplier_payment_batch_id)
    if (!outcome.ok || outcome.dryRun) return outcome
    const { batch, items } = outcome.data
    const outItems = items.map((item) => {
      const remaining = item.invoice?.remaining_amount ?? null
      return {
        supplier_payment_batch_item_id: item.id,
        supplier_invoice_id: item.supplier_invoice_id,
        supplier_invoice_number: item.invoice?.supplier_invoice_number ?? null,
        arrival_number: item.invoice?.arrival_number ?? null,
        amount: item.amount,
        payment_date: item.payment_date,
        payee_name: item.payee_name,
        payee: { type: item.payee_type, label: formatPayeeLabel(payeeOf(item)) },
        reference: { type: item.reference_type, value: item.reference },
        invoice_status: item.invoice?.status ?? null,
        remaining_amount: remaining,
        settled: remaining !== null && remaining <= ORE_TOLERANCE,
      }
    })
    const settledCount = outItems.filter((item) => item.settled).length
    return {
      ok: true,
      data: {
        ...toSummary(batch, settledCount, items.map((item) => item.supplier_invoice_id)),
        debtor: {
          name: batch.debtor_snapshot?.name ?? '',
          iban: batch.debtor_snapshot?.iban ?? '',
          bic: batch.debtor_snapshot?.bic ?? '',
        },
        items: outItems,
        file: {
          filename: supplierPaymentBatchFilename(batch),
          content_type: 'application/xml' as const,
          available: batch.status !== 'cancelled',
          download: FILE_PATH,
        },
      },
    }
  },
})

// ─────────────────────────────────────────────────────────────────
// file
// ─────────────────────────────────────────────────────────────────

export const supplierPaymentBatchesFile = defineOperation({
  id: 'supplier-payment-batches.file',
  kind: 'read',
  // A write scope on a GET, deliberately: the download stamps the batch
  // (file_generated_at, download_count) as the dashboard's does, and the
  // file is the payment instruction itself, so a read-only key does not
  // get it (the dashboard route is requireWrite for the same reasons).
  scope: 'suppliers:write',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Download the pain.001 payment file of a supplier payment batch.',
    description:
      'Returns the batch\'s XML payment file inline as `content` (a UTF-8 string), with filename, content_type and sha256, in the same shape as the salary payment file. The file regenerates from the stored batch, so every download is byte-identical (same MsgId) and the bank\'s duplicate detection works. Each call records the download on the batch (file_generated_at, download_count). Upload the file in the bank\'s file channel, where the payments are signed; nothing is sent to the bank by this call and nothing is booked.',
    useWhen: 'The batch is created and the user (or their payment operator) needs the file to upload in the bank.',
    doNotUseFor: 'Creating the batch (POST /supplier-payment-batches) or marking invoices paid (mark-paid after the bank executed).',
    pitfalls: [
      'Write `content` to `filename` as UTF-8, exactly as returned; do not re-indent or re-encode the XML.',
      'A cancelled batch answers 409 SI_BATCH_CANCELLED: its file is never served again.',
      'Uploading the same file twice is caught by most banks through the MsgId, but not all: check download_count and the bank before re-uploading.',
      'Needs suppliers:write although it is a GET: the file is a payment instruction and the download is recorded.',
    ],
    example: {
      response: {
        data: {
          supplier_payment_batch_id: EXAMPLE_BATCH_ID,
          format: 'pain001',
          filename: 'betalfil_20260925_5b0c1a2f.xml',
          content_type: 'application/xml',
          content: '<?xml version="1.0" encoding="UTF-8"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03">…',
          sha256: '3f9a…',
          msg_id: 'ACCOUNTED-5566778899-B5B0C1A2F',
          item_count: 2,
          total_amount: 12500,
          currency: 'SEK',
          download_count: 1,
        },
        meta: META,
      },
    },
  },
  input: z.object({ supplier_payment_batch_id: BATCH_ID }),
  output: z.object({
    supplier_payment_batch_id: z.string().uuid(),
    format: z.literal('pain001'),
    filename: z.string(),
    content_type: z.literal('application/xml'),
    content: z.string(),
    sha256: z.string().describe('Lowercase hex SHA-256 over the UTF-8 file bytes.'),
    msg_id: z.string(),
    item_count: z.number().int(),
    total_amount: z.number(),
    currency: z.string(),
    download_count: z.number().int().describe('Downloads including this one.'),
  }),
  errorCodes: ['SI_BATCH_NOT_FOUND', 'SI_BATCH_CANCELLED'],
  http: {
    method: 'GET',
    path: '/api/v1/companies/:companyId/supplier-payment-batches/:id/file',
    pathParams: { id: 'supplier_payment_batch_id' },
  },
  run: async (ctx, { supplier_payment_batch_id }) => {
    const outcome = await downloadPaymentBatchFile(ctx, supplier_payment_batch_id)
    if (!outcome.ok || outcome.dryRun) return outcome
    const file = outcome.data
    return {
      ok: true,
      data: {
        supplier_payment_batch_id: file.batch.id,
        format: 'pain001' as const,
        filename: file.filename,
        content_type: 'application/xml' as const,
        content: file.content,
        sha256: file.sha256,
        msg_id: file.batch.msg_id,
        item_count: file.batch.item_count,
        total_amount: file.batch.total_amount,
        currency: file.batch.currency,
        download_count: file.downloadCount,
      },
    }
  },
})

// ─────────────────────────────────────────────────────────────────
// cancel
// ─────────────────────────────────────────────────────────────────

export const supplierPaymentBatchesCancel = defineOperation({
  id: 'supplier-payment-batches.cancel',
  kind: 'write',
  scope: 'suppliers:write',
  risk: 'medium',
  reversible: false,
  docs: {
    summary: 'Cancel (makulera) a supplier payment batch.',
    description:
      'Marks an active batch cancelled: Accounted stops serving its file and its invoices can go into a new batch. The batch and its lines are kept (they are underlag for the payment instruction). A file already uploaded to the bank is NOT recalled: stop those payments in the bank. Cannot be undone; create a new batch instead. Idempotent. Dry-runnable.',
    useWhen: 'A betalfil was created by mistake or with wrong amounts, before (or instead of) uploading it.',
    doNotUseFor: 'Stopping a payment the bank already has (do that in the bank) or un-paying an invoice.',
    pitfalls: [
      'An already cancelled batch answers 409 SI_BATCH_ALREADY_CANCELLED.',
      'download_count above 0 means the file may already be at the bank: check there too.',
    ],
    example: {
      response: {
        data: { supplier_payment_batch_id: EXAMPLE_BATCH_ID, status: 'cancelled', cancelled_at: '2026-09-25T10:00:00Z' },
        meta: META,
      },
    },
  },
  input: z.object({ supplier_payment_batch_id: BATCH_ID }),
  output: z.object({
    supplier_payment_batch_id: z.string().uuid(),
    status: z.literal('cancelled'),
    cancelled_at: z.string().nullable(),
  }),
  errorCodes: ['SI_BATCH_NOT_FOUND', 'SI_BATCH_ALREADY_CANCELLED'],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/supplier-payment-batches/:id/cancel',
    pathParams: { id: 'supplier_payment_batch_id' },
  },
  mcp: {
    name: 'gnubok_cancel_supplier_payment_batch',
    title: 'Cancel Supplier Payment Batch',
    description:
      'Stage cancelling a betalfil: Accounted stops serving its file and frees its invoices for a new batch. A file already uploaded to the bank is not recalled; stop it in the bank too. Cannot be undone.',
    keywords: ['makulera betalfil', 'avbryt betalfil', 'ta bort betalfil', 'stoppa betalning'],
    stage: { pendingType: 'cancel_supplier_payment_batch', title: () => 'Makulera betalfil' },
  },
  run: async (ctx, { supplier_payment_batch_id }, { dryRun }) => {
    const outcome = await cancelPaymentBatch(ctx, supplier_payment_batch_id, { dryRun })
    if (!outcome.ok || outcome.dryRun) return outcome
    return {
      ok: true,
      data: {
        supplier_payment_batch_id: outcome.data.id,
        status: 'cancelled' as const,
        cancelled_at: outcome.data.cancelled_at,
      },
    }
  },
})
