import type { SupabaseClient } from '@supabase/supabase-js'
import type { CollectionsFeatures } from '@accounted/connect-contract'
import { revealStoredCustomerPersonalNumber } from '@/lib/customers/protect-personal-number'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { createLogger, type Logger } from '@/lib/logger'
import { runBankCheck, type BankCheckResult } from './bank-check'
import { loadOpenCaseForInvoice, type CollectionCaseRow } from './case'
import type { CollectionConnectionRow } from './connection'
import {
  evaluateEligibility,
  type DeliveryEvidence,
  type Eligibility,
  type EligibilityCustomer,
  type EligibilityInvoice,
} from './eligibility'
import { normalizeDebtorPersonalNumber, type DebtorPersonalNumber } from './personal-number'

const defaultLog = createLogger('collections/readiness')

/**
 * Everything a handover of one invoice is decided on, loaded once: the
 * invoice and its customer, the company's rounding, the open case, credit
 * notes, the delivery history, the customer's answers to our reminders,
 * whether the invoice came from another system, and the bank check. The
 * dialog's GET and the commit both read it, so the commit re-checks exactly
 * what the dialog showed.
 *
 * Reads with the service role and an explicit company filter: the callers
 * (session routes, the staged-operation commit, the batch) have already
 * established that the actor is a non-viewer member of the company.
 */

export interface HandoverInvoice extends EligibilityInvoice {
  company_id: string
  customer_id: string | null
  paid_amount: number | null
  paid_at: string | null
  payment_cash_account_id: string | null
  your_reference: string | null
}

export interface HandoverCustomer extends EligibilityCustomer {
  vat_number: string | null
  customer_number: string | null
  email: string | null
  phone: string | null
  address_line2: string | null
}

export interface HandoverContext {
  invoice: HandoverInvoice
  customer: HandoverCustomer | null
  openCase: CollectionCaseRow | null
  eligibility: Eligibility
  bankCheck: BankCheckResult
  /** invoice_payments rows on the invoice: the payments the provider is told about. */
  payments: Array<{ id: string; payment_date: string; amount: number }>
  today: string
}

export class HandoverNotFoundError extends Error {
  constructor(message = 'Invoice not found') {
    super(message)
    this.name = 'HandoverNotFoundError'
  }
}

const num = (v: unknown): number => Number(v ?? 0)

/** A case the provider closed as paid (the latest registered one decides). */
export function isClosedPaid(row: { stage: string; is_open: boolean } | undefined): boolean {
  return !!row && !row.is_open && row.stage === 'closed_paid'
}

export async function loadHandoverInvoice(
  db: Pick<SupabaseClient, 'from'>,
  companyId: string,
  invoiceId: string,
): Promise<{ invoice: HandoverInvoice; customerRow: Record<string, unknown> | null }> {
  const { data, error } = await db
    .from('invoices')
    // One literal string, so the schema guard checks every column.
    .select(
      'id, company_id, customer_id, status, document_type, credited_invoice_id, is_self_billed, currency, invoice_number, invoice_date, due_date, total, vat_amount, paid_amount, paid_at, remaining_amount, deduction_total, deduction_reclaimed_total, ore_rounding, payment_cash_account_id, your_reference, customer:customers(id, name, customer_type, country, address_line1, address_line2, postal_code, city, org_number, vat_number, customer_number, email, phone, personal_number, collections_excluded)',
    )
    .eq('company_id', companyId)
    .eq('id', invoiceId)
    .maybeSingle()
  if (error) throw new Error(`invoice lookup failed: ${error.message}`)
  if (!data) throw new HandoverNotFoundError()
  const raw = data as unknown as Record<string, unknown> & { customer: Record<string, unknown> | Record<string, unknown>[] | null }
  const customerRow = Array.isArray(raw.customer) ? (raw.customer[0] ?? null) : raw.customer
  const invoice: HandoverInvoice = {
    ...(raw as unknown as HandoverInvoice),
    total: num(raw.total),
    vat_amount: num(raw.vat_amount),
    paid_amount: raw.paid_amount === null || raw.paid_amount === undefined ? null : num(raw.paid_amount),
    remaining_amount: num(raw.remaining_amount),
    deduction_total: raw.deduction_total === null || raw.deduction_total === undefined ? null : num(raw.deduction_total),
    deduction_reclaimed_total:
      raw.deduction_reclaimed_total === null || raw.deduction_reclaimed_total === undefined ? null : num(raw.deduction_reclaimed_total),
  }
  return { invoice, customerRow }
}

/**
 * The customer's personnummer as the provider would get it. Decrypting is a
 * reveal: who did it, for which customer and why is logged, never the value.
 */
export function revealDebtorPersonalNumber(
  stored: string | null | undefined,
  context: { now: Date; today: string; purpose: 'collections_check' | 'collections_handover'; customerId: string; userId: string | null; log?: Logger },
): DebtorPersonalNumber {
  if (!stored) return { status: 'none' }
  const log = context.log ?? defaultLog
  let plaintext: string | null
  try {
    plaintext = revealStoredCustomerPersonalNumber(stored)
  } catch (err) {
    log.error('customer personal_number unreadable for collections', {
      customerId: context.customerId,
      reason: err instanceof Error ? err.message : String(err),
    })
    return { status: 'invalid' }
  }
  log.info('customer personal number revealed', {
    purpose: context.purpose,
    customerId: context.customerId,
    userId: context.userId,
  })
  return normalizeDebtorPersonalNumber(plaintext, context.now, context.today)
}

export function toHandoverCustomer(
  row: Record<string, unknown> | null,
  personalNumber: DebtorPersonalNumber,
): HandoverCustomer | null {
  if (!row) return null
  const str = (k: string) => (typeof row[k] === 'string' ? (row[k] as string) : null)
  return {
    id: String(row.id),
    name: str('name') ?? '',
    customer_type: str('customer_type') ?? 'swedish_business',
    country: str('country'),
    address_line1: str('address_line1'),
    address_line2: str('address_line2'),
    postal_code: str('postal_code'),
    city: str('city'),
    org_number: str('org_number'),
    vat_number: str('vat_number'),
    customer_number: str('customer_number'),
    email: str('email'),
    phone: str('phone'),
    personalNumber,
    collections_excluded: row.collections_excluded === true,
  }
}

/** What reached the customer: delivered, attempted without proof, or no history at all. Pure. */
export function deliveryEvidence(input: {
  emailDeliveries: ReadonlyArray<{ status: string; provider_status: string | null }>
  peppolDeliveries: ReadonlyArray<{ status: string }>
}): DeliveryEvidence {
  const undelivered = new Set(['bounced', 'suppressed', 'failed'])
  const emailOk = input.emailDeliveries.some(
    (d) => d.status === 'marked_sent' || (d.status === 'sent' && !undelivered.has(d.provider_status ?? '')),
  )
  const peppolOk = input.peppolDeliveries.some((d) =>
    ['transport_succeeded', 'recipient_acknowledged', 'business_accepted'].includes(d.status),
  )
  if (emailOk || peppolOk) return 'delivered'
  return input.emailDeliveries.length + input.peppolDeliveries.length > 0 ? 'not_delivered' : 'no_history'
}

/** The credit notes against an invoice, what reached the customer, and whether it came from another system. */
export interface InvoiceDeliveryFacts {
  /** Credit notes against the invoice that are not cancelled. */
  creditNotes: { status: string }[]
  delivery: DeliveryEvidence
  /** The invoice came from another system (a provider migration). */
  imported: boolean
}

/**
 * Read once for the collections handover and for the reminder sender
 * (lib/reminders/facts.ts), so both judge "credited", "delivered" and
 * "imported" by the same rows.
 */
export async function loadInvoiceDeliveryFacts(
  db: Pick<SupabaseClient, 'from'>,
  companyId: string,
  invoiceId: string,
): Promise<InvoiceDeliveryFacts> {
  const [creditNotes, emailDeliveries, peppolDeliveries, imported] = await Promise.all([
    db.from('invoices').select('status').eq('company_id', companyId).eq('credited_invoice_id', invoiceId).neq('status', 'cancelled'),
    db.from('invoice_deliveries').select('status, provider_status').eq('company_id', companyId).eq('invoice_id', invoiceId),
    db.from('peppol_deliveries').select('status').eq('company_id', companyId).eq('invoice_id', invoiceId),
    db
      .from('migration_source_records')
      .select('id')
      .eq('company_id', companyId)
      .eq('resource', 'salesInvoices')
      .eq('target_id', invoiceId)
      .limit(1),
  ])
  for (const [label, result] of [
    ['credit notes', creditNotes],
    ['invoice_deliveries', emailDeliveries],
    ['peppol_deliveries', peppolDeliveries],
    ['migration_source_records', imported],
  ] as const) {
    if (result.error) throw new Error(`${label} lookup failed: ${result.error.message}`)
  }
  return {
    creditNotes: (creditNotes.data ?? []) as { status: string }[],
    delivery: deliveryEvidence({
      emailDeliveries: (emailDeliveries.data ?? []) as { status: string; provider_status: string | null }[],
      peppolDeliveries: (peppolDeliveries.data ?? []) as { status: string }[],
    }),
    imported: ((imported.data ?? []) as unknown[]).length > 0,
  }
}

export interface LoadHandoverContextInput {
  companyId: string
  invoiceId: string
  connection: Pick<CollectionConnectionRow, 'minimum_amount' | 'reminder_fee_terms_since'>
  features: CollectionsFeatures | null
  dismissedTransactionIds?: readonly string[]
  purpose: 'collections_check' | 'collections_handover'
  userId: string | null
  now?: Date
  log?: Logger
}

export async function loadHandoverContext(
  db: Pick<SupabaseClient, 'from'>,
  input: LoadHandoverContextInput,
): Promise<HandoverContext> {
  const now = input.now ?? new Date()
  const today = todayIsoStockholm(now)
  const { companyId, invoiceId } = input
  const { invoice, customerRow } = await loadHandoverInvoice(db, companyId, invoiceId)

  const [settings, openCase, latestCase, invoiceFacts, reminders, payments] = await Promise.all([
    db.from('company_settings').select('ore_rounding').eq('company_id', companyId).maybeSingle(),
    loadOpenCaseForInvoice(db, companyId, invoiceId),
    db
      .from('collection_cases')
      .select('stage, is_open')
      .eq('company_id', companyId)
      .eq('invoice_id', invoiceId)
      .eq('submission_status', 'registered')
      .order('created_at', { ascending: false })
      .limit(1),
    loadInvoiceDeliveryFacts(db, companyId, invoiceId),
    db.from('invoice_reminders').select('response_type, created_at').eq('invoice_id', invoiceId).not('response_type', 'is', null),
    db.from('invoice_payments').select('id, payment_date, amount').eq('company_id', companyId).eq('invoice_id', invoiceId),
  ])
  for (const [label, result] of [
    ['company_settings', settings],
    ['collection_cases', latestCase],
    ['invoice_reminders', reminders],
    ['invoice_payments', payments],
  ] as const) {
    if (result.error) throw new Error(`${label} lookup failed: ${result.error.message}`)
  }

  const personalNumber =
    customerRow && customerRow.customer_type === 'individual'
      ? revealDebtorPersonalNumber(customerRow.personal_number as string | null, {
          now,
          today,
          purpose: input.purpose,
          customerId: String(customerRow.id),
          userId: input.userId,
          log: input.log,
        })
      : ({ status: 'none' } as const)
  const customer = toHandoverCustomer(customerRow, personalNumber)

  const responses = ((reminders.data ?? []) as { response_type: string }[]).map((r) => r.response_type)
  const reminderResponse = responses.includes('disputed') ? 'disputed' : responses.includes('marked_paid') ? 'marked_paid' : null

  const eligibility = evaluateEligibility({
    invoice,
    customer,
    today,
    companyOreRounding: (settings.data as { ore_rounding?: boolean | null } | null)?.ore_rounding ?? null,
    connection: input.connection,
    features: input.features,
    openCase: openCase ? { id: openCase.id, stage: openCase.stage } : null,
    latestCaseClosedPaid: isClosedPaid(((latestCase.data ?? []) as { stage: string; is_open: boolean }[])[0]),
    creditNotes: invoiceFacts.creditNotes,
    delivery: invoiceFacts.delivery,
    imported: invoiceFacts.imported,
    reminderResponse,
  })

  const bankCheck = await runBankCheck(db, {
    companyId,
    invoice: {
      id: invoice.id,
      invoice_number: invoice.invoice_number,
      invoice_date: invoice.invoice_date,
      currency: invoice.currency,
      payment_cash_account_id: invoice.payment_cash_account_id,
    },
    customerName: customer?.name ?? null,
    remaining: eligibility.claim.remaining,
    dismissedTransactionIds: input.dismissedTransactionIds ?? [],
    today,
    now,
  })

  return {
    invoice,
    customer,
    openCase,
    eligibility,
    bankCheck,
    payments: ((payments.data ?? []) as { id: string; payment_date: string; amount: number }[]).map((p) => ({
      id: p.id,
      payment_date: p.payment_date,
      amount: Number(p.amount),
    })),
    today,
  }
}
