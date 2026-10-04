import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { CreateInvoiceItemSchema, CurrencySchema, InvoiceQrModeSchema } from '@/lib/api/schemas'
import { coerceDimensionsBag } from '@/lib/bookkeeping/dimension-resolver'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { isoDateSchema } from '@/lib/invariants/zod'
import {
  buildInvoiceWriteData,
  type BuildInvoiceWriteResult,
  type InvoiceBuilderCustomer,
  type InvoiceWriteInput,
  type InvoiceWriteItemInput,
} from '@/lib/invoices/build-invoice-write'

/**
 * The one build of a staged create_invoice.
 *
 * gnubok_create_invoice stages these params and commitCreateInvoice writes
 * them. Both run buildStagedInvoice on the same params, so the approval
 * preview and the stored invoice come out of one computation: the shared
 * buildInvoiceWriteData every other invoice door uses (web, v1, webshop,
 * sales orders, MCP update_invoice). At staging it is a dry run: the builder
 * only reads.
 *
 * Both sides used to re-implement a subset of the builder, so every rule added
 * to it later never reached this door: a class 1-2 posting account on a
 * VAT-bearing line (the base missing from ruta 05), ROT/RUT and accrual line
 * fields dropped at commit, no vat_registered check in the preview, and the
 * reverse-charge notice copied without the line check.
 *
 * Validated here as well as at staging: a hand-crafted pending_operations row
 * must not reach the write (same rule as UpdateInvoiceParamsSchema).
 */
export const CreateInvoiceParamsSchema = z
  .object({
    customer_id: z.string().min(1),
    document_type: z.enum(['invoice', 'quote']).optional(),
    valid_until: isoDateSchema.optional(),
    // The web API's line schema, so accrual, ROT/RUT and posting-account
    // shapes cannot drift between the surfaces.
    items: z.array(CreateInvoiceItemSchema).min(1, 'At least one item is required'),
    // Coerced, never refused: a bag that no longer parses is dropped (drift gate).
    default_dimensions: z.unknown().optional(),
    invoice_date: isoDateSchema,
    due_date: isoDateSchema,
    currency: CurrencySchema.default('SEK'),
    our_reference: z.string().nullable().optional(),
    your_reference: z.string().nullable().optional(),
    invoice_marking: z.string().max(200).nullable().optional(),
    notes: z.string().nullable().optional(),
    payment_link_url: z.string().nullable().optional(),
    payment_cash_account_id: z.string().nullable().optional(),
    // Validated at staging; a hand-crafted unknown mode inherits the
    // company's invoice_qr_mode instead of failing the CHECK with a 500.
    qr_mode: InvoiceQrModeSchema.nullable().optional().catch(null),
  })
  .superRefine((params, ctx) => {
    if (params.document_type === 'quote' && !params.valid_until) {
      ctx.addIssue({
        code: 'custom',
        path: ['valid_until'],
        message: 'Giltig till (valid_until) krävs för en offert.',
      })
    }
  })

export type CreateInvoiceParams = z.infer<typeof CreateInvoiceParamsSchema>

export type StagedInvoiceBuild =
  | {
      ok: true
      params: CreateInvoiceParams
      isQuote: boolean
      build: Extract<BuildInvoiceWriteResult, { ok: true }>
    }
  | { ok: false; validation: z.ZodError }
  | Exclude<BuildInvoiceWriteResult, { ok: true }>

export async function buildStagedInvoice(args: {
  supabase: SupabaseClient
  companyId: string
  customer: InvoiceBuilderCustomer
  params: Record<string, unknown>
}): Promise<StagedInvoiceBuild> {
  const { supabase, companyId, customer, params } = args

  // Dimension bags were resolved against the registry at staging time; a bag
  // that no longer parses is dropped rather than refused (coerce is the
  // drift/tamper gate, as for every other staged bag).
  const rawItems = Array.isArray(params.items)
    ? params.items.map((item) =>
        item && typeof item === 'object'
          ? { ...(item as Record<string, unknown>), dimensions: coerceDimensionsBag((item as Record<string, unknown>).dimensions) }
          : item,
      )
    : params.items
  const parsed = CreateInvoiceParamsSchema.safeParse({ ...params, items: rawItems })
  if (!parsed.success) return { ok: false, validation: parsed.error }
  const staged = parsed.data
  const isQuote = staged.document_type === 'quote'

  // Copies: the builder zeroes vat_rate in place for a company that is not
  // VAT-registered, and the staged params must stay what the agent sent.
  const items: InvoiceWriteItemInput[] = staged.items.map((item) => ({ ...item }))

  // The MCP surface carries the ROT/RUT property info per line, the builder
  // reads it per invoice: derive it from the first deduction line, exactly
  // like commitUpdateInvoice (per-line values still win in the item mapping).
  // The personnummer is never on this surface: the builder falls back to the
  // one on an individual's customer card.
  const firstDeduction = items.find((item) => item.line_type !== 'text' && item.deduction_type)

  const input: InvoiceWriteInput = {
    customer_id: staged.customer_id,
    invoice_date: staged.invoice_date,
    due_date: staged.due_date,
    valid_until: isQuote ? staged.valid_until : null,
    currency: staged.currency,
    your_reference: staged.your_reference ?? undefined,
    our_reference: staged.our_reference ?? undefined,
    invoice_marking: staged.invoice_marking ?? undefined,
    notes: staged.notes ?? undefined,
    payment_link_url: httpsLinkOrUndefined(staged.payment_link_url),
    qr_mode: staged.qr_mode,
    deduction_housing_designation: firstDeduction?.housing_designation ?? undefined,
    deduction_apartment_number: firstDeduction?.apartment_number ?? undefined,
    deduction_brf_org_number: firstDeduction?.brf_org_number ?? undefined,
    default_dimensions: coerceDimensionsBag(staged.default_dimensions) ?? {},
    items,
  }

  const build = await buildInvoiceWriteData({
    supabase,
    companyId,
    customer,
    documentType: isQuote ? 'quote' : 'invoice',
    input,
  })
  if (!build.ok) return build
  return { ok: true, params: staged, isQuote, build }
}

/**
 * Validated https-only at staging (gnubok_create_invoice); re-checked here so
 * a hand-crafted pending-operation row cannot smuggle a non-https link into
 * customer-facing emails and PDFs. Invalid is dropped, never blocks.
 */
function httpsLinkOrUndefined(raw: string | null | undefined): string | undefined {
  const link = raw?.trim()
  if (!link || link.length > 2048) return undefined
  try {
    return new URL(link).protocol === 'https:' ? link : undefined
  } catch {
    return undefined
  }
}

/**
 * English text for a builder refusal on the MCP surface, naming what the
 * registry sentence cannot (which rate, which account). message_sv comes from
 * the registry through the error code.
 */
export function describeInvoiceBuildRefusal(code: string, details?: Record<string, unknown>): string {
  if (code === 'INVOICE_CREATE_VAT_RULE_VIOLATION' && details) {
    const allowed = Array.isArray(details.allowedRates) ? details.allowedRates : []
    return (
      `VAT rate ${String(details.attemptedRate)}% is not allowed for customer type "${String(details.customerType)}". ` +
      `Allowed rates: ${allowed.map((rate) => `${String(rate)}%`).join(', ')}`
    )
  }
  if (code === 'INVOICE_CREATE_POSTING_ACCOUNT_VAT_CONFLICT' && details) {
    return (
      `revenue_account ${String(details.account)} is a balance-sheet account (class 1-2) and cannot take a ` +
      `${String(details.vatRate)}% VAT line: the sale would be missing from ruta 05. ` +
      'Use a 3xxx revenue account, or vat_rate 0 for a refundable deposit or an outlay (utlägg).'
    )
  }
  const entry = getErrorEntry(code)
  const errors = Array.isArray(details?.errors) ? details.errors.map(String) : []
  const rest = details && errors.length === 0 ? ` Details: ${JSON.stringify(details)}` : ''
  // The personnummer has no field on this surface (it never crosses MCP in
  // plaintext): say where it comes from, or the agent invents a key for it.
  const hint =
    code === 'INVOICE_CREATE_ROT_RUT_VALIDATION'
      ? 'The personnummer cannot be passed through MCP: it is read from the customer card of an individual customer, so add it there first.'
      : undefined
  return [`${code}.`, entry?.message_en, ...errors, hint].filter(Boolean).join(' ') + rest
}
