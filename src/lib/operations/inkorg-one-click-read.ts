/**
 * What the one-click planner (./inkorg-one-click.ts) needs for one inbox item, read
 * from the company's books: the item and its reading, the bank row it was
 * paid by (the row it is linked to, else the live arrival match), what the
 * company has switched on and how it books, the purchase category, the
 * supplier card, and the account the company has booked the counterparty
 * on. Every read filters by company (service-role doors have no RLS).
 *
 * Read only: an item the bank was never checked for is planned without a
 * row (the item's detail read checks it, and the page plans after that
 * read). A read that fails where the plan can do without it (the category,
 * the counterparty's account, the package switches) is logged and left out,
 * which the planner answers by asking or by opening the editor.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import type { InvoiceExtractionResult, Transaction } from '@/types'
import { resolveInboxKind } from '@/lib/documents/inbox-kind'
import { readInboxBankMatch, type BankMatchItemRow } from '@/lib/documents/inbox-bank-match'
import { resolveSekAmountOrNull } from '@/lib/bookkeeping/currency-utils'
import { resolveSettlementAccount } from '@/lib/bookkeeping/settlement-account'
import { findCounterpartyTemplate } from '@/lib/bookkeeping/counterparty-templates'
import { readDirectBookingSettings } from '@/lib/transactions/direct-booking-settings'
import { resolveInboxPurchaseCategories, templatePurchaseAccount } from '@/lib/categories/inbox-purchase-category'
import type { PurchaseCategoryCode } from '@/lib/categories/purchase-categories'
import { loadCompanyCapabilities } from '@/lib/modules/capabilities'
import { matchSupplierByIdentity, supplierIdentityFrom } from '@/lib/suppliers/match-supplier'
import type { SellerRegion } from '@/lib/vat/seller-country'
import type { PairableRow } from '@/lib/inkorg/pairs-read'
import { inkorgCompany } from '@/lib/inkorg/startable'
import { ISO_DATE_RE } from '@/lib/invariants/iso-date'
import { readInboxPairings } from './inbox-pairings'
import type { OneClickBankRow, OneClickInput, OneClickSupplier } from './inkorg-one-click'

/** What a person answered on the page: request parameters, never stored. */
export interface OneClickAnswers {
  purchaseCategory?: PurchaseCategoryCode | null
  sellerRegion?: SellerRegion | null
}

/** The item as the book door acts on it. */
export interface OneClickItem {
  id: string
  documentId: string | null
  matchedSupplierId: string | null
  /** The verifikat text: the supplier as read, else the mail's subject. */
  description: string
  reading: InvoiceExtractionResult | null
}

export type OneClickRead =
  | { ok: true; input: OneClickInput; item: OneClickItem }
  | { ok: false; code: 'INBOX_ITEM_NOT_FOUND' | 'INBOX_ITEM_ALREADY_BOOKED' | 'INBOX_ITEM_ALREADY_CONVERTED'; details?: Record<string, unknown> }

type ItemRow = PairableRow &
  BankMatchItemRow & {
    matched_supplier_id: string | null
    email_subject: string | null
    extracted_data: InvoiceExtractionResult | null
  }

type TransactionRow = Pick<Transaction, 'id' | 'date' | 'amount' | 'currency' | 'amount_sek' | 'exchange_rate' | 'cash_account_id' | 'journal_entry_id' | 'description' | 'merchant_name'>

function isoDate(value: unknown): string | null {
  return typeof value === 'string' && ISO_DATE_RE.test(value.slice(0, 10)) ? value.slice(0, 10) : null
}

async function readTransaction(supabase: SupabaseClient, companyId: string, id: string): Promise<TransactionRow | null> {
  const { data, error } = await supabase
    .from('transactions')
    .select('id, date, amount, currency, amount_sek, exchange_rate, cash_account_id, journal_entry_id, description, merchant_name')
    .eq('id', id)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw error
  return (data as TransactionRow | null) ?? null
}

async function readSupplier(supabase: SupabaseClient, companyId: string, id: string): Promise<OneClickSupplier | null> {
  const { data, error } = await supabase
    .from('suppliers')
    .select('id, supplier_type, default_expense_account, default_payment_terms, archived_at')
    .eq('id', id)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw error
  const row = data as { id: string; supplier_type: string | null; default_expense_account: string | null; default_payment_terms: number | null; archived_at: string | null } | null
  if (!row || row.archived_at) return null
  return {
    id: row.id,
    supplierType: row.supplier_type ?? null,
    defaultExpenseAccount: row.default_expense_account ?? null,
    paymentTermsDays:
      typeof row.default_payment_terms === 'number' && Number.isInteger(row.default_payment_terms) && row.default_payment_terms >= 0
        ? row.default_payment_terms
        : null,
  }
}

/** A failed hint read is logged and left out; the plan does without it. */
async function hint<T>(log: Logger, what: string, read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read()
  } catch (error) {
    log.warn(`one-click plan: ${what} could not be read`, { error: error instanceof Error ? error.message : String(error) })
    return fallback
  }
}

export async function readOneClickInput(
  supabase: SupabaseClient,
  companyId: string,
  itemId: string,
  answers: OneClickAnswers,
  log: Logger,
): Promise<OneClickRead> {
  const { data, error } = await supabase
    .from('invoice_inbox_items')
    .select('id, status, source, document_id, resend_email_id, channel_context, kind_hint, extracted_data, routed_to_arkiv_at, matched_supplier_id, matched_transaction_id, created_supplier_invoice_id, created_journal_entry_id, bank_match_transaction_id, bank_match_basis, bank_match_evidence_level, bank_match_source_key, email_subject')
    .eq('id', itemId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw error
  const row = data as ItemRow | null
  if (!row) return { ok: false, code: 'INBOX_ITEM_NOT_FOUND' }
  if (row.created_supplier_invoice_id) {
    return { ok: false, code: 'INBOX_ITEM_ALREADY_CONVERTED', details: { supplier_invoice_id: row.created_supplier_invoice_id } }
  }
  if (row.created_journal_entry_id) return { ok: false, code: 'INBOX_ITEM_ALREADY_BOOKED', details: { inbox_item_id: itemId } }

  // The document's reading stands in when the item has none, as on every read.
  let reading = row.extracted_data
  if (!reading && row.document_id) {
    const { data: doc } = await supabase
      .from('document_attachments')
      .select('id, extracted_data')
      .eq('id', row.document_id)
      .eq('company_id', companyId)
      .maybeSingle()
    reading = ((doc as { extracted_data?: InvoiceExtractionResult | null } | null)?.extracted_data ?? null) as InvoiceExtractionResult | null
  }
  const kind = resolveInboxKind({ kind_hint: row.kind_hint ?? null, extracted_data: reading })

  // The bank row: the one it is linked to, else the arrival match that still stands.
  let transaction: TransactionRow | null = null
  let source: OneClickBankRow['source'] = 'proposal'
  if (row.matched_transaction_id) {
    transaction = await readTransaction(supabase, companyId, row.matched_transaction_id)
    source = 'matched'
    // A linked row booked since is the item's booking already: nothing to book with it.
    if (transaction?.journal_entry_id) return { ok: false, code: 'INBOX_ITEM_ALREADY_BOOKED', details: { inbox_item_id: itemId } }
  } else {
    const proposal = await hint(log, 'the arrival match', () => readInboxBankMatch(supabase, companyId, row), null)
    if (proposal) transaction = await readTransaction(supabase, companyId, proposal.transaction_id)
  }
  let bank: OneClickBankRow | null = null
  if (transaction) {
    bank = {
      transactionId: transaction.id,
      date: transaction.date,
      amountSek: resolveSekAmountOrNull(Number(transaction.amount), transaction.amount_sek, transaction.currency, transaction.exchange_rate),
      settlementAccount: await resolveSettlementAccount(supabase, companyId, transaction.cash_account_id, log, transaction.currency),
      source,
    }
  }

  // The invoice its receipt from the same arrival says is paid, and that receipt's date.
  const pairing = await hint(
    log,
    'the pairing',
    async () => (await readInboxPairings(supabase, companyId, [row], { readDeliveries: true })).get(row.id) ?? null,
    null,
  )
  const paidByReceipt = pairing?.role === 'invoice' && kind === 'supplier_invoice'
  let receiptDate: string | null = null
  if (pairing?.role === 'invoice') {
    const { data: receipt } = await supabase
      .from('invoice_inbox_items')
      .select('id, extracted_data')
      .eq('id', pairing.receipt_item_id)
      .eq('company_id', companyId)
      .maybeSingle()
    const receiptReading = (receipt as { extracted_data?: InvoiceExtractionResult | null } | null)?.extracted_data ?? null
    receiptDate = isoDate(receiptReading?.invoice?.invoiceDate)
  }

  const [settingsRes, capabilities, directBooking] = await Promise.all([
    supabase.from('company_settings').select('vat_registered, accounting_method, entity_type').eq('company_id', companyId).maybeSingle(),
    hint(log, 'the package switches', () => loadCompanyCapabilities(supabase, companyId, { obligations: false }), null),
    readDirectBookingSettings(supabase, companyId),
  ])
  if (settingsRes.error) throw settingsRes.error
  const settings = settingsRes.data as { vat_registered: boolean | null; accounting_method: string | null; entity_type: string | null } | null
  const { startable } = inkorgCompany(capabilities, { entityType: settings?.entity_type ?? null, accountingMethod: settings?.accounting_method ?? null })

  // The supplier card: the item's own match, else one found by the reading's identity.
  let supplier: OneClickSupplier | null = row.matched_supplier_id ? await readSupplier(supabase, companyId, row.matched_supplier_id) : null
  if (!supplier && reading?.supplier) {
    const found = await matchSupplierByIdentity(supabase, companyId, supplierIdentityFrom(reading.supplier))
    if (found) supplier = await readSupplier(supabase, companyId, found.supplierId)
  }

  // What was bought: the person's answer, else what the item reads as (their choice, the supplier's instruction, the proposal).
  const category =
    answers.purchaseCategory ??
    (await hint(
      log,
      'the purchase category',
      async () =>
        (await resolveInboxPurchaseCategories(supabase, companyId, [{ id: row.id, extracted_data: reading as Record<string, unknown> | null, matched_supplier_id: supplier?.id ?? row.matched_supplier_id, channel_context: row.channel_context }])).get(row.id)?.code ?? null,
      null,
    ))

  // The account the company has booked this counterparty on: by the bank row's own text, else the supplier's name.
  const supplierName = reading?.supplier?.name?.trim() || null
  // The same match says whether the counterpart's rule always asks for a review.
  const counterpart = await hint(
    log,
    'the counterparty account',
    async (): Promise<{ account: string | null; alwaysReview: boolean } | null> => {
      const probe = transaction
        ? ({ ...transaction } as unknown as Transaction)
        : supplierName
          ? ({ id: 'probe', merchant_name: null, description: supplierName } as unknown as Transaction)
          : null
      if (!probe) return null
      const match = await findCounterpartyTemplate(supabase, companyId, probe)
      // A system default is a guess the company never booked, not its history.
      if (!match || match.confidence < 0.5 || match.template.source === 'sni_default') return null
      return { account: templatePurchaseAccount(match.template), alwaysReview: match.template.always_review === true }
    },
    null,
  )

  return {
    ok: true,
    item: {
      id: row.id,
      documentId: row.document_id ?? null,
      matchedSupplierId: row.matched_supplier_id ?? null,
      description: supplierName ?? row.email_subject?.trim() ?? '',
      reading,
    },
    input: {
      kind,
      reading,
      paidByReceipt,
      receiptDate,
      bank,
      company: {
        vatRegistered: settings?.vat_registered ?? null,
        cashMethod: startable.cashMethod,
        supplierInvoices: startable.supplierInvoices,
      },
      category,
      supplier,
      counterpartyAccount: counterpart?.account ?? null,
      counterpartyAlwaysReview: counterpart?.alwaysReview ?? false,
      directBooking,
      sellerRegionAnswer: answers.sellerRegion ?? null,
      invoiceRate: null,
    },
  }
}
