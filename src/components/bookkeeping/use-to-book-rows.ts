'use client'

import { useMemo } from 'react'
import useSWR from 'swr'
import { itemHeadline, queueFor, type InkorgItem } from '@/lib/inkorg/items'
import { resolveInboxKind } from '@/lib/documents/inbox-kind'
import { isOpenSkattekontoRow } from '@/lib/skatteverket/skattekonto-open-rows'
import {
  isSkattekontoLedgerAccount,
  SKATTEKONTO_ACCOUNT_DEFAULT,
  type SkattekontoLedgerAccount,
} from '@/lib/skatteverket/skattekonto-account'
import type { SkattekontoTransactionWithSuggestion } from '@/types/skatteverket'
import {
  buildToBookRows,
  readAllToBookBankRows,
  type ToBookBankPage,
  type ToBookBankRow,
  type ToBookDocument,
  type ToBookRow,
  type ToBookSuggestionSources,
} from '@/lib/bookkeeping/to-book'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { findSalaryRunPayouts } from '@/lib/transactions/salary-run-payouts'
import { createClient } from '@/lib/supabase/client'
import { useCompany } from '@/contexts/CompanyContext'
import { fetchExpensePayoutMatches, fetchPotentialMatches } from '@/components/transactions/potential-matches'

/**
 * The inbox rows, as Inkommande reads them (components/inkorg/use-inkorg-data.ts):
 * scope=inbox reads every item and answers the ones still in the inbox, so an
 * old open document is never cut off behind newer booked ones.
 */
const INBOX_ITEMS_URL = '/api/extensions/ext/invoice-inbox/items?scope=inbox'

const BANK_ROWS_KEY = 'to-book:bank-rows'
const DOCUMENTS_KEY = 'to-book:documents'

/** The open bank rows, every page of them: the read Bankrader's Att bokföra tab makes (open_bank_rows). */
async function readBankRows(): Promise<ToBookBankRow[]> {
  return readAllToBookBankRows(async (after) => {
    const params = new URLSearchParams({ unmatched: 'true' })
    if (after) {
      params.set('after_date', after.after_date)
      params.set('after_id', after.after_id)
    }
    const res = await fetch(`/api/transactions?${params}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as ToBookBankPage
  })
}

/**
 * The documents Inkommande asks a person about, in its Behöver dig queue. A
 * company without the inbox (no extension, no capability) has none: the
 * list then holds the bank rows only.
 */
async function readDocuments(): Promise<ToBookDocument[]> {
  const res = await fetch(INBOX_ITEMS_URL)
  if (res.status === 402 || res.status === 403 || res.status === 404) return []
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = (await res.json()) as { data?: { items?: InkorgItem[] } }
  return queueFor(json.data?.items ?? [], { kind: 'need' })
    .filter((item) => !item.matched_transaction_id)
    .map((item) => {
      const head = itemHeadline(item)
      return {
        id: item.id,
        name: head.name ?? item.email_from?.trim() ?? '',
        date: head.documentDate ?? item.created_at.slice(0, 10),
        amount: head.amount,
        currency: head.amount == null ? null : head.currency,
        bankMatchTransactionId: item.bank_match?.transaction_id ?? null,
        kind: resolveInboxKind({ kind_hint: item.kind_hint ?? null, extracted_data: item.extracted_data }),
      }
    })
}

const SUGGESTIONS_KEY = 'to-book:suggestions'
const LEDGER_EXPLAINED_KEY = 'to-book:ledger-explained'
const NO_SUGGESTIONS: ToBookSuggestionSources = {}
const NO_ROWS_EXPLAINED: ReadonlySet<string> = new Set()

/** A short stand-in for the rows a read was made for, so the suggestions are read again when the rows change. */
function rowsSignature(rows: readonly ToBookBankRow[]): string {
  let hash = 5381
  for (const row of rows) {
    for (let i = 0; i < row.id.length; i++) hash = ((hash << 5) + hash + row.id.charCodeAt(i)) | 0
  }
  return `${rows.length}:${hash}`
}

/** An advisory read: a failure is logged and answers null, so its rows show no suggestion. */
async function advisory<T>(what: string, read: Promise<T>): Promise<T | null> {
  try {
    return await read
  } catch (error) {
    console.error(`[to-book] ${what} read failed`, error)
    return null
  }
}

/**
 * What the product already has a match for among the open bank rows: the
 * reads Bankrader makes for its own rows (components/transactions/
 * potential-matches.ts, lib/transactions/salary-run-payouts.ts). Each is
 * advisory: one that fails leaves its rows without a suggestion, as on
 * Bankrader, and never fails the list.
 */
async function readSuggestions(companyId: string, rows: readonly ToBookBankRow[]): Promise<ToBookSuggestionSources> {
  if (rows.length === 0) return NO_SUGGESTIONS
  const supabase = createClient()
  const asked = rows.map((r) => ({
    id: r.id,
    date: r.date,
    amount: r.amount,
    currency: r.currency,
    description: r.description,
    merchant_name: r.merchant_name ?? null,
    is_business: r.is_business ?? null,
    journal_entry_id: r.journal_entry_id ?? null,
    is_ignored: r.is_ignored ?? false,
    cash_account_id: r.cash_account_id,
    // A row already matched to an invoice is not suggested one again.
    potential_invoice_id: r.invoice_id ? null : (r.potential_invoice_id ?? null),
    potential_supplier_invoice_id: r.supplier_invoice_id ? null : (r.potential_supplier_invoice_id ?? null),
    potential_rot_rut_payout_request_id: r.potential_rot_rut_payout_request_id ?? null,
    potential_journal_entry_id: r.potential_journal_entry_id ?? null,
  }))
  const [matches, expenses, salary] = await Promise.all([
    advisory('potential matches', fetchPotentialMatches(supabase, companyId, asked)),
    advisory('expense payouts', fetchExpensePayoutMatches(supabase, companyId, asked)),
    advisory('salary run payouts', findSalaryRunPayouts(supabase, companyId, asked)),
  ])

  const invoices = new Map<string, { number: string | null }>()
  const supplierInvoices = new Map<string, { number: string | null }>()
  const vouchers = new Map<string, { journalEntryId: string; voucher: string }>()
  const rotRut = new Set<string>()
  if (matches) {
    for (const row of asked) {
      const invoice = row.potential_invoice_id ? matches.invoiceMap[row.potential_invoice_id] : undefined
      if (invoice) invoices.set(row.id, { number: invoice.invoice_number ?? null })
      const supplierInvoice = row.potential_supplier_invoice_id
        ? matches.supplierInvoiceMap[row.potential_supplier_invoice_id]
        : undefined
      if (supplierInvoice) supplierInvoices.set(row.id, { number: supplierInvoice.supplier_invoice_number ?? null })
      const voucher = row.potential_journal_entry_id ? matches.voucherMap[row.potential_journal_entry_id] : undefined
      if (voucher) vouchers.set(row.id, { journalEntryId: voucher.journal_entry_id, voucher: formatVoucher(voucher) })
      if (matches.rotRutByTransaction.has(row.id)) rotRut.add(row.id)
    }
  }
  const expensePayouts = new Map<string, { name: string | null }>()
  for (const [id, person] of expenses?.byTransaction ?? []) expensePayouts.set(id, { name: person.claimant_name })
  const salaryRuns = new Map<string, { journalEntryId: string; period: string }>()
  for (const row of asked) {
    const payout = salary?.links.get(row.id)
    // Only a row with a cash account: the match names the bank account (as on Bankrader).
    if (payout && row.cash_account_id) salaryRuns.set(row.id, { journalEntryId: payout.journal_entry_id, period: payout.period })
  }
  return { invoices, supplierInvoices, rotRut, expensePayouts, salary: salaryRuns, vouchers }
}

/**
 * The open rows the ledger already explains (verifikat from the imported
 * bookkeeping that add up to the row): the read behind Bankrader's "från
 * perioden före din migrering" marker. Advisory, so a failed read is no rows.
 */
async function readLedgerExplained(): Promise<ReadonlySet<string>> {
  const explained = await advisory(
    'ledger coverage',
    (async () => {
      const res = await fetch('/api/transactions/migration-coverage')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as { data?: { explained_ids?: string[] } }
      return new Set(json.data?.explained_ids ?? [])
    })(),
  )
  return explained ?? NO_ROWS_EXPLAINED
}

/** The skattekonto events to book, whole, for the booking dialog the list opens them in. */
export interface ToBookSkattekonto {
  rows: SkattekontoTransactionWithSuggestion[]
  /** The company's skattekonto account (1630, or 2012 for an enskild firma that runs it there). */
  account: SkattekontoLedgerAccount
}

const SKATTEKONTO_KEY = 'to-book:skattekonto'
const NO_SKATTEKONTO: ToBookSkattekonto = { rows: [], account: SKATTEKONTO_ACCOUNT_DEFAULT }

/**
 * The open skattekonto events: the read Bankrader's skattekonto rows make,
 * narrowed to open work (isOpenSkattekontoRow, with the opening balance the
 * read answers). A company without the Skatteverket connection has none.
 */
async function readSkattekonto(): Promise<ToBookSkattekonto> {
  const res = await fetch('/api/extensions/ext/skatteverket/skattekonto/transaktioner')
  if (res.status === 402 || res.status === 403 || res.status === 404) return NO_SKATTEKONTO
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = (await res.json()) as {
    data?: { booked?: SkattekontoTransactionWithSuggestion[]; skattekonto_account?: unknown; opening_balance_date?: unknown }
  }
  const openingDate = typeof json.data?.opening_balance_date === 'string' ? json.data.opening_balance_date : null
  return {
    rows: (json.data?.booked ?? []).filter((r) => isOpenSkattekontoRow(r, openingDate)),
    account: isSkattekontoLedgerAccount(json.data?.skattekonto_account) ? json.data.skattekonto_account : SKATTEKONTO_ACCOUNT_DEFAULT,
  }
}

export interface ToBookRowsRead {
  rows: ToBookRow[]
  /** The skattekonto events behind the skattekonto rows. */
  skattekonto: ToBookSkattekonto
  loading: boolean
  failed: boolean
  /** Read both again (the list's Försök igen). */
  retry: () => Promise<unknown>
  /** Read the bank rows again, after one was booked. */
  refreshBankRows: () => Promise<unknown>
  /** Read the skattekonto events again, after one was booked, linked or ignored. */
  refreshSkattekonto: () => Promise<unknown>
}

/** Read only when nothing is cached: the booking screen steps through rows the list already read. */
const CACHED_ONLY = { revalidateIfStale: false, revalidateOnFocus: false, revalidateOnReconnect: false } as const

/**
 * Att bokföra's rows (lib/bookkeeping/to-book.ts), read once and shared: the
 * list and the booking screen it opens read the same cache, so stepping to
 * the next row needs no new read (`cachedOnly`; the screen reads the bank
 * rows again after a booking). `enabled: false` reads nothing.
 */
export function useToBookRows({ enabled = true, cachedOnly = false }: { enabled?: boolean; cachedOnly?: boolean } = {}): ToBookRowsRead {
  const options = cachedOnly ? CACHED_ONLY : undefined
  const companyId = useCompany().company?.id ?? null
  const bank = useSWR(enabled ? BANK_ROWS_KEY : null, readBankRows, options)
  const docs = useSWR(enabled ? DOCUMENTS_KEY : null, readDocuments, options)
  const skv = useSWR(enabled ? SKATTEKONTO_KEY : null, readSkattekonto, options)
  // The suggestions belong to the bank rows they were read for: read again when those change.
  const bankRows = bank.data
  const signature = useMemo(() => (bankRows ? rowsSignature(bankRows) : null), [bankRows])
  const suggested = useSWR(
    enabled && companyId && bankRows && signature ? [SUGGESTIONS_KEY, companyId, signature] : null,
    () => readSuggestions(companyId as string, bankRows ?? []),
    options,
  )
  const explained = useSWR(enabled ? LEDGER_EXPLAINED_KEY : null, readLedgerExplained, options)
  const skattekonto = skv.data ?? NO_SKATTEKONTO
  const found = suggested.data ?? NO_SUGGESTIONS
  const ledger = explained.data ?? NO_ROWS_EXPLAINED
  const rows = useMemo(
    () =>
      buildToBookRows(
        bankRows ?? [],
        docs.data ?? [],
        skattekonto.rows.map((r) => ({ id: r.id, date: r.transaktionsdatum, text: r.transaktionstext, amount: r.belopp_skatteverket })),
        { ...found, ledger },
      ),
    [bankRows, docs.data, skattekonto.rows, found, ledger],
  )
  // A row opens where its suggestion says, so the list waits for the
  // suggestions of the rows it shows (never for the ledger's own answer,
  // which is the slow one and arrives on the rows when it comes).
  const suggestionsPending = Boolean(companyId && bankRows && bankRows.length > 0 && !suggested.data && !suggested.error)
  return {
    rows,
    skattekonto,
    loading:
      enabled && ((!bank.data && !bank.error) || (!docs.data && !docs.error) || (!skv.data && !skv.error) || suggestionsPending),
    failed: Boolean(bank.error || docs.error || skv.error),
    retry: () => Promise.all([bank.mutate(), docs.mutate(), skv.mutate(), suggested.mutate(), explained.mutate()]),
    refreshBankRows: () => Promise.all([bank.mutate(), explained.mutate()]),
    refreshSkattekonto: () => skv.mutate(),
  }
}
