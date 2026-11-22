'use client'

import { useMemo } from 'react'
import useSWR from 'swr'
import { itemHeadline, queueFor, type InkorgItem } from '@/lib/inkorg/items'
import { buildToBookRows, type ToBookBankRow, type ToBookDocument, type ToBookRow } from '@/lib/bookkeeping/to-book'

/**
 * The inbox rows, as Inkommande reads them (components/inkorg/use-inkorg-data.ts):
 * scope=inbox reads every item and answers the ones still in the inbox, so an
 * old open document is never cut off behind newer booked ones.
 */
const INBOX_ITEMS_URL = '/api/extensions/ext/invoice-inbox/items?scope=inbox'

const BANK_ROWS_KEY = 'to-book:bank-rows'
const DOCUMENTS_KEY = 'to-book:documents'

/** The open bank rows: the read Bankrader's Att bokföra tab makes (open_bank_rows). */
async function readBankRows(): Promise<ToBookBankRow[]> {
  const res = await fetch('/api/transactions?unmatched=true')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = (await res.json()) as { data?: ToBookBankRow[] }
  return json.data ?? []
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
      }
    })
}

export interface ToBookRowsRead {
  rows: ToBookRow[]
  loading: boolean
  failed: boolean
  /** Read both again (the list's Försök igen). */
  retry: () => Promise<unknown>
  /** Read the bank rows again, after one was booked. */
  refreshBankRows: () => Promise<unknown>
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
  const rows = useMemo(() => buildToBookRows(bank.data ?? [], docs.data ?? []), [bank.data, docs.data])
  return {
    rows,
    loading: enabled && ((!bank.data && !bank.error) || (!docs.data && !docs.error)),
    failed: Boolean(bank.error || docs.error),
    retry: () => Promise.all([bank.mutate(), docs.mutate()]),
    refreshBankRows: () => bank.mutate(),
  }
}
