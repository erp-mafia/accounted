import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import { fetchJunctionLinkedTxIds, fetchUnlinkedGLLines, scopeTransactionsToAccount } from './bank-reconciliation'
import { getSkattekontoReconciliationStatus } from './skattekonto-reconciliation'
import {
  parseAccountKey,
  type ReconciliationItem,
  type ReconciliationItemBucket,
} from './schemas'

/**
 * Item listing for one account, in the page's buckets, paginated with
 * limit/offset (the MCP convention; the v1 door wraps this in its cursor).
 *
 * Skattekonto items come straight from the engine (which already buckets
 * and windows them). Bank items are built from the same sources the bank
 * page uses: the account-scoped transactions for the external side and the
 * unlinked-GL-lines RPC for the ledger side; the bank matcher's proposals are
 * the rows carrying potential_journal_entry_id.
 */

export const DEFAULT_ITEMS_LIMIT = 50
export const MAX_ITEMS_LIMIT = 200

/** Bucket order when no bucket is requested: what to do first, first. */
export const BUCKET_ORDER: readonly ReconciliationItemBucket[] = [
  'proposed',
  'unmatched_external',
  'unmatched_ledger',
  'ignored',
  'upcoming',
  'matched',
]

export interface ListItemsOptions {
  bucket?: ReconciliationItemBucket
  windowFrom?: string | null
  windowTo?: string | null
  limit?: number
  offset?: number
  today?: string
}

export interface ListItemsResult {
  items: ReconciliationItem[]
  count: number
  total_count: number
  has_more: boolean
  next_offset?: number
  /** Unmatched rows dated before windowFrom (never hidden, only counted). */
  older_unmatched_count: number
}

interface CashAccountRow {
  id: string
  ledger_account: string
  currency: string | null
  is_primary: boolean | null
}

interface BankTxRow {
  id: string
  date: string
  description: string | null
  merchant_name: string | null
  amount: number | string
  currency: string
  journal_entry_id: string | null
  potential_journal_entry_id: string | null
  potential_match_method: string | null
  potential_match_confidence: number | string | null
  is_ignored: boolean | null
  reconciliation_method: string | null
}

function clampLimit(limit?: number): number {
  if (!limit || !Number.isFinite(limit) || limit < 1) return DEFAULT_ITEMS_LIMIT
  return Math.min(Math.floor(limit), MAX_ITEMS_LIMIT)
}

function page<T>(all: T[], limit: number, offset: number): ListItemsResult & { items: T[] } {
  const items = all.slice(offset, offset + limit)
  const hasMore = offset + limit < all.length
  return {
    items,
    count: items.length,
    total_count: all.length,
    has_more: hasMore,
    ...(hasMore ? { next_offset: offset + limit } : {}),
    older_unmatched_count: 0,
  } as ListItemsResult & { items: T[] }
}

export async function listAccountItems(
  supabase: SupabaseClient,
  companyId: string,
  accountKey: string,
  options: ListItemsOptions = {},
): Promise<ListItemsResult | null> {
  const parsed = parseAccountKey(accountKey)
  if (!parsed) return null
  const limit = clampLimit(options.limit)
  const offset = Math.max(0, Math.floor(options.offset ?? 0))

  if (parsed.kind === 'skattekonto') {
    const status = await getSkattekontoReconciliationStatus(supabase, companyId, {
      today: options.today,
      windowFrom: options.windowFrom ?? null,
      windowTo: options.windowTo ?? null,
    })
    if (!status) return null
    const all = options.bucket
      ? status.items[options.bucket]
      : BUCKET_ORDER.flatMap((b) => status.items[b])
    return { ...page(all, limit, offset), older_unmatched_count: status.older_unmatched_count }
  }

  if (parsed.kind === 'bank') {
    const { data: account, error } = await supabase
      .from('cash_accounts')
      .select('id, ledger_account, currency, is_primary')
      .eq('company_id', companyId)
      .eq('id', parsed.cashAccountId)
      .maybeSingle<CashAccountRow>()
    if (error) throw new Error(`Kunde inte hämta kassakonto: ${error.message}`)
    if (!account) return null
    const currency = account.currency ?? 'SEK'
    const buckets = options.bucket ? [options.bucket] : [...BUCKET_ORDER]
    const byBucket = new Map<ReconciliationItemBucket, ReconciliationItem[]>()
    const push = (item: ReconciliationItem) => {
      byBucket.set(item.bucket, [...(byBucket.get(item.bucket) ?? []), item])
    }

    const wantsExternal = buckets.some((b) =>
      ['proposed', 'unmatched_external', 'matched', 'ignored'].includes(b),
    )
    if (wantsExternal) {
      let query = supabase
        .from('transactions')
        .select(
          'id, date, description, merchant_name, amount, currency, journal_entry_id, potential_journal_entry_id, potential_match_method, potential_match_confidence, is_ignored, reconciliation_method',
        )
        .eq('company_id', companyId)
      query = scopeTransactionsToAccount(query, account.id, currency, Boolean(account.is_primary))
      if (options.windowFrom) query = query.gte('date', options.windowFrom)
      if (options.windowTo) query = query.lte('date', options.windowTo)
      const { data, error: txError } = await query.order('date', { ascending: false }).order('id', { ascending: true })
      if (txError) throw new Error(`Kunde inte hämta transaktioner: ${txError.message}`)
      const rows = (data ?? []) as BankTxRow[]
      // Rows anchored only through transaction_voucher_links (bulk-book,
      // residual bookings) are matched too; their pointer column is NULL.
      const junctionLinked = await fetchJunctionLinkedTxIds(
        supabase,
        companyId,
        rows.filter((tx) => !tx.journal_entry_id && !tx.is_ignored).map((tx) => tx.id),
      )
      {
        for (const tx of rows) {
          const bucket: ReconciliationItemBucket = tx.is_ignored
            ? 'ignored'
            : tx.journal_entry_id || junctionLinked.has(tx.id)
              ? 'matched'
              : tx.potential_journal_entry_id
                ? 'proposed'
                : 'unmatched_external'
          if (!buckets.includes(bucket)) continue
          push({
            item_id: tx.id,
            item_type: 'transaction',
            side: 'external',
            bucket,
            date: tx.date,
            description: tx.merchant_name || tx.description || '',
            amount: roundOre(Number(tx.amount)),
            currency: tx.currency,
            linked_journal_entry_id: tx.journal_entry_id,
            proposal: tx.potential_journal_entry_id
              ? {
                  journal_entry_id: tx.potential_journal_entry_id,
                  voucher_number: null,
                  voucher_series: null,
                  entry_date: tx.date,
                  description: '',
                  entry_status: 'posted',
                  confidence: Number(tx.potential_match_confidence ?? 0.75),
                  reasons: [tx.potential_match_method ?? 'föreslagen av matcharen'],
                }
              : null,
            actions:
              bucket === 'matched'
                ? ['unmatch']
                : bucket === 'ignored'
                  ? ['unignore']
                  : bucket === 'proposed'
                    ? ['match', 'book', 'ignore']
                    : ['book', 'match', 'ignore'],
          })
        }
      }
    }

    if (buckets.includes('unmatched_ledger')) {
      const lines = await fetchUnlinkedGLLines(
        supabase,
        companyId,
        account.ledger_account,
        options.windowFrom ?? undefined,
        options.windowTo ?? undefined,
      )
      // One item per entry: several 1930 lines of one voucher net, as a link settles the voucher.
      const byEntry = new Map<string, ReconciliationItem>()
      for (const l of lines) {
        const amount = roundOre(Number(l.debit_amount || 0) - Number(l.credit_amount || 0))
        const existing = byEntry.get(l.journal_entry_id)
        if (existing) {
          existing.amount = roundOre(existing.amount + amount)
          continue
        }
        byEntry.set(l.journal_entry_id, {
          item_id: l.journal_entry_id,
          item_type: 'journal_entry',
          side: 'ledger',
          bucket: 'unmatched_ledger',
          date: l.entry_date,
          description: l.entry_description || l.line_description || '',
          amount,
          currency,
          voucher_number: l.voucher_number,
          voucher_series: l.voucher_series,
          entry_status: 'posted',
          actions: ['match', 'review'],
        })
      }
      for (const it of byEntry.values()) push(it)
    }

    const all = buckets.flatMap((b) => byBucket.get(b) ?? [])
    return page(all, limit, offset)
  }

  return null
}
