/**
 * The browser side of bank payments: the shapes the session routes under
 * /api/payments answer with, and one fetch helper per route. Every write goes
 * through here so the dialogs and the Betalningar page send the same bodies.
 *
 * Nothing here is logged: a QR payload or an autostart token belongs to the
 * person signing and is rendered, never printed.
 */

import type { PaymentOrderStatus } from '@/lib/payments/orders/status'
import type { VerificationState } from '@/lib/payments/orders/verification-state'
import type { DocumentChecks, InvoiceDocumentFacts, InvoiceDocumentSource } from '@/lib/payments/orders/invoice-document'

export type { PaymentOrderStatus, VerificationState }

export interface PayableAccount {
  id: string
  name: string | null
  ledger_account: string
  iban: string | null
  /** The bank behind the account, for its mark and the signing step. */
  bank_name: string | null
  payable: boolean
  reason: 'account_disabled' | 'not_sek' | 'iban_missing' | 'bank_unknown' | null
}

export interface PaymentsAvailability {
  available: boolean
  /** Why not, when available is false: no_provider, not_in_pilot, sandbox, or subscription (upgrade to pay through the bank). */
  reason: 'no_provider' | 'not_in_pilot' | 'subscription' | 'sandbox' | null
  provider: string | null
  accounts: PayableAccount[]
  /** The person has a BankID login on file, so signing needs no typed personnummer. */
  signer_known: boolean
}

/** GET /api/payments/verification: the provider's answer and where the verification stands (lib/payments/orders/verification-state). */
export interface CompanyVerification {
  status: 'valid' | 'invalid' | 'unknown'
  valid_until: string | null
  state: VerificationState
  /** ISO instant the current form link runs out; null without a link. */
  link_expires_at: string | null
  checked_at: string | null
}

/** POST /api/payments/verification: a fresh form link, valid 24 hours. Shown or handed over once; never stored by the browser. */
export interface StartedVerification {
  url: string
  expires_at: string
  state: VerificationState
}

export type PayeeType = 'bankgiro' | 'plusgiro' | 'bank_account' | 'iban'
export type PayeeCheck = 'unchecked' | 'known' | 'new' | 'changed'

/** A payment_orders row as GET /api/payments/orders lists it (named columns, never internals). */
export interface PaymentOrder {
  id: string
  supplier_invoice_id: string | null
  batch_id: string | null
  status: PaymentOrderStatus
  amount: number
  currency: string
  requested_execution_date: string
  cash_account_id: string
  payee_type: PayeeType
  payee_bankgiro: string | null
  payee_plusgiro: string | null
  payee_clearing: string | null
  payee_account: string | null
  payee_iban: string | null
  payee_name: string
  payee_source: 'invoice' | 'supplier'
  payee_check: PayeeCheck
  reference_type: 'ocr' | 'message'
  reference: string
  end_to_end_id: string
  provider: string | null
  provider_status: string | null
  provider_status_at: string | null
  provider_error_code: string | null
  provider_error_message: string | null
  create_started_at: string | null
  outcome_unknown_at: string | null
  approved_by: string | null
  approved_at: string | null
  submitted_at: string | null
  signed_at: string | null
  executed_at: string | null
  cancelled_at: string | null
  matched_at: string | null
  created_at: string
  updated_at: string
  /** The invoice paid, with what its document states (lib/payments/orders/invoice-document). */
  supplier_invoice: (InvoiceDocumentSource & {
    id: string
    supplier_invoice_number: string | null
    due_date: string | null
    supplier: { name: string } | null
  }) | null
}

export interface PreparedOrders {
  orders: PaymentOrder[]
  skipped: Array<{ supplier_invoice_id: string; reason: string }>
  warnings: Array<{
    supplier_invoice_id: string
    code: 'unattested' | 'ocr_invalid' | 'payee_changed' | 'payee_new' | 'date_moved'
    alternative_payee?: string | null
    from?: string
    to?: string
  }>
  /** Drafts of the same invoices nobody had approved, cancelled so this prepare wins. */
  replaced_draft_ids?: string[]
}

/** One line of the dry run: what a payment would look like, before anything is written. */
export interface PreparedPreviewLine {
  supplier_invoice_id: string
  supplier_name: string
  supplier_invoice_number: string
  amount: number
  currency: string
  requested_execution_date: string
  /** The day asked for when it was no banking day and the payment moved to the next one. */
  date_moved_from: string | null
  payee: { type: string; label: string; source: string }
  reference: { type: 'ocr' | 'message'; value: string }
  warnings: Array<'unattested' | 'ocr_invalid'>
  /** The other account when the supplier card and the invoice disagree; the card is paid unless the person chooses otherwise. */
  alternative_payee: string | null
  /** What the invoice document states, and whether this line pays it. Absent from servers before it. */
  document?: InvoiceDocumentFacts & { checks: DocumentChecks }
}

export interface PreparedPreview {
  cash_account_id: string
  debtor: { bank_name: string | null; bic: string | null }
  lines: PreparedPreviewLine[]
  skipped: Array<{ supplier_invoice_id: string; reason: string }>
  total_amount: number
  currency: string
  replaces_drafts: number
}

export interface SigningChallenge {
  approach: 'decoupled' | 'redirect'
  autostartToken: string | null
  qrData: string | null
  /** The QR as a finished image (data: URL) when the bank sends no data to draw it from. */
  qrImage: string | null
  redirectUrl: string | null
}

export type SigningBatchStatus =
  | 'created'
  | 'awaiting_signature'
  | 'awaiting_second_signer'
  | 'signed'
  | 'rejected'
  | 'cancelled'
  | 'failed'

/** A bank may sign in several BankID steps, each with its own QR: identify, approve a new payee, sign. */
export type SigningStep = 'identify' | 'approve_payee' | 'sign'

export interface SigningView {
  batch_id: string
  status: SigningBatchStatus
  /** Only for the person signing; everyone else sees where the signing stands. */
  challenge: SigningChallenge | null
  failure_code: string | null
  /** Which step the bank is at, when it says. */
  step: SigningStep | null
  orders: Array<{ id: string; status: string; provider_status: string | null; outcome_unknown: boolean }>
}

/** BankID in our screen (qr, same_device) or on the bank's own page (redirect); a bank that signs only there gets redirect whatever is asked. */
export type SigningMethod = 'same_device' | 'qr' | 'redirect'

/** A supplier_invoice_payments row, as the invoice detail lists them (the resolve dialog picks one). */
export interface SupplierInvoicePaymentRow {
  id: string
  payment_date: string
  amount: number
  currency: string
  transaction_id: string | null
  journal_entry_id: string | null
}

/**
 * A failed call: the parsed error body (the structured envelope the routes
 * answer with) so getErrorMessage() can turn it into the person's language,
 * and the envelope code when there is one.
 */
/** The bank's or the provider's refusal code as a sentence, when we know one; else null. */
export function providerCodeText(t: { has: (key: string) => boolean; (key: string): string }, code: string | null | undefined): string | null {
  if (!code) return null
  const key = `provider_${code}`
  return t.has(key) ? t(key) : null
}

export class PaymentsClientError extends Error {
  constructor(
    readonly body: unknown,
    readonly status: number,
  ) {
    super(`payments request failed (${status})`)
    this.name = 'PaymentsClientError'
  }

  get code(): string | null {
    const code = (this.body as { error?: { code?: unknown } } | null)?.error?.code
    return typeof code === 'string' ? code : null
  }
}

async function send<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    ...init,
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...(init?.headers ?? {}) },
  })
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  if (!res.ok) throw new PaymentsClientError(body, res.status)
  return (body as { data: T }).data
}

/** Bank payments sent and accounts used in a month, against what the plan includes (GET /api/payments/usage). */
export interface BankPaymentsUsage {
  period: string
  payments_sent: number
  accounts_used: number
  included_payments: number
  included_accounts: number
  extra_payments: number
  extra_accounts: number
}

export function fetchBankPaymentsUsage(period?: string): Promise<BankPaymentsUsage> {
  return send<BankPaymentsUsage>(period ? `/api/payments/usage?period=${encodeURIComponent(period)}` : '/api/payments/usage')
}

export function fetchPaymentsAvailability(): Promise<PaymentsAvailability> {
  return send<PaymentsAvailability>('/api/payments/availability')
}

/** `refresh` asks the provider even when the stored answer is fresh: the poll while a form is open. */
export function fetchCompanyVerification(options: { refresh?: boolean } = {}): Promise<CompanyVerification> {
  return send<CompanyVerification>(options.refresh ? '/api/payments/verification?refresh=1' : '/api/payments/verification')
}

/** `handoff` when the link is for a firmatecknare (mailed or copied for them): the state then reads awaiting_signatory. */
export function startCompanyVerification(options: { handoff?: boolean } = {}): Promise<StartedVerification> {
  return send<StartedVerification>('/api/payments/verification', { method: 'POST', body: JSON.stringify({ handoff: options.handoff === true }) })
}

export function listPaymentOrders(params: { status?: PaymentOrderStatus[]; supplierInvoiceId?: string } = {}): Promise<PaymentOrder[]> {
  const search = new URLSearchParams()
  if (params.status?.length) search.set('status', params.status.join(','))
  if (params.supplierInvoiceId) search.set('supplier_invoice_id', params.supplierInvoiceId)
  const query = search.toString()
  return send<PaymentOrder[]>(`/api/payments/orders${query ? `?${query}` : ''}`)
}

/** The dry run of a prepare: every rule, no draft. The dialog's preview. */
export function previewPaymentOrders(input: {
  supplierInvoiceIds: string[]
  cashAccountId: string
  executionDate: string | null
  useStatedPayeeFor?: string[]
}): Promise<PreparedPreview> {
  return send<PreparedPreview>('/api/payments/orders', {
    method: 'POST',
    body: JSON.stringify({
      supplier_invoice_ids: input.supplierInvoiceIds,
      cash_account_id: input.cashAccountId,
      execution_date: input.executionDate,
      use_stated_payee_for: input.useStatedPayeeFor,
      dry_run: true,
    }),
  })
}

export function preparePaymentOrders(input: {
  supplierInvoiceIds: string[]
  cashAccountId: string
  executionDate: string | null
  useStatedPayeeFor?: string[]
}): Promise<PreparedOrders> {
  return send<PreparedOrders>('/api/payments/orders', {
    method: 'POST',
    body: JSON.stringify({
      supplier_invoice_ids: input.supplierInvoiceIds,
      cash_account_id: input.cashAccountId,
      execution_date: input.executionDate,
      use_stated_payee_for: input.useStatedPayeeFor,
    }),
  })
}

export function approvePaymentOrders(input: { orderIds: string[]; confirmedPayeeInvoiceIds: string[] }): Promise<{ approved: string[] }> {
  return send<{ approved: string[] }>('/api/payments/orders/approve', {
    method: 'POST',
    body: JSON.stringify({ order_ids: input.orderIds, confirmed_payee_invoice_ids: input.confirmedPayeeInvoiceIds }),
  })
}

export function unapprovePaymentOrders(orderIds: string[]): Promise<{ unapproved: string[] }> {
  return send<{ unapproved: string[] }>('/api/payments/orders/unapprove', {
    method: 'POST',
    body: JSON.stringify({ order_ids: orderIds }),
  })
}

export function cancelPaymentOrder(orderId: string): Promise<{ cancelled: boolean; status: string }> {
  return send<{ cancelled: boolean; status: string }>(`/api/payments/orders/${orderId}/cancel`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
}

export type PaymentOrderResolution = { resolution: 'not_at_bank' } | { resolution: 'paid'; supplier_invoice_payment_id: string }

export function resolvePaymentOrder(orderId: string, resolution: PaymentOrderResolution): Promise<{ status: string }> {
  return send<{ status: string }>(`/api/payments/orders/${orderId}/resolve`, {
    method: 'POST',
    body: JSON.stringify(resolution),
  })
}

export function startSigning(input: { orderIds: string[]; method: SigningMethod; personalNumber: string | null }): Promise<SigningView> {
  return send<SigningView>('/api/payments/signing', {
    method: 'POST',
    body: JSON.stringify({ order_ids: input.orderIds, method: input.method, personal_number: input.personalNumber }),
  })
}

export function restartSigning(input: { batchId: string; method: SigningMethod; personalNumber: string | null }): Promise<SigningView> {
  return send<SigningView>(`/api/payments/signing/${input.batchId}/restart`, {
    method: 'POST',
    body: JSON.stringify({ method: input.method, personal_number: input.personalNumber }),
  })
}

export function pollSigning(input: { batchId: string; personalNumber: string | null }, signal?: AbortSignal): Promise<SigningView> {
  return send<SigningView>(`/api/payments/signing/${input.batchId}/poll`, {
    method: 'POST',
    body: JSON.stringify({ personal_number: input.personalNumber }),
    signal,
  })
}

export async function fetchSupplierInvoicePayments(supplierInvoiceId: string): Promise<SupplierInvoicePaymentRow[]> {
  const invoice = await send<{ payments?: SupplierInvoicePaymentRow[] }>(`/api/supplier-invoices/${supplierInvoiceId}`)
  return invoice.payments ?? []
}

// Bankgiro Lookup (premium, behind OPENPAYMENTS_BANKGIRO_LOOKUP on the server):
// the name Bankgirot has registered for a giro, and the company's own giros.

export type CreditorLookupReason = 'premium_not_enabled' | 'provider_refused' | 'not_found' | 'invalid_number' | 'org_number_missing'

/** GET /api/payments/creditor-lookup with a giro: flat, `enabled` false means the installation never asks. */
export interface CreditorLookupResult {
  enabled: boolean
  available: boolean
  reason: CreditorLookupReason | null
  creditor_name: string | null
  /** With an OCR: whether the creditor accepts it; null when nothing was checked. */
  ocr_valid: boolean | null
  warnings: Array<{ code: string; text: string | null }>
}

export interface RegisteredGiroNumber {
  number: string
  type: 'bankgiro' | 'plusgiro'
  name: string | null
}

export interface CompanyGiroNumbersResult {
  enabled: boolean
  available: boolean
  reason: CreditorLookupReason | null
  giro_numbers: RegisteredGiroNumber[]
}

/** Whether the premium lookups are switched on, without asking anything: the probe form of the route. */
export async function probeCreditorLookup(): Promise<boolean> {
  const answer = await send<{ enabled: boolean }>('/api/payments/creditor-lookup')
  return answer.enabled === true
}

export function lookupCreditorName(input: { giro: string; type: 'bankgiro' | 'plusgiro'; ocr?: string | null; invoiceRef?: string | null }): Promise<CreditorLookupResult> {
  const search = new URLSearchParams({ giro: input.giro, type: input.type })
  if (input.ocr) search.set('ocr', input.ocr)
  else if (input.invoiceRef) search.set('invoice_ref', input.invoiceRef)
  return send<CreditorLookupResult>(`/api/payments/creditor-lookup?${search.toString()}`)
}

export function fetchCompanyGiroNumbers(): Promise<CompanyGiroNumbersResult> {
  return send<CompanyGiroNumbersResult>('/api/payments/giro-numbers')
}

/** The giro of a payment order as the lookup takes it, or null for a bank account or IBAN payee (Bankgirot registers neither). */
export function orderGiroForLookup(order: Pick<PaymentOrder, 'payee_type' | 'payee_bankgiro' | 'payee_plusgiro'>): { giro: string; type: 'bankgiro' | 'plusgiro' } | null {
  if (order.payee_type === 'bankgiro' && order.payee_bankgiro) return { giro: order.payee_bankgiro, type: 'bankgiro' }
  if (order.payee_type === 'plusgiro' && order.payee_plusgiro) return { giro: order.payee_plusgiro, type: 'plusgiro' }
  return null
}

/** "BG 5050-1055", "PG 123456-7", "1234 567890" or an IBAN: the account a payment goes to. */
export function payeeLabel(order: Pick<PaymentOrder, 'payee_type' | 'payee_bankgiro' | 'payee_plusgiro' | 'payee_clearing' | 'payee_account' | 'payee_iban'>): string {
  switch (order.payee_type) {
    case 'bankgiro': {
      const bg = order.payee_bankgiro ?? ''
      return bg.length > 4 ? `BG ${bg.slice(0, -4)}-${bg.slice(-4)}` : `BG ${bg}`
    }
    case 'plusgiro': {
      const pg = order.payee_plusgiro ?? ''
      return pg.length > 1 ? `PG ${pg.slice(0, -1)}-${pg.slice(-1)}` : `PG ${pg}`
    }
    case 'bank_account':
      return `${order.payee_clearing ?? ''} ${order.payee_account ?? ''}`.trim()
    case 'iban':
      return order.payee_iban ?? ''
  }
}

/** The name the list shows for an order: the supplier, then the invoice number. */
export function orderInvoiceLabel(order: PaymentOrder): string {
  const supplier = order.supplier_invoice?.supplier?.name ?? order.payee_name
  const number = order.supplier_invoice?.supplier_invoice_number
  return number ? `${supplier} ${number}` : supplier
}

// Shared with the bank reading consents (components/bankid); re-exported so
// the signing flow's import keeps working.
export { bankIdAutostartHref } from '@/components/bankid/autostart'
