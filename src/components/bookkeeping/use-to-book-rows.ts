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
} from '@/lib/bookkeeping/to-book'

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
  const bank = useSWR(enabled ? BANK_ROWS_KEY : null, readBankRows, options)
  const docs = useSWR(enabled ? DOCUMENTS_KEY : null, readDocuments, options)
  const skv = useSWR(enabled ? SKATTEKONTO_KEY : null, readSkattekonto, options)
  const skattekonto = skv.data ?? NO_SKATTEKONTO
  const rows = useMemo(
    () =>
      buildToBookRows(
        bank.data ?? [],
        docs.data ?? [],
        skattekonto.rows.map((r) => ({ id: r.id, date: r.transaktionsdatum, text: r.transaktionstext, amount: r.belopp_skatteverket })),
      ),
    [bank.data, docs.data, skattekonto.rows],
  )
  return {
    rows,
    skattekonto,
    loading: enabled && ((!bank.data && !bank.error) || (!docs.data && !docs.error) || (!skv.data && !skv.error)),
    failed: Boolean(bank.error || docs.error || skv.error),
    retry: () => Promise.all([bank.mutate(), docs.mutate(), skv.mutate()]),
    refreshBankRows: () => bank.mutate(),
    refreshSkattekonto: () => skv.mutate(),
  }
}
