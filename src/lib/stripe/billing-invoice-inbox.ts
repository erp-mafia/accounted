/**
 * Accounted's own subscription invoice, filed into the paying company's
 * Inkorg as the underlag of the card payment (PH 191).
 *
 * The underlag already exists: Stripe renders every finalized invoice as a
 * PDF. The company's bank row for the charge arrives through the bank feed
 * days later, and match on arrival (lib/operations/inbox-bank-match.ts)
 * pairs an open inbox item with the bank row that paid it, both when the
 * item arrives and again when the row does. So the delivery is only: fetch
 * Stripe's PDF, archive it, file one inbox item carrying the invoice's own
 * numbers, and ask the bank. Never a verifikat: the company books it from the
 * Inkorg like any receipt.
 *
 * - One item per Stripe invoice: a redelivered event finds the item it filed
 *   (channel_context.stripe_invoice_id) and stops.
 * - Never a second copy: a company that already brings our invoices in
 *   itself gets nothing from this door. About half the paying companies
 *   forward Stripe's receipt mail to their inbox address or upload the PDF,
 *   and Stripe renders the PDF anew on every download, so no content dedupe
 *   can tell the copies apart; the invoice number can (companyBringsOwn).
 * - Only a charged invoice with money paid: a trial's 0 kr invoice pays
 *   nothing, and a send_invoice invoice reached the company by mail before it
 *   was paid, so the company may already hold it.
 * - The door is `system` (what Accounted produced); the inbox source column
 *   is 'upload', as for every door without a value of its own.
 * - The numbers are Stripe's, not a model's reading: no AI pass runs.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type Stripe from 'stripe'
import { getBranding } from '@/lib/branding/service'
import { uploadDocument } from '@/lib/core/documents/document-service'
import { todayIsoStockholm, addDaysIso } from '@/lib/dates/iso'
import { recordDocumentArrival } from '@/lib/intake/arrivals'
import { inboxSourceForIntake } from '@/lib/intake/sources'
import { createLogger, type Logger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import { proposeBankMatchForInboxItem } from '@/lib/operations/inbox-bank-match'
import { matchSupplierId } from '@/lib/suppliers/match-supplier'
import type {
  ExtractedInvoiceLineItem,
  InboxChannelContext,
  InvoiceExtractionResult,
  VatBreakdownItem,
} from '@/types'

const defaultLog = createLogger('stripe/billing-invoice-inbox')

/** Why an invoice is not filed. */
export type BillingInvoiceSkip =
  | 'not_paid'
  | 'nothing_paid'
  | 'not_charged_automatically'
  | 'company_unavailable'
  | 'no_owner'
  | 'already_filed'
  | 'company_brings_own'

const PDF_FETCH_TIMEOUT_MS = 10_000
/** How far back a copy the company brought in itself counts: a yearly plan's previous invoice included. */
const OWN_COPY_LOOKBACK_DAYS = 400
const MAX_PDF_BYTES = 10 * 1024 * 1024

/** What the event alone says: whether this invoice is one the company should receive. */
export function billingInvoiceSkipReason(invoice: Stripe.Invoice): BillingInvoiceSkip | null {
  if (invoice.status !== 'paid') return 'not_paid'
  if (!(invoice.amount_paid > 0)) return 'nothing_paid'
  if (invoice.collection_method !== 'charge_automatically') return 'not_charged_automatically'
  return null
}

/** The subscription a subscription invoice belongs to (API 2025-03-31 and later: invoice.parent). */
export function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const sub = invoice.parent?.subscription_details?.subscription
  if (!sub) return null
  return typeof sub === 'string' ? sub : sub.id
}

/** The company the subscription's metadata names at the time of the invoice. */
export function invoiceMetadataCompanyId(invoice: Stripe.Invoice): string | null {
  return invoice.parent?.subscription_details?.metadata?.company_id ?? null
}

export function invoiceCustomerId(invoice: Stripe.Invoice): string | null {
  const customer = invoice.customer
  if (!customer) return null
  return typeof customer === 'string' ? customer : customer.id
}

/** The seller's VAT number, from the invoice's expanded account_tax_ids. */
function sellerVatNumber(invoice: Stripe.Invoice): string | null {
  for (const taxId of invoice.account_tax_ids ?? []) {
    if (typeof taxId === 'string' || 'deleted' in taxId) continue
    if (taxId.type === 'eu_vat' && taxId.value) return taxId.value.toUpperCase().replace(/\s+/g, '')
  }
  return null
}

/**
 * A Swedish momsregistreringsnummer is SE, the ten digits of the
 * organisationsnummer and 01 (ML 17 kap. 24 § p. 3). Null for any other.
 */
export function orgNumberFromSwedishVat(vatNumber: string | null): string | null {
  const match = vatNumber?.match(/^SE(\d{10})01$/)
  return match ? `${match[1].slice(0, 6)}-${match[1].slice(6)}` : null
}

/**
 * The seller as the inbox names it: the brand the card statement prints
 * (Stripe's statement descriptor is the app name), then the legal name on the
 * invoice. Match on arrival pairs a receipt with a bank row only when the row
 * names the seller, and the row says "ACCOUNTED", not the legal name.
 */
export function billingSellerName(accountName: string | null, brand: string): string {
  const legal = accountName?.trim() || null
  if (!legal) return brand
  return legal.toLowerCase().includes(brand.toLowerCase()) ? legal : `${brand} (${legal})`
}

function kronor(minor: number): number {
  // The billing account charges SEK, a two-decimal currency: öre to kronor.
  return roundOre(minor / 100)
}

function stockholmDate(unix: number | null | undefined): string | null {
  return unix ? todayIsoStockholm(new Date(unix * 1000)) : null
}

/** Ex-VAT base and VAT of a line, in minor units: the taxes' own base when Stripe states it. */
function lineAmounts(line: Stripe.InvoiceLineItem): { base: number; tax: number } {
  const taxes = line.taxes ?? []
  const tax = taxes.reduce((sum, t) => sum + t.amount, 0)
  const statedBase = taxes.length > 0 && taxes.every((t) => t.taxable_amount !== null)
  const base = statedBase ? taxes.reduce((sum, t) => sum + (t.taxable_amount ?? 0), 0) : line.amount
  return { base, tax }
}

function ratePercent(tax: number, base: number): number | null {
  return base !== 0 ? Math.round((tax / base) * 100) : null
}

/**
 * The paid invoice in the inbox's extraction shape, read off Stripe's own
 * fields. A receipt: it was charged the moment it was issued, so it is booked
 * against the bank row that paid it, never as a payable.
 */
export function billingInvoiceToExtraction(
  invoice: Stripe.Invoice,
  seller: { name: string; vatNumber: string | null },
): InvoiceExtractionResult {
  const lines = (invoice.lines?.data ?? [])
    .map((line) => ({ line, ...lineAmounts(line) }))
    .filter(({ base, tax }) => base !== 0 || tax !== 0)

  const lineItems: ExtractedInvoiceLineItem[] = lines.map(({ line, base, tax }) => {
    const quantity = line.quantity ?? 1
    return {
      description: line.description ?? '',
      quantity,
      unitPrice: quantity ? kronor(base / quantity) : null,
      lineTotal: kronor(base),
      vatRate: ratePercent(tax, base),
      accountSuggestion: null,
    }
  })

  const byRate = new Map<number, { base: number; amount: number }>()
  for (const t of invoice.total_taxes ?? []) {
    if (!t.taxable_amount) continue
    const rate = ratePercent(t.amount, t.taxable_amount) as number
    const sum = byRate.get(rate) ?? { base: 0, amount: 0 }
    byRate.set(rate, { base: sum.base + t.taxable_amount, amount: sum.amount + t.amount })
  }
  const vatBreakdown: VatBreakdownItem[] = [...byRate.entries()].map(([rate, sum]) => ({
    rate,
    base: kronor(sum.base),
    amount: kronor(sum.amount),
  }))

  // The coverage the subscription lines charge for: Stripe's period end is
  // the instant the next period starts, so the last covered day is the one before.
  const starts = lines.map(({ line }) => line.period?.start).filter((v): v is number => !!v)
  const ends = lines.map(({ line }) => line.period?.end).filter((v): v is number => !!v)
  const periodStart = starts.length ? stockholmDate(Math.min(...starts)) : null
  const periodEndExclusive = ends.length ? stockholmDate(Math.max(...ends)) : null
  const periodEnd = periodEndExclusive ? addDaysIso(periodEndExclusive, -1) : null
  const coversDays = periodStart && periodEnd && periodEnd >= periodStart

  const vatAmount = invoice.total_taxes ? kronor(invoice.total_taxes.reduce((sum, t) => sum + t.amount, 0)) : null
  const subtotal = invoice.total_excluding_tax ?? invoice.subtotal_excluding_tax

  return {
    documentKind: 'receipt',
    legibility: 'good',
    supplier: {
      name: seller.name,
      orgNumber: orgNumberFromSwedishVat(seller.vatNumber),
      vatNumber: seller.vatNumber,
      address: null,
      bankgiro: null,
      plusgiro: null,
    },
    invoice: {
      invoiceNumber: invoice.number ?? null,
      invoiceDate: stockholmDate(invoice.effective_at ?? invoice.status_transitions?.finalized_at ?? invoice.created),
      dueDate: null,
      paymentReference: null,
      currency: (invoice.currency ?? 'sek').toUpperCase(),
      ...(coversDays ? { servicePeriodStart: periodStart, servicePeriodEnd: periodEnd } : {}),
    },
    lineItems,
    totals: {
      subtotal: subtotal !== null && subtotal !== undefined ? kronor(subtotal) : null,
      vatAmount,
      total: kronor(invoice.total),
    },
    vatBreakdown,
    // Stripe's numbers, not a model's reading.
    confidence: 1,
  }
}

/**
 * Downloads Stripe's rendering of the invoice. Throws on any failure. The URL
 * is Stripe's own answer (invoice_pdf) and must be on stripe.com; Stripe
 * answers it with a redirect to a presigned link in its file store (an S3
 * bucket, served as application/octet-stream), which is followed. The
 * archive checks the bytes are a PDF.
 */
export async function fetchStripeInvoicePdf(rawUrl: string): Promise<ArrayBuffer> {
  const url = new URL(rawUrl)
  if (url.protocol !== 'https:' || !(url.hostname === 'stripe.com' || url.hostname.endsWith('.stripe.com'))) {
    throw new Error('invoice PDF is not on stripe.com')
  }
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(PDF_FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`invoice PDF fetch failed with status ${res.status}`)
  const buffer = await res.arrayBuffer()
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_PDF_BYTES) {
    throw new Error(`invoice PDF has an unexpected size (${buffer.byteLength} bytes)`)
  }
  return buffer
}

/**
 * The invoice number's series: Stripe numbers an account's invoices
 * PREFIX-NNNN, and a receipt PDF prints the invoice's number too. Null for a
 * number without one.
 */
export function invoiceNumberSeries(number: string | null): string | null {
  const match = number?.match(/^(.+)-\d+$/)
  return match ? match[1] : null
}

/**
 * Whether the company already brings our invoices into its Inkorg through a
 * door of its own (a forwarded receipt mail, an upload, WhatsApp, an agent):
 * an item, not filed by this door, whose read invoice number is in this
 * invoice's series (this very invoice included), within the lookback. Such a
 * company keeps its own flow, and filing ours too would put every invoice in
 * its Inkorg twice. A company that stops bringing them in starts receiving
 * ours once its last copy is older than the lookback.
 */
async function companyBringsOwn(
  supabase: SupabaseClient,
  companyId: string,
  invoice: Stripe.Invoice,
  now: Date,
): Promise<boolean> {
  if (!invoice.number) return false
  const literal = (value: string) => value.replace(/[\\%_]/g, '\\$&')
  const series = invoiceNumberSeries(invoice.number)
  const pattern = series ? `${literal(series)}-%` : literal(invoice.number)
  const since = new Date(now.getTime() - OWN_COPY_LOOKBACK_DAYS * 86_400_000).toISOString()
  const { data, error } = await supabase
    .from('invoice_inbox_items')
    .select('id')
    .eq('company_id', companyId)
    .ilike('extracted_data->invoice->>invoiceNumber', pattern)
    .is('channel_context->>stripe_invoice_id', null)
    .gte('created_at', since)
    .limit(1)
  if (error) throw new Error(`inbox lookup failed: ${error.message}`)
  return ((data ?? []) as unknown[]).length > 0
}

function safeFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
}

export interface BillingInvoiceDeliveryDeps {
  fetchPdf?: (url: string) => Promise<ArrayBuffer>
  log?: Pick<Logger, 'info' | 'warn'>
  now?: Date
}

/**
 * File one paid subscription invoice into the paying company's Inkorg.
 * Returns the item (an earlier one on a redelivery) or why none was filed.
 * Throws on a failed read, Stripe call, download or write, so the webhook
 * answers 500 and Stripe delivers the event again.
 */
export async function deliverBillingInvoiceToInbox(
  supabase: SupabaseClient,
  stripe: Stripe,
  args: { invoice: Stripe.Invoice; companyId: string },
  deps: BillingInvoiceDeliveryDeps = {},
): Promise<{ inboxItemId: string | null; skipped?: BillingInvoiceSkip }> {
  const { companyId } = args
  const log = deps.log ?? defaultLog
  const early = billingInvoiceSkipReason(args.invoice)
  if (early) return { inboxItemId: null, skipped: early }

  const { data: company, error: companyError } = await supabase
    .from('companies')
    .select('id, archived_at')
    .eq('id', companyId)
    .maybeSingle()
  if (companyError) throw new Error(`company lookup failed: ${companyError.message}`)
  if (!company || (company as { archived_at: string | null }).archived_at) {
    return { inboxItemId: null, skipped: 'company_unavailable' }
  }

  const { data: existing, error: existingError } = await supabase
    .from('invoice_inbox_items')
    .select('id')
    .eq('company_id', companyId)
    .eq('channel_context->>stripe_invoice_id', args.invoice.id)
    .limit(1)
    .maybeSingle()
  if (existingError) throw new Error(`inbox lookup failed: ${existingError.message}`)
  if (existing) return { inboxItemId: (existing as { id: string }).id, skipped: 'already_filed' }
  if (await companyBringsOwn(supabase, companyId, args.invoice, deps.now ?? new Date())) {
    return { inboxItemId: null, skipped: 'company_brings_own' }
  }

  // The item belongs to a person: the company's first owner.
  const { data: owner, error: ownerError } = await supabase
    .from('company_members')
    .select('user_id')
    .eq('company_id', companyId)
    .eq('role', 'owner')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (ownerError) throw new Error(`owner lookup failed: ${ownerError.message}`)
  const ownerId = (owner as { user_id: string } | null)?.user_id
  if (!ownerId) {
    log.warn('billing invoice not filed: the company has no owner', { companyId })
    return { inboxItemId: null, skipped: 'no_owner' }
  }

  // The event's invoice carries the seller's tax ids as ids only.
  const invoice = await stripe.invoices.retrieve(args.invoice.id, { expand: ['account_tax_ids'] })
  const late = billingInvoiceSkipReason(invoice)
  if (late) return { inboxItemId: null, skipped: late }
  if (!invoice.invoice_pdf) throw new Error('paid invoice has no PDF')

  const brand = getBranding().appName
  const seller = { name: billingSellerName(invoice.account_name, brand), vatNumber: sellerVatNumber(invoice) }
  const pdf = await (deps.fetchPdf ?? fetchStripeInvoicePdf)(invoice.invoice_pdf)
  const fileName = `${safeFilePart(brand.toLowerCase()) || 'faktura'}-faktura-${safeFilePart(invoice.number ?? invoice.id)}.pdf`
  const document = await uploadDocument(
    supabase,
    ownerId,
    companyId,
    { name: fileName, buffer: pdf, type: 'application/pdf' },
    { upload_source: 'system', dedupeByContent: true, extractionOwner: 'none' },
  )

  const extracted = billingInvoiceToExtraction(invoice, seller)
  const matchedSupplierId = await matchSupplierId(supabase, companyId, {
    orgNumber: extracted.supplier.orgNumber,
    vatNumber: extracted.supplier.vatNumber,
    name: invoice.account_name ?? seller.name,
  })
  const paidAt = invoice.status_transitions?.paid_at
  const receivedAt = paidAt ? new Date(paidAt * 1000).toISOString() : new Date().toISOString()
  const channelContext: InboxChannelContext = {
    intake_source: 'system',
    stripe_invoice_id: invoice.id,
    stripe_invoice_number: invoice.number ?? null,
  }

  const { data: item, error: insertError } = await supabase
    .from('invoice_inbox_items')
    .insert({
      company_id: companyId,
      user_id: ownerId,
      document_id: document.id,
      source: inboxSourceForIntake('system'),
      status: 'received',
      extracted_data: extracted,
      extraction_skipped: false,
      matched_supplier_id: matchedSupplierId,
      email_from: seller.name,
      email_received_at: receivedAt,
      channel_context: channelContext,
    })
    .select('id')
    .single()
  if (insertError) throw new Error(`inbox item insert failed: ${insertError.message}`)
  const inboxItemId = (item as { id: string }).id

  // Best effort, never throws: the item stands without its arrival.
  await recordDocumentArrival(supabase, {
    companyId,
    source: 'system',
    documentId: document.id,
    inboxItemId,
    sourceRef: invoice.id,
    fetchedBy: { type: 'webhook', label: 'stripe-billing' },
    sender: { name: seller.name, org_number: extracted.supplier.orgNumber, vat_number: seller.vatNumber },
    sourceMeta: { stripe_invoice_id: invoice.id, invoice_number: invoice.number ?? null },
    receivedAt,
  })
  // The card payment may already be in the bank; usually it arrives later
  // and the bank-arrival pass proposes the pair then. Never throws.
  await proposeBankMatchForInboxItem(supabase, companyId, inboxItemId)

  log.info('billing invoice filed into the inbox', { companyId, inboxItemId, entityId: invoice.id })
  return { inboxItemId }
}
