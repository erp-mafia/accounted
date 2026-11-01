import { isCreditNoteDocument } from '@/lib/bookkeeping/credit-note-state'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CompanySettings, Customer, Invoice, InvoiceDeliveryProviderStatus } from '@/types'
import { collectionClaim } from '@/lib/collections/eligibility'
import { loadInvoiceDeliveryFacts } from '@/lib/collections/readiness'
import { isReminderExcluded, loadReminderExclusions } from '@/lib/collections/reminder-guard'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { EMAIL_PATTERN } from '@/lib/invoices/email-recipients'
import type { ReminderHistoryEntry, ReminderInvoiceFacts, ReminderLevel } from './policy'

/**
 * Everything one reminder decision rests on, read fresh: the invoice and its
 * customer, the company's settings and whether it may remind anyone at all,
 * the credit notes, what reached the customer, whether the invoice came from
 * another system, the collections provider's claim on it, and the reminders
 * already on record. The same facts the collections handover reads, with
 * the same helpers (claim, delivery evidence, reminder guard), so the two
 * never disagree about what is owed or delivered.
 *
 * Reads with the service role and an explicit company filter: the callers
 * (the daily batch, its commit, the invoice page) have established that the
 * actor may act for the company.
 */

export interface ReminderContext {
  invoice: Invoice
  customer: Customer | null
  company: CompanySettings
  /**
   * Archived, the archived source of a migration reset, or a sandbox: such a
   * company never reminds anyone, whatever its toggle says (the 85 reset
   * sources kept send_invoice_reminders = true through migration
   * 20261025084600, which may not write to them).
   */
  companyInactive: boolean
  /** What the invoice asked for (collectionClaim().amount); facts.remaining is what is left of it. */
  amount: number
  facts: ReminderInvoiceFacts
  history: ReminderHistoryEntry[]
}

export class ReminderInvoiceNotFoundError extends Error {
  constructor() {
    super('Invoice not found')
    this.name = 'ReminderInvoiceNotFoundError'
  }
}

function num(value: unknown): number {
  return value === null || value === undefined ? 0 : Number(value)
}

export async function loadReminderContext(
  db: Pick<SupabaseClient, 'from'>,
  companyId: string,
  invoiceId: string,
): Promise<ReminderContext> {
  const { data: row, error } = await db
    .from('invoices')
    .select('*, customer:customers(*)')
    .eq('company_id', companyId)
    .eq('id', invoiceId)
    .maybeSingle()
  if (error) throw new Error(`invoice lookup failed: ${error.message}`)
  if (!row) throw new ReminderInvoiceNotFoundError()
  const raw = row as Invoice & { customer: Customer | Customer[] | null; autogiro_payer_number?: string | null; is_self_billed?: boolean | null }
  const customer = (Array.isArray(raw.customer) ? raw.customer[0] : raw.customer) ?? null
  const invoice = raw as Invoice

  const [settings, company, resetSource, invoiceFacts, reminders, exclusions] = await Promise.all([
    db.from('company_settings').select('*').eq('company_id', companyId).maybeSingle(),
    db.from('companies').select('archived_at').eq('id', companyId).maybeSingle(),
    db.from('company_migration_resets').select('source_company_id').eq('source_company_id', companyId).limit(1),
    // Credited, delivered and imported, by the same rows as the collections handover.
    loadInvoiceDeliveryFacts(db, companyId, invoiceId),
    db
      .from('invoice_reminders')
      .select('reminder_level, status, sent_at, provider_status, response_type, mode, outcome_unknown')
      .eq('company_id', companyId)
      .eq('invoice_id', invoiceId),
    // Fail closed: the guard throws when it cannot tell.
    loadReminderExclusions(db, [{ id: invoiceId, company_id: companyId }]),
  ])
  for (const [label, result] of [
    ['company_settings', settings],
    ['companies', company],
    ['company_migration_resets', resetSource],
    ['invoice_reminders', reminders],
  ] as const) {
    if (result.error) throw new Error(`${label} lookup failed: ${result.error.message}`)
  }
  if (!settings.data) throw new Error('company_settings missing')
  const companySettings = settings.data as CompanySettings & { is_sandbox?: boolean | null; ore_rounding?: boolean | null }

  const companyInactive =
    !company.data ||
    (company.data as { archived_at: string | null }).archived_at !== null ||
    ((resetSource.data ?? []) as unknown[]).length > 0 ||
    companySettings.is_sandbox === true

  // What is owed: the printed amount less what the customer paid, and
  // nothing when the books say nothing remains (the collections rule).
  const claim = collectionClaim(
    {
      total: num(invoice.total),
      vat_amount: num(invoice.vat_amount),
      currency: invoice.currency,
      paid_amount: invoice.paid_amount === null || invoice.paid_amount === undefined ? null : num(invoice.paid_amount),
      deduction_total: invoice.deduction_total === null || invoice.deduction_total === undefined ? null : num(invoice.deduction_total),
      credited_invoice_id: invoice.credited_invoice_id,
      ore_rounding: invoice.ore_rounding,
    },
    companySettings.ore_rounding ?? null,
  )
  const remaining = num(invoice.remaining_amount) <= 0 ? 0 : claim.remaining

  const email = customer?.email?.trim() ?? ''
  const facts: ReminderInvoiceFacts = {
    kind: isCreditNoteDocument(invoice) || (invoice.document_type ?? 'invoice') !== 'invoice' || raw.is_self_billed ? 'other' : 'invoice',
    status: invoice.status,
    invoiceDate: invoice.invoice_date,
    dueDate: invoice.due_date,
    remaining,
    credited: invoiceFacts.creditNotes.length > 0,
    delivery: invoiceFacts.delivery,
    imported: invoiceFacts.imported,
    autogiro: !!raw.autogiro_payer_number,
    recipient: email && EMAIL_PATTERN.test(email) ? email : null,
    customerExcluded: (customer as (Customer & { reminders_excluded?: boolean }) | null)?.reminders_excluded === true,
    withCollections: isReminderExcluded(exclusions, { id: invoiceId, company_id: companyId }),
  }

  const history: ReminderHistoryEntry[] = (
    (reminders.data ?? []) as Array<{
      reminder_level: number
      status: ReminderHistoryEntry['status']
      sent_at: string | null
      provider_status: InvoiceDeliveryProviderStatus | null
      response_type: ReminderHistoryEntry['responseType']
      mode: string | null
      outcome_unknown?: boolean | null
    }>
  ).map((r) => ({
    level: r.reminder_level as ReminderLevel,
    status: r.status,
    sentOn: r.status === 'sent' && r.sent_at ? todayIsoStockholm(new Date(r.sent_at)) : null,
    providerStatus: r.provider_status,
    responseType: r.response_type,
    legacy: r.mode === null,
    // Only a refusal on record frees the level again; anything else may have gone out.
    ...(r.status === 'failed' ? { outcomeUnknown: r.outcome_unknown !== false } : {}),
  }))

  return { invoice, customer, company: companySettings, companyInactive, amount: claim.amount, facts, history }
}
