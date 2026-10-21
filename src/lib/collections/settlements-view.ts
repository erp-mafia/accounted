import type { SupabaseClient } from '@supabase/supabase-js'
import { isAccountNumber } from '@/lib/invariants/account-number'
import { roundOre } from '@/lib/money'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { normalizeCollectedPaymentRow, type CollectedPaymentStatus } from './collected-payment-record'
import { PAYMENT_STATUSES_TO_BOOK, SETTLEMENT_STATUSES_TO_BOOK } from './settlements-ui'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import {
  lineDirection,
  lineIsBooked,
  SETTLEMENT_FEE_ACCOUNT,
  SETTLEMENT_INPUT_VAT_ACCOUNT,
  type SettlementLineAccounts,
  type SettlementLineKind,
} from './settlement-posting'
import {
  findHandBookedPayout,
  loadSettlementLines,
  normalizeSettlementRow,
  previewSettlementVoucher,
  type SettlementLineRow,
  type SettlementStatus,
} from './settlements'

/**
 * What the settlements view and its routes read and the one write a person
 * makes before booking: the account for a payout line the ledger could not
 * place. Server only; every query filters on the company.
 */

export interface SettlementListItem {
  id: string
  providerSettlementRef: string
  paymentDate: string
  amount: number
  currency: string
  status: SettlementStatus
  needsMappingReason: string | null
  journalEntryId: string | null
  bankReference: string | null
  acknowledged: boolean
  /** A person confirmed it is not a duplicate of a voucher booked by hand. */
  duplicateCleared: boolean
  /** Why a person marked it as handled elsewhere (status ignored). */
  ignoredReason: string | null
  /** The payout voucher as the books number it ("C12"), null while not booked. */
  voucher: string | null
}

export interface CollectedPaymentListItem {
  id: string
  caseId: string
  invoiceId: string
  paidAt: string
  capitalPaid: number
  toAgency: number
  status: CollectedPaymentStatus
  reviewReason: string | null
  journalEntryId: string | null
  settlementId: string | null
  invoiceNumber: string | null
  customerName: string | null
  /** The payment's voucher as the books number it, null while not booked. */
  voucher: string | null
}

export interface SettlementsOverview {
  /** The provider's display name (live connection first, else the latest one), null when none is known. */
  provider: string | null
  settlements: SettlementListItem[]
  collectedPayments: CollectedPaymentListItem[]
}

/**
 * How many of the newest payouts and collected payments the view shows
 * beyond the ones waiting for the books: those (the rows Att göra counts)
 * are always all there, however old.
 */
export const SETTLEMENTS_LIST_LIMIT = 200

/** Ids per `.in()` lookup: keeps the request line short however long the list. */
const LOOKUP_CHUNK = 200

function chunks<T>(items: readonly T[], size = LOOKUP_CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** Rows by id, first seen wins, newest first by `dateKey` (then id, for a stable order). */
function mergeNewestFirst(lists: Record<string, unknown>[][], dateKey: string): Record<string, unknown>[] {
  const byId = new Map<string, Record<string, unknown>>()
  for (const list of lists) for (const row of list) if (!byId.has(String(row.id))) byId.set(String(row.id), row)
  return [...byId.values()].sort((a, b) => {
    const da = String(a[dateKey] ?? '')
    const db = String(b[dateKey] ?? '')
    if (da !== db) return da < db ? 1 : -1
    return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0
  })
}

type VoucherNumbers = ReadonlyMap<string, string>

function settlementItem(raw: Record<string, unknown>, vouchers: VoucherNumbers = new Map()): SettlementListItem {
  const row = normalizeSettlementRow(raw)
  return {
    id: row.id,
    providerSettlementRef: row.provider_settlement_ref,
    paymentDate: row.payment_date,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    needsMappingReason: row.needs_mapping_reason,
    journalEntryId: row.journal_entry_id,
    bankReference: row.bank_reference,
    acknowledged: !!row.provider_acknowledged_at,
    duplicateCleared: !!row.duplicate_cleared_at,
    ignoredReason: row.ignored_reason ?? null,
    voucher: row.journal_entry_id ? (vouchers.get(row.journal_entry_id) ?? null) : null,
  }
}

/** Voucher numbers ("C12") of the given journal entries of the company. */
async function loadVoucherNumbers(db: SupabaseClient, companyId: string, ids: readonly (string | null)[]): Promise<VoucherNumbers> {
  const unique = [...new Set(ids.filter((id): id is string => !!id))]
  const numbers = new Map<string, string>()
  for (const part of chunks(unique)) {
    const { data, error } = await db
      .from('journal_entries')
      .select('id, voucher_series, voucher_number')
      .eq('company_id', companyId)
      .in('id', part)
    if (error) throw new Error(`journal_entries lookup failed: ${error.message}`)
    for (const entry of (data ?? []) as { id: string; voucher_series: string | null; voucher_number: number | null }[]) {
      const label = formatVoucher(entry)
      if (label !== '-') numbers.set(entry.id, label)
    }
  }
  return numbers
}

/** Invoice numbers and customer names of the given invoices of the company. */
async function loadInvoiceLabels(
  db: SupabaseClient,
  companyId: string,
  ids: readonly string[],
): Promise<Map<string, { invoiceNumber: string | null; customerName: string | null }>> {
  const unique = [...new Set(ids)]
  const labels = new Map<string, { invoiceNumber: string | null; customerName: string | null }>()
  if (unique.length === 0) return labels
  const invoices: { id: string; invoice_number: string | null; customer_id: string | null }[] = []
  for (const part of chunks(unique)) {
    const { data, error } = await db.from('invoices').select('id, invoice_number, customer_id').eq('company_id', companyId).in('id', part)
    if (error) throw new Error(`invoices lookup failed: ${error.message}`)
    invoices.push(...((data ?? []) as { id: string; invoice_number: string | null; customer_id: string | null }[]))
  }
  const customerIds = [...new Set(invoices.map((i) => i.customer_id).filter((id): id is string => !!id))]
  const names = new Map<string, string>()
  for (const part of chunks(customerIds)) {
    const customers = await db.from('customers').select('id, name').eq('company_id', companyId).in('id', part)
    if (customers.error) throw new Error(`customers lookup failed: ${customers.error.message}`)
    for (const c of (customers.data ?? []) as { id: string; name: string | null }[]) if (c.name) names.set(c.id, c.name)
  }
  for (const invoice of invoices) {
    labels.set(invoice.id, {
      invoiceNumber: invoice.invoice_number ?? null,
      customerName: invoice.customer_id ? (names.get(invoice.customer_id) ?? null) : null,
    })
  }
  return labels
}

/**
 * The provider's display name for the view: the live connection's, else the
 * latest connection's (a payout can arrive after a disconnect), else null.
 */
async function loadProviderName(db: SupabaseClient, companyId: string): Promise<string | null> {
  const { data, error } = await db
    .from('collection_connections')
    .select('display_name, state, created_at')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(10)
  if (error) throw new Error(`collection_connections lookup failed: ${error.message}`)
  const rows = (data ?? []) as { display_name: string | null; state: string }[]
  const live = rows.find((r) => r.state !== 'disconnected' && r.display_name?.trim())
  const name = live?.display_name ?? rows.find((r) => r.display_name?.trim())?.display_name ?? null
  return name?.trim() || null
}

/**
 * The company's payouts and collected payments, newest first: every one
 * still waiting for the books (what Att göra counts, paged so none is cut
 * off), and the newest SETTLEMENTS_LIST_LIMIT of the rest.
 */
export async function loadSettlementsOverview(db: SupabaseClient, companyId: string): Promise<SettlementsOverview> {
  const [settlementsToBook, settlements, collectedToBook, collected] = await Promise.all([
    fetchAllRows<Record<string, unknown>>(({ from, to }) =>
      db
        .from('collection_settlements')
        .select('*')
        .eq('company_id', companyId)
        .in('status', [...SETTLEMENT_STATUSES_TO_BOOK])
        .order('id', { ascending: true })
        .range(from, to),
    ),
    db
      .from('collection_settlements')
      .select('*')
      .eq('company_id', companyId)
      .order('payment_date', { ascending: false })
      .order('provider_settlement_ref', { ascending: false })
      .limit(SETTLEMENTS_LIST_LIMIT),
    fetchAllRows<Record<string, unknown>>(({ from, to }) =>
      db
        .from('collection_collected_payments')
        .select('*')
        .eq('company_id', companyId)
        .in('status', [...PAYMENT_STATUSES_TO_BOOK])
        .order('id', { ascending: true })
        .range(from, to),
    ),
    db
      .from('collection_collected_payments')
      .select('*')
      .eq('company_id', companyId)
      .order('paid_at', { ascending: false })
      .limit(SETTLEMENTS_LIST_LIMIT),
  ])
  if (settlements.error) throw new Error(`collection_settlements lookup failed: ${settlements.error.message}`)
  if (collected.error) throw new Error(`collection_collected_payments lookup failed: ${collected.error.message}`)
  const settlementRows = mergeNewestFirst([settlementsToBook, (settlements.data ?? []) as Record<string, unknown>[]], 'payment_date')
  const collectedRows = mergeNewestFirst([collectedToBook, (collected.data ?? []) as Record<string, unknown>[]], 'paid_at').map(
    normalizeCollectedPaymentRow,
  )
  const [vouchers, invoices, provider] = await Promise.all([
    loadVoucherNumbers(db, companyId, [
      ...settlementRows.map((raw) => (typeof raw.journal_entry_id === 'string' ? raw.journal_entry_id : null)),
      ...collectedRows.map((row) => row.journal_entry_id),
    ]),
    loadInvoiceLabels(
      db,
      companyId,
      collectedRows.map((row) => row.invoice_id),
    ),
    loadProviderName(db, companyId),
  ])
  return {
    provider,
    settlements: settlementRows.map((raw) => settlementItem(raw, vouchers)),
    collectedPayments: collectedRows.map((row) => {
      const invoice = invoices.get(row.invoice_id)
      return {
        id: row.id,
        caseId: row.case_id,
        invoiceId: row.invoice_id,
        paidAt: row.paid_at,
        capitalPaid: row.capital_paid,
        toAgency: row.to_agency,
        status: row.status,
        reviewReason: row.review_reason,
        journalEntryId: row.journal_entry_id,
        settlementId: row.settlement_id,
        invoiceNumber: invoice?.invoiceNumber ?? null,
        customerName: invoice?.customerName ?? null,
        voucher: row.journal_entry_id ? (vouchers.get(row.journal_entry_id) ?? null) : null,
      }
    }),
  }
}

export interface SettlementLineItem {
  position: number
  kind: SettlementLineKind
  inPayout: boolean
  recipient: SettlementLineRow['recipient']
  amount: number
  taxAmount: number
  caseId: string | null
  invoiceId: string | null
  originalInvoiceIds: string[]
  providerType: string
  accountNumber: string | null
  vatAccountNumber: string | null
  chosenByPerson: boolean
  booked: boolean
  /**
   * What a person must choose before the payout can book, set only while it
   * waits to be booked or for a person: 'vat' takes 2641 or 6062 (SETTLEMENT_VAT_CHOICES),
   * 'any' an account of the chart; null when the ledger placed the line.
   */
  needsAccount: 'vat' | 'any' | null
  /** The fee line's own VAT needs 2641 or 6062 from a person (the payout has no VAT line of its own). */
  needsVatAccount: boolean
  /** 'credit': adds to the payout (paid to the company); 'debit': deducted from it; null: never booked. */
  direction: 'credit' | 'debit' | null
}

export interface SettlementDetail extends SettlementListItem {
  settlementDate: string | null
  providerStatusOk: boolean
  documentAttachmentId: string | null
  /** For a possible duplicate: the voucher a bank row of the payout already sits on. */
  duplicateOf: { journalEntryId: string; voucher: string | null } | null
  lines: SettlementLineItem[]
  /**
   * The voucher booking it would post now (accounts as recorded or planned),
   * while it waits to be booked and the ledger can place every line; null
   * otherwise. The same planner as the booking (previewSettlementVoucher).
   */
  voucherPreview: { accountNumber: string; debit: number; credit: number }[] | null
  /**
   * The voucher for the person to see before booking, also while it waits
   * only for their account choices: each row's account, or the line and
   * field whose choice fills it (the sheet shows the choice live, and the
   * row as waiting until it is made). Null while anything else holds the
   * payout. The same planner as voucherPreview; the staged operations keep
   * reading voucherPreview.
   */
  voucherDraft: SettlementVoucherDraftRow[] | null
}

export interface SettlementVoucherDraftRow {
  accountNumber: string | null
  waitsFor: { position: number; field: 'account' | 'vatAccount' } | null
  debit: number
  credit: number
}

export async function loadSettlementDetail(db: SupabaseClient, companyId: string, settlementId: string): Promise<SettlementDetail | null> {
  const { data, error } = await db.from('collection_settlements').select('*').eq('company_id', companyId).eq('id', settlementId).maybeSingle()
  if (error) throw new Error(`collection_settlements lookup failed: ${error.message}`)
  if (!data) return null
  const row = normalizeSettlementRow(data as Record<string, unknown>)
  const lines = await loadSettlementLines(db, companyId, settlementId)
  const duplicateEntryId = row.status === 'needs_mapping' && row.needs_mapping_reason === 'possible_duplicate' ? await findHandBookedPayout(db, row) : null
  const vouchers = await loadVoucherNumbers(db, companyId, [row.journal_entry_id, duplicateEntryId])
  const waiting = row.status === 'needs_mapping'
  // Accounts are recorded on the lines at the first booking attempt; until then show where the booking would put them.
  const plan = row.status === 'received' || waiting ? await previewSettlementVoucher({ db }, companyId, settlementId) : null
  const planned = new Map((plan?.lineAccounts ?? []).map((accounts) => [accounts.position, accounts]))
  const hasVatLine = lines.some((line) => line.kind === 'agency_fee_vat' && lineIsBooked({ kind: line.kind, inPayout: line.in_payout }))
  return {
    ...settlementItem(data as Record<string, unknown>, vouchers),
    settlementDate: row.settlement_date,
    providerStatusOk: row.provider_status_ok,
    documentAttachmentId: row.document_attachment_id,
    duplicateOf: duplicateEntryId ? { journalEntryId: duplicateEntryId, voucher: vouchers.get(duplicateEntryId) ?? null } : null,
    lines: lines.map((line) => ({
      position: line.position,
      kind: line.kind,
      inPayout: line.in_payout,
      recipient: line.recipient,
      amount: line.amount,
      taxAmount: line.tax_amount,
      caseId: line.case_id,
      invoiceId: line.invoice_id,
      originalInvoiceIds: line.original_invoice_ids,
      providerType: line.provider_type,
      accountNumber: line.account_number ?? planned.get(line.position)?.account ?? null,
      vatAccountNumber: line.vat_account_number ?? planned.get(line.position)?.vatAccount ?? null,
      chosenByPerson: !!line.account_chosen_by,
      booked: line.booked === true,
      direction: lineIsBooked({ kind: line.kind, inPayout: line.in_payout }) ? lineDirection({ kind: line.kind, recipient: line.recipient }) : null,
      ...lineChoice(line, waiting || (row.status === 'received' && plan !== null), hasVatLine, planned.get(line.position)),
    })),
    voucherPreview: plan?.ok
      ? plan.lines.map((l) => ({ accountNumber: l.account_number, debit: roundOre(l.debit_amount), credit: roundOre(l.credit_amount) }))
      : null,
    voucherDraft: !plan
      ? null
      : plan.ok
        ? plan.lines.map((l) => ({ accountNumber: l.account_number, waitsFor: null, debit: roundOre(l.debit_amount), credit: roundOre(l.credit_amount) }))
        : (plan.draft?.map((row) => ({ accountNumber: row.account, waitsFor: row.waitsFor, debit: roundOre(row.debit), credit: roundOre(row.credit) })) ?? null),
  }
}

/**
 * The choice a line waits for, asked while the payout waits for a person or
 * still waits to be booked. The planner records the account it found on
 * each line at a booking attempt (recordLineAccounts), and before the first
 * attempt the view plans it (planned), so a line entered into the voucher
 * with no account is one a person must place, with their first click.
 */
function lineChoice(
  line: SettlementLineRow,
  ask: boolean,
  hasVatLine: boolean,
  planned: SettlementLineAccounts | undefined,
): Pick<SettlementLineItem, 'needsAccount' | 'needsVatAccount'> {
  if (!ask || !lineIsBooked({ kind: line.kind, inPayout: line.in_payout }) || !CHOOSABLE_KINDS.has(line.kind)) {
    return { needsAccount: null, needsVatAccount: false }
  }
  const account = line.account_number ?? planned?.account ?? null
  const vatAccount = line.vat_account_number ?? planned?.vatAccount ?? null
  const needsAccount = account ? null : line.kind === 'agency_fee_vat' ? 'vat' : 'any'
  const needsVatAccount = VAT_CARRYING_KINDS.has(line.kind) && line.tax_amount !== 0 && !hasVatLine && !vatAccount
  return { needsAccount, needsVatAccount }
}

/** The VAT on the provider's fees books to deductible input VAT or, when it is not deductible, to the fee account. */
export const SETTLEMENT_VAT_CHOICES: readonly string[] = [SETTLEMENT_INPUT_VAT_ACCOUNT, SETTLEMENT_FEE_ACCOUNT]

/** Kinds a person may place on another account; principal always books to the clearing account. */
const CHOOSABLE_KINDS: ReadonlySet<SettlementLineKind> = new Set([
  'interest_to_creditor',
  'fee_to_creditor',
  'cost_refund_to_creditor',
  'agency_commission',
  'agency_fee_vat',
  'fee_charged_to_creditor',
  'court_fee',
  'supplier_invoice_setoff',
  'excess_direct_payment',
  'unknown',
])
const VAT_CARRYING_KINDS: ReadonlySet<SettlementLineKind> = new Set(['agency_commission', 'fee_charged_to_creditor'])

export interface SettlementLineChoice {
  position: number
  accountNumber?: string
  vatAccountNumber?: string
}

export type ChooseLineAccountsResult =
  | { ok: true; changed: number }
  | { ok: false; code: 'COLLECTION_SETTLEMENT_NOT_FOUND' | 'COLLECTION_SETTLEMENT_NOT_BOOKABLE' | 'COLLECTION_SETTLEMENT_LINE_INVALID'; position?: number }

/**
 * Record a person's account for payout lines the ledger could not place
 * (an unknown line, VAT the ledger does not deduct on its own). The VAT on
 * the provider's fees takes 2641 or 6062 only; principal lines always book
 * to the clearing account and lines outside the payout are never booked, so
 * neither takes a choice.
 */
export interface SettlementLinePatch {
  id: string
  position: number
  account: string | null
  vatAccount: string | null
}

/**
 * Check a person's account choices against the payout's lines without
 * writing: the patches to record, or the first refusal. Shared by the
 * booking route and the staged booking's dry run.
 */
export function validateSettlementLineChoices(
  status: SettlementStatus,
  lines: readonly SettlementLineRow[],
  choices: readonly SettlementLineChoice[],
): { ok: true; patches: SettlementLinePatch[] } | Extract<ChooseLineAccountsResult, { ok: false }> {
  if (status !== 'received' && status !== 'needs_mapping') return { ok: false, code: 'COLLECTION_SETTLEMENT_NOT_BOOKABLE' }
  const patches: SettlementLinePatch[] = []
  for (const choice of choices) {
    const line = lines.find((l) => l.position === choice.position)
    const invalid = { ok: false as const, code: 'COLLECTION_SETTLEMENT_LINE_INVALID' as const, position: choice.position }
    if (!line || !CHOOSABLE_KINDS.has(line.kind) || !line.in_payout) return invalid
    if (choice.accountNumber !== undefined) {
      if (!isAccountNumber(choice.accountNumber)) return invalid
      if (line.kind === 'agency_fee_vat' && !SETTLEMENT_VAT_CHOICES.includes(choice.accountNumber)) return invalid
    }
    if (choice.vatAccountNumber !== undefined) {
      if (!VAT_CARRYING_KINDS.has(line.kind) || !SETTLEMENT_VAT_CHOICES.includes(choice.vatAccountNumber)) return invalid
    }
    patches.push({
      id: line.id,
      position: line.position,
      account: choice.accountNumber ?? line.account_number,
      vatAccount: choice.vatAccountNumber ?? line.vat_account_number,
    })
  }
  return { ok: true, patches }
}

export async function chooseSettlementLineAccounts(
  db: SupabaseClient,
  companyId: string,
  settlementId: string,
  userId: string,
  choices: readonly SettlementLineChoice[],
): Promise<ChooseLineAccountsResult> {
  const { data, error } = await db.from('collection_settlements').select('status').eq('company_id', companyId).eq('id', settlementId).maybeSingle()
  if (error) throw new Error(`collection_settlements lookup failed: ${error.message}`)
  if (!data) return { ok: false, code: 'COLLECTION_SETTLEMENT_NOT_FOUND' }
  const status = (data as { status: SettlementStatus }).status
  if (status !== 'received' && status !== 'needs_mapping') return { ok: false, code: 'COLLECTION_SETTLEMENT_NOT_BOOKABLE' }

  const lines = await loadSettlementLines(db, companyId, settlementId)
  const checked = validateSettlementLineChoices(status, lines, choices)
  if (!checked.ok) return checked
  const { patches } = checked
  for (const { id, account, vatAccount } of patches) {
    const { error: updateError } = await db
      .from('collection_settlement_lines')
      .update({ account_number: account, vat_account_number: vatAccount, account_chosen_by: userId })
      .eq('company_id', companyId)
      .eq('id', id)
    if (updateError) throw new Error(`collection_settlement_lines update failed: ${updateError.message}`)
  }
  return { ok: true, changed: patches.length }
}
