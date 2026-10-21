/**
 * Sending a customer invoice to the customer's Kivra or Billo mailbox.
 *
 * The order is the Peppol send's (peppol-send-service.ts): every check that
 * can refuse runs first and changes nothing; then a draft is issued through
 * issueAndBookInvoice, the one issue path every door runs (numbered, status
 * sent, its verifikat posted, the PDF archived as underlag), fail closed;
 * only then does the document leave Accounted. A delivery that fails after
 * the issue leaves an issued invoice and a failed dispatch: sending again is
 * a resend of the issued invoice, never a second issue.
 *
 * Recipients: a Swedish company by its organisationsnummer (Kivra Företag,
 * Billo business mailbox); a private person, or a sole trader whose
 * organisationsnummer is the owner's personnummer, by the personnummer.
 * The recipient's mailbox is checked (the provider's match) before anything
 * is issued, so an unreachable customer leaves the draft as it was.
 *
 * Every attempt, sent or failed, is a digital_mailbox_dispatches row: how
 * the invoice reached its customer.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { generateOcrReference } from '@/lib/bankgiro/luhn'
import { isKronorCurrency } from '@/lib/bookkeeping/currency-utils'
import { revealStoredCustomerPersonalNumber } from '@/lib/customers/protect-personal-number'
import { getConnection } from '@/lib/digital-mailboxes/connections'
import { isDigitalMailboxApiError } from '@/lib/digital-mailboxes/http'
import { isLegalPersonOrgNumber, personnummer12 } from '@/lib/digital-mailboxes/identifiers'
import { getDigitalMailboxProviders } from '@/lib/digital-mailboxes/providers'
import type {
  DigitalMailboxProviderId,
  MailboxRecipient,
  OutgoingPayment,
} from '@/lib/digital-mailboxes/types'
import { normalizeOrgNumber } from '@/lib/invariants/org-number'
import { invoiceAmountDue } from '@/lib/invoices/amount-due'
import { issueAndBookInvoice } from '@/lib/invoices/issue-and-book-invoice'
import { invoicePrintsBankgiro, invoicePrintsPlusgiro, invoiceShowsOcrReference } from '@/lib/invoices/ocr-reference'
import { invoicePdfFilename } from '@/lib/invoices/pdf-filename'
import { renderInvoicePdfBuffer } from '@/lib/invoices/render-invoice-pdf'
import type { Logger } from '@/lib/logger'
import { isSandboxCompany } from '@/lib/sandbox/guard'
import type { CompanySettings, Customer, Invoice, InvoiceItem } from '@/types'

export type DigitalMailboxSendCode =
  | 'INVOICE_NOT_FOUND'
  | 'DIGITAL_MAILBOX_NOT_CONFIGURED'
  | 'DIGITAL_MAILBOX_SANDBOX'
  | 'DIGITAL_MAILBOX_SENDING_NOT_ACTIVE'
  | 'DIGITAL_MAILBOX_INVOICE_NOT_SENDABLE'
  | 'DIGITAL_MAILBOX_CURRENCY_UNSUPPORTED'
  | 'DIGITAL_MAILBOX_RECIPIENT_UNIDENTIFIED'
  | 'DIGITAL_MAILBOX_RECIPIENT_NOT_REACHABLE'
  | 'DIGITAL_MAILBOX_PROVIDER_FAILED'
  | 'DIGITAL_MAILBOX_DOCUMENT_TOO_LARGE'
  | 'DIGITAL_MAILBOX_SEND_FAILED'
  | 'INVOICE_SEND_COMPANY_SETTINGS_MISSING'

export type DigitalMailboxSendOutcome =
  | {
      ok: true
      data: {
        dispatch_id: string | null
        provider: DigitalMailboxProviderId
        provider_ref: string | null
        recipient_kind: MailboxRecipient['kind']
        /** True when this call issued the draft (numbered, booked). */
        issued: boolean
        journal_entry_id: string | null
      }
    }
  | {
      ok: false
      code: DigitalMailboxSendCode | string
      details?: Record<string, unknown>
      messageSv?: string
      messageEn?: string
      bookingError?: unknown
    }

export interface DigitalMailboxSendContext {
  supabase: SupabaseClient
  /** Service role: the connection and the dispatch log have no member write policy. */
  service: SupabaseClient
  companyId: string
  userId: string
  log: Logger
}

type LoadedInvoice = Invoice & { customer: Customer | null; items: InvoiceItem[] | null }

/** Statuses an invoice can be sent to a mailbox from: a draft (issued on the way) or an issued, unpaid one. */
const SENDABLE_STATUSES = new Set(['draft', 'sent', 'overdue', 'partially_paid'])

/** Why the invoice itself cannot go to a mailbox, or null. Pure: the editor's readiness reads it too. */
export function invoiceMailboxBlock(
  invoice: Pick<Invoice, 'status' | 'document_type' | 'credited_invoice_id' | 'currency'>,
): 'DIGITAL_MAILBOX_INVOICE_NOT_SENDABLE' | 'DIGITAL_MAILBOX_CURRENCY_UNSUPPORTED' | null {
  if ((invoice.document_type || 'invoice') !== 'invoice' || invoice.credited_invoice_id) {
    return 'DIGITAL_MAILBOX_INVOICE_NOT_SENDABLE'
  }
  if (!SENDABLE_STATUSES.has(invoice.status)) return 'DIGITAL_MAILBOX_INVOICE_NOT_SENDABLE'
  // Kivra and Billo take payment details in kronor only.
  if (!isKronorCurrency(invoice.currency)) return 'DIGITAL_MAILBOX_CURRENCY_UNSUPPORTED'
  return null
}

/**
 * Whom the invoice is addressed to at the provider. A Swedish legal person
 * by its organisationsnummer; a sole trader (organisationsnummer that is a
 * personnummer) and a private person by the twelve-digit personnummer.
 */
export function invoiceMailboxRecipient(
  customer: Pick<Customer, 'customer_type' | 'org_number' | 'personal_number'> | null,
): MailboxRecipient | null {
  if (!customer) return null
  if (customer.customer_type === 'swedish_business') {
    const org = normalizeOrgNumber(customer.org_number)
    if (!org) return null
    if (isLegalPersonOrgNumber(org)) return { kind: 'company', orgNumber: org }
    const owner = personnummer12(org)
    return owner ? { kind: 'person', personnummer: owner } : null
  }
  if (customer.customer_type === 'individual') {
    let stored: string | null
    try {
      stored = revealStoredCustomerPersonalNumber(customer.personal_number)
    } catch {
      return null
    }
    const pnr = personnummer12(stored)
    return pnr ? { kind: 'person', personnummer: pnr } : null
  }
  return null
}

/**
 * How the invoice is paid, as the mailbox shows it: the giro the PDF prints
 * (the invoice's own payee first) and the OCR when the PDF prints one, else
 * the invoice number. Null when the PDF prints no Swedish giro or nothing is
 * due: the invoice then goes as a document.
 */
export function invoiceMailboxPayment(invoice: Invoice, settings: CompanySettings, language: 'sv' | 'en'): OutgoingPayment | null {
  const payee = invoice.payment_details ?? null
  const giro = {
    ...settings,
    bankgiro: payee ? payee.bankgiro : settings.bankgiro,
    plusgiro: payee ? payee.plusgiro : settings.plusgiro,
  }
  const amount = invoiceAmountDue(invoice, settings)
  if (amount <= 0 || !invoice.invoice_number) return null
  let method: OutgoingPayment['method']
  let account: string
  if (invoicePrintsBankgiro(giro)) {
    method = 'bankgiro'
    account = giro.bankgiro!.trim()
  } else if (invoicePrintsPlusgiro(giro)) {
    method = 'plusgiro'
    account = giro.plusgiro!.trim()
  } else {
    return null
  }
  const ocr = invoiceShowsOcrReference(giro, language)
  return {
    amount,
    dueDate: invoice.due_date,
    method,
    account,
    reference: ocr ? generateOcrReference(invoice.invoice_number) : invoice.invoice_number,
    referenceType: ocr ? 'ocr' : 'invoice_number',
  }
}

async function loadInvoice(supabase: SupabaseClient, companyId: string, invoiceId: string): Promise<LoadedInvoice | null> {
  const { data } = await supabase
    .from('invoices')
    .select('*, customer:customers(*), items:invoice_items(*)')
    .eq('id', invoiceId)
    .eq('company_id', companyId)
    .maybeSingle()
  return (data as LoadedInvoice | null) ?? null
}

async function recordDispatch(
  ctx: DigitalMailboxSendContext,
  row: {
    provider: DigitalMailboxProviderId
    invoiceId: string
    recipientKind: MailboxRecipient['kind']
    status: 'sent' | 'failed'
    providerRef?: string | null
    errorCode?: string | null
    errorMessage?: string | null
  },
): Promise<string | null> {
  const { data, error } = await ctx.service
    .from('digital_mailbox_dispatches')
    .insert({
      company_id: ctx.companyId,
      provider: row.provider,
      invoice_id: row.invoiceId,
      recipient_kind: row.recipientKind,
      status: row.status,
      provider_ref: row.providerRef ?? null,
      error_code: row.errorCode ?? null,
      error_message: row.errorMessage ? row.errorMessage.slice(0, 500) : null,
      sent_by: ctx.userId,
    })
    .select('id')
    .single()
  if (error) {
    // The delivery happened (or failed) regardless; a lost log row is an
    // operator's problem, not a reason to report the send differently.
    ctx.log.error('digital mailbox dispatch could not be recorded', error, { invoiceId: row.invoiceId })
    return null
  }
  return (data as { id: string }).id
}

export async function sendInvoiceToDigitalMailbox(
  ctx: DigitalMailboxSendContext,
  invoiceId: string,
  providerId: DigitalMailboxProviderId,
): Promise<DigitalMailboxSendOutcome> {
  const sender = getDigitalMailboxProviders()[providerId]?.sender
  if (!sender) return { ok: false, code: 'DIGITAL_MAILBOX_NOT_CONFIGURED' }
  if (await isSandboxCompany(ctx.supabase, ctx.companyId)) return { ok: false, code: 'DIGITAL_MAILBOX_SANDBOX' }

  const connection = await getConnection(ctx.service, ctx.companyId, providerId)
  if (connection?.send_state !== 'active' || !connection.tenant_ref) {
    return { ok: false, code: 'DIGITAL_MAILBOX_SENDING_NOT_ACTIVE' }
  }
  const tenantRef = connection.tenant_ref

  let invoice = await loadInvoice(ctx.supabase, ctx.companyId, invoiceId)
  if (!invoice) return { ok: false, code: 'INVOICE_NOT_FOUND' }
  const block = invoiceMailboxBlock(invoice)
  if (block) return { ok: false, code: block, details: { status: invoice.status } }
  const recipient = invoiceMailboxRecipient(invoice.customer)
  if (!recipient) return { ok: false, code: 'DIGITAL_MAILBOX_RECIPIENT_UNIDENTIFIED' }

  try {
    if (!(await sender.isReachable(tenantRef, recipient))) {
      return { ok: false, code: 'DIGITAL_MAILBOX_RECIPIENT_NOT_REACHABLE', details: { recipient_kind: recipient.kind } }
    }
  } catch (err) {
    ctx.log.warn('digital mailbox recipient match failed', { invoiceId, provider: providerId, reason: err instanceof Error ? err.message : String(err) })
    return { ok: false, code: 'DIGITAL_MAILBOX_PROVIDER_FAILED' }
  }

  const { data: settingsRow } = await ctx.supabase.from('company_settings').select('*').eq('company_id', ctx.companyId).single()
  if (!settingsRow) return { ok: false, code: 'INVOICE_SEND_COMPANY_SETTINGS_MISSING' }
  const settings = settingsRow as CompanySettings

  let issued = false
  let journalEntryId: string | null = null
  if (invoice.status === 'draft') {
    const result = await issueAndBookInvoice({
      supabase: ctx.supabase,
      companyId: ctx.companyId,
      userId: ctx.userId,
      invoice,
      settings,
      log: ctx.log,
    })
    if (!result.ok) {
      return {
        ok: false,
        code: result.errorCode,
        ...(result.details ? { details: result.details } : {}),
        ...(result.messageSv ? { messageSv: result.messageSv, messageEn: result.messageEn } : {}),
        ...(result.bookingError !== undefined ? { bookingError: result.bookingError } : {}),
      }
    }
    issued = true
    journalEntryId = result.journalEntryId
    // The number, the frozen payee and the status are on the row now.
    const reloaded = await loadInvoice(ctx.supabase, ctx.companyId, invoiceId)
    if (reloaded) invoice = reloaded
  }

  const customer = invoice.customer as Customer
  const language = customer.language === 'en' ? 'en' : 'sv'
  const items = (invoice.items ?? []).slice().sort((a, b) => a.sort_order - b.sort_order)

  const fail = async (code: DigitalMailboxSendCode, message: string): Promise<DigitalMailboxSendOutcome> => {
    await recordDispatch(ctx, {
      provider: providerId,
      invoiceId,
      recipientKind: recipient.kind,
      status: 'failed',
      errorCode: code,
      errorMessage: message,
    })
    return { ok: false, code, details: { issued, journal_entry_id: journalEntryId } }
  }

  let pdf: Buffer
  try {
    ;({ buffer: pdf } = await renderInvoicePdfBuffer({
      invoice: { ...invoice, status: invoice.status === 'draft' ? 'sent' : invoice.status },
      customer,
      items,
      company: settings,
    }))
  } catch (err) {
    ctx.log.error('invoice pdf render failed for digital mailbox send', err as Error, { invoiceId })
    return fail('DIGITAL_MAILBOX_SEND_FAILED', 'pdf render failed')
  }

  const invoiceNumber = invoice.invoice_number ?? ''
  try {
    const receipt = await sender.sendInvoice(tenantRef, recipient, {
      subject: `${language === 'en' ? 'Invoice' : 'Faktura'} ${invoiceNumber} ${language === 'en' ? 'from' : 'från'} ${settings.company_name ?? ''}`.trim(),
      generatedAt: invoice.invoice_date,
      invoiceNumber,
      pdf: {
        name: invoicePdfFilename({
          companyName: settings.company_name,
          customerName: customer.name,
          invoiceNumber: invoice.invoice_number,
          invoiceId: invoice.id,
          invoiceDate: invoice.invoice_date,
        }),
        bytes: new Uint8Array(pdf),
      },
      payment: invoiceMailboxPayment(invoice, settings, language),
    })
    const dispatchId = await recordDispatch(ctx, {
      provider: providerId,
      invoiceId,
      recipientKind: recipient.kind,
      status: 'sent',
      providerRef: receipt.providerRef,
    })
    return {
      ok: true,
      data: {
        dispatch_id: dispatchId,
        provider: providerId,
        provider_ref: receipt.providerRef,
        recipient_kind: recipient.kind,
        issued,
        journal_entry_id: journalEntryId,
      },
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.log.warn('digital mailbox invoice send failed', { invoiceId, provider: providerId, reason: message })
    if (isDigitalMailboxApiError(err) && (err.status === 413 || err.providerCode === 'too_large')) {
      return fail('DIGITAL_MAILBOX_DOCUMENT_TOO_LARGE', message)
    }
    return fail('DIGITAL_MAILBOX_SEND_FAILED', message)
  }
}

export interface MailboxDispatchSummary {
  id: string
  provider: DigitalMailboxProviderId
  recipient_kind: 'company' | 'person'
  status: 'sent' | 'failed'
  error_code: string | null
  created_at: string
}

/** The invoice's mailbox dispatches, newest first (RLS-scoped read). */
export async function listInvoiceMailboxDispatches(
  supabase: SupabaseClient,
  companyId: string,
  invoiceId: string,
): Promise<MailboxDispatchSummary[]> {
  const { data, error } = await supabase
    .from('digital_mailbox_dispatches')
    .select('id, provider, recipient_kind, status, error_code, created_at')
    .eq('company_id', companyId)
    .eq('invoice_id', invoiceId)
    .order('created_at', { ascending: false })
  if (error) throw new Error(`dispatch read failed: ${error.message}`)
  return (data as MailboxDispatchSummary[] | null) ?? []
}

export interface InvoiceMailboxOption {
  provider: DigitalMailboxProviderId
  /** Every local check passes; the recipient's mailbox is matched at send. */
  available: boolean
  reason: DigitalMailboxSendCode | null
}

/**
 * The mailbox channels the editor offers for this invoice: providers whose
 * sending this company activated, each with whether the invoice and its
 * customer allow it. Local checks only, no provider call.
 */
export async function invoiceMailboxOptions(
  ctx: Pick<DigitalMailboxSendContext, 'supabase' | 'service' | 'companyId'>,
  invoiceId: string,
): Promise<InvoiceMailboxOption[] | null> {
  const invoice = await loadInvoice(ctx.supabase, ctx.companyId, invoiceId)
  if (!invoice) return null
  const providers = getDigitalMailboxProviders()
  const options: InvoiceMailboxOption[] = []
  for (const id of ['kivra', 'billo'] as const) {
    if (!providers[id]?.sender) continue
    const connection = await getConnection(ctx.service, ctx.companyId, id)
    if (connection?.send_state !== 'active') continue
    const reason = invoiceMailboxBlock(invoice) ?? (invoiceMailboxRecipient(invoice.customer) ? null : 'DIGITAL_MAILBOX_RECIPIENT_UNIDENTIFIED')
    options.push({ provider: id, available: reason === null, reason })
  }
  return options
}
