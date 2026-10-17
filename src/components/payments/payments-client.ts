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
import { paymentsReadiness, type PaymentAccountContext, type PaymentsReadiness } from '@/lib/payments/orders/readiness'
import type { DocumentChecks, InvoiceDocumentFacts, InvoiceDocumentSource } from '@/lib/payments/orders/invoice-document'

export type { PaymentOrderStatus, VerificationState, PaymentsReadiness }

export interface PayableAccount {
  id: string
  name: string | null
  ledger_account: string
  iban: string | null
  /** The bank behind the account, for its mark and the signing step. */
  bank_name: string | null
  payable: boolean
  reason: 'account_disabled' | 'not_sek' | 'iban_missing' | 'bank_unknown' | null
  /** private for the owner's personal agreement (no verification asked at signing), else corporate. Absent from servers before it. */
  account_context?: PaymentAccountContext
}

export interface PaymentsAvailability {
  available: boolean
  /** Why not, when available is false: no_provider, not_in_pilot, sandbox, or subscription (upgrade to pay through the bank). */
  reason: 'no_provider' | 'not_in_pilot' | 'subscription' | 'sandbox' | null
  provider: string | null
  accounts: PayableAccount[]
  /** The person has a BankID login on file, so signing needs no typed personnummer. */
  signer_known: boolean
  /** Where the company's verification stands; null when payments are not open or it could not be read. Absent from servers before it. */
  verification?: CompanyVerification | null
  /** What stands between the company and a signed payment (lib/payments/orders/readiness). Absent from servers before it. */
  readiness?: PaymentsReadiness
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
  /** skatteverket: a payment in to the skattekonto (no supplier invoice). */
  payee_source: 'invoice' | 'supplier' | 'skatteverket'
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
  /** Signed, and the bank has not confirmed the payment yet: nothing is left to sign (isBankConfirming). Absent from servers before it. */
  bank_confirming?: boolean
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
  /** The signing is over and the bank is still confirming a payment of it: ask again (with a growing pause). Absent from servers before it. */
  follow_up?: boolean
  /** bank_confirming: signed, the bank has not confirmed it yet; nothing is left to sign. Absent from servers before it. */
  orders: Array<{ id: string; status: string; provider_status: string | null; outcome_unknown: boolean; bank_confirming?: boolean }>
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

/** Bank payments sent and accounts used in a month, against the monthly cap (GET /api/payments/usage). */
export interface BankPaymentsUsage {
  period: string
  payments_sent: number
  accounts_used: number
  /** The cap: payments a month the company may send. */
  included_payments: number
  included_accounts: number
  /** Payments the month still takes. Absent from servers before the cap. */
  remaining_payments?: number
  extra_payments: number
  extra_accounts: number
}

export function fetchBankPaymentsUsage(period?: string): Promise<BankPaymentsUsage> {
  return send<BankPaymentsUsage>(period ? `/api/payments/usage?period=${encodeURIComponent(period)}` : '/api/payments/usage')
}

/** What the month still takes, from a usage answer of any server version. */
export function remainingBankPayments(usage: BankPaymentsUsage): number {
  return usage.remaining_payments ?? Math.max(0, usage.included_payments - usage.payments_sent)
}

/** A signing refused at the monthly cap (BANK_PAYMENTS_ALLOWANCE_EXCEEDED): the numbers the refusal carries. */
export interface BankPaymentsAllowanceRefusal {
  period: string
  used: number
  included: number
  remaining: number
  requested: number
}

/** The cap's numbers when `error` is that refusal; null for anything else. */
export function allowanceRefusalOf(error: unknown): BankPaymentsAllowanceRefusal | null {
  if (!(error instanceof PaymentsClientError) || error.code !== 'BANK_PAYMENTS_ALLOWANCE_EXCEEDED') return null
  const details = (error.body as { error?: { details?: Partial<BankPaymentsAllowanceRefusal> } } | null)?.error?.details
  if (!details || typeof details.period !== 'string' || typeof details.used !== 'number' || typeof details.included !== 'number') return null
  return {
    period: details.period,
    used: details.used,
    included: details.included,
    remaining: typeof details.remaining === 'number' ? details.remaining : Math.max(0, details.included - details.used),
    requested: typeof details.requested === 'number' ? details.requested : 0,
  }
}

/** Begär fler betalningar (POST /api/payments/allowance-requests): support is mailed, a founder answers. */
export function requestMoreBankPayments(input: { monthlyPaymentsWanted: number; message: string | null }): Promise<{ request_id: string; created_at: string }> {
  return send<{ request_id: string; created_at: string }>('/api/payments/allowance-requests', {
    method: 'POST',
    body: JSON.stringify({ monthly_payments_wanted: input.monthlyPaymentsWanted, message: input.message }),
  })
}

export function fetchPaymentsAvailability(): Promise<PaymentsAvailability> {
  return send<PaymentsAvailability>('/api/payments/availability')
}

/**
 * The readiness of a payment from one account (the payment dialog's choice),
 * derived by the same rule the server answers for the whole company
 * (lib/payments/orders/readiness). An account without a context reads as
 * corporate, as the signing does.
 */
export function paymentReadinessFor(availability: PaymentsAvailability, account: PayableAccount | null): PaymentsReadiness {
  return paymentsReadiness({
    available: availability.available,
    accounts: account ? [{ payable: account.payable, account_context: account.account_context ?? 'corporate' }] : [],
    verification: availability.verification ?? null,
  })
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

/** A warning on a payment in to the skattekonto (lib/payments/orders/prepare-skattekonto). */
export interface SkattekontoPaymentWarning {
  code: 'late' | 'date_moved' | 'not_filed' | 'possible_duplicate' | 'same_due_date_parts'
  due?: string
  from?: string
  to?: string
  payment_order_id?: string
  executed_at?: string | null
  /** With several declarations in one payment: the declaration a not_filed or possible_duplicate is about. */
  source?: 'vat_declaration' | 'agi'
  period?: string
  /** same_due_date_parts: the other declarations due the same day, everything due that day, and an unapproved draft replaced. */
  parts?: SkattekontoDueDatePart[]
  total?: number
  replaces_draft?: boolean
}

/** One declaration in a payment of everything due on a day. */
export interface SkattekontoDueDatePart {
  source: 'vat_declaration' | 'agi'
  /** The declaration's period label: YYYY-MM, YYYY-QN, or the räkenskapsår. */
  period: string
  amount: number
}

/**
 * The declaration a skattekonto payment is named from: a momsdeklaration by
 * its period, the AGI of a month, or every declaration due on a day
 * (lib/payments/orders/skattekonto-sources).
 */
export type SkattekontoPaymentSourceInput =
  | { source: 'vat_declaration'; period_type: 'monthly' | 'quarterly' | 'yearly'; year: number; period: number; fiscal_period_id?: string }
  | { source: 'agi'; year: number; month: number }
  | { source: 'due_date'; due_date: string }

/** What the declaration asks for, as the server read it. */
export interface SkattekontoPaymentSourceDue {
  kind: 'vat_declaration' | 'agi'
  tax_period: string
  /** Signed: ruta 49 (negative = to get back), or the AGI's skatt + avgifter. */
  declared: number
  due_date: string | null
  filed: boolean
  paid_at: string | null
}

/** The dry run of a payment in to the skattekonto: what would be paid, from where, when and with which OCR. */
export interface SkattekontoPaymentPreview {
  cash_account_id: string
  debtor: { bank_name: string | null; bic: string | null }
  amount: number
  currency: string
  requested_execution_date: string
  /** The day asked for when it was no banking day the bank takes. */
  date_moved_from: string | null
  /** The next charge Skatteverket draws and what the skattekonto lacks for it; null when nothing is due. */
  due: { date: string; charge: number; balance: number | null; amount: number } | null
  payee: { type: 'bankgiro'; label: string; name: string }
  reference: { type: 'ocr'; value: string }
  warnings: SkattekontoPaymentWarning[]
  /** A skattekonto draft nobody approved that this payment replaces. */
  replaces_drafts: number
  /** The declaration paid, when the payment is named from one (or pays the one declaration due on the day). */
  source: SkattekontoPaymentSourceDue | null
  /** With source due_date: what the payment consists of, and the declarations due that day left out. */
  combined?: {
    due_date: string
    total: number
    components: SkattekontoDueDatePart[]
    excluded: Array<{
      source: 'vat_declaration' | 'agi'
      period: string
      declared: number
      reason: 'refund' | 'zero' | 'already_paid' | 'period_not_ended'
    }>
  }
  /** With a declaration: the saldo Skatteverket last reported, as information (never netted). */
  balance: { saldo: number; fetched_at: string | null } | null
}

export interface PreparedSkattekontoPayment {
  order: PaymentOrder
  warnings: SkattekontoPaymentWarning[]
  replaced_draft_ids: string[]
}

interface SkattekontoPaymentInput {
  cashAccountId: string
  amount: number | null
  executionDate: string | null
  /** The declaration paid; omitted, the next charge on the synced skattekonto. */
  source?: SkattekontoPaymentSourceInput | null
}

function skattekontoPaymentBody(input: SkattekontoPaymentInput, dryRun: boolean) {
  return JSON.stringify({
    cash_account_id: input.cashAccountId,
    amount: input.amount,
    execution_date: input.executionDate,
    ...(input.source ?? {}),
    ...(dryRun ? { dry_run: true } : {}),
  })
}

/** The dry run of a payment in to the skattekonto: every rule, nothing written. The dialog's preview. */
export function previewSkattekontoPayment(input: SkattekontoPaymentInput): Promise<SkattekontoPaymentPreview> {
  return send<SkattekontoPaymentPreview>('/api/payments/orders/skattekonto', { method: 'POST', body: skattekontoPaymentBody(input, true) })
}

/** A draft payment in to the skattekonto, to be approved and signed like a supplier payment. */
export function prepareSkattekontoPayment(input: SkattekontoPaymentInput): Promise<PreparedSkattekontoPayment> {
  return send<PreparedSkattekontoPayment>('/api/payments/orders/skattekonto', { method: 'POST', body: skattekontoPaymentBody(input, false) })
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

/** The Nordea Corporate Netbank logon id for a signing body, only when one was typed. */
export function psuAuthoriserBody(psuAuthoriserId: string | null | undefined): { psu_authoriser_id?: string } {
  return psuAuthoriserId ? { psu_authoriser_id: psuAuthoriserId } : {}
}

export function startSigning(input: { orderIds: string[]; method: SigningMethod; personalNumber: string | null; psuAuthoriserId?: string | null }): Promise<SigningView> {
  return send<SigningView>('/api/payments/signing', {
    method: 'POST',
    body: JSON.stringify({ order_ids: input.orderIds, method: input.method, personal_number: input.personalNumber, ...psuAuthoriserBody(input.psuAuthoriserId) }),
  })
}

export function restartSigning(input: { batchId: string; method: SigningMethod; personalNumber: string | null; psuAuthoriserId?: string | null }): Promise<SigningView> {
  return send<SigningView>(`/api/payments/signing/${input.batchId}/restart`, {
    method: 'POST',
    body: JSON.stringify({ method: input.method, personal_number: input.personalNumber, ...psuAuthoriserBody(input.psuAuthoriserId) }),
  })
}

export function pollSigning(input: { batchId: string; personalNumber: string | null; psuAuthoriserId?: string | null }, signal?: AbortSignal): Promise<SigningView> {
  return send<SigningView>(`/api/payments/signing/${input.batchId}/poll`, {
    method: 'POST',
    body: JSON.stringify({ personal_number: input.personalNumber, ...psuAuthoriserBody(input.psuAuthoriserId) }),
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
