/**
 * Kvittojakten for a connected agent: what is missing an underlag, shaped so
 * an agent with its own mail connector can go and find it.
 *
 * The built-in hunt (hunt.ts) searches the mailbox Accounted is connected to.
 * This is the other engine for the same job: the user's own agent (Claude,
 * ChatGPT, Grok) searches through ITS mail connector, and this module only
 * tells it what to look for. Nothing here reads mail or writes anything.
 *
 * Two sources, one list:
 *  - posted verifikat without underlag (the verifikat_without_documents RPC,
 *    the same truth as the Att göra row), enriched with the supplier invoice
 *    or bank transaction behind the verifikat so there is a name to search on;
 *  - unbooked purchases without a receipt (the built-in hunt's own candidate
 *    predicate, so the two engines never disagree about what is missing).
 *
 * A supplier invoice without a document is not a third source: it surfaces as
 * its registration verifikat, which is where its underlag has to land.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { fetchCandidateTransactions } from './hunt'
import { lookupPortal } from './portal-directory'
import { FETCH_DATE_WINDOW_DAYS, canHaveEmailReceipt } from './select'

export type AgentWorklistKind = 'verifikat' | 'transaction'

export interface AgentWorklistItem {
  kind: AgentWorklistKind
  /** Set for kind 'verifikat': the target of gnubok_link_document_to_voucher. */
  journal_entry_id: string | null
  /** Set for kind 'transaction': the target of gnubok_attach_document_to_transaction. */
  transaction_id: string | null
  /** "A217" for a verifikat, null for an unbooked transaction. */
  voucher: string | null
  date: string
  /** Positive, in `currency`. */
  amount: number
  currency: string
  /** Best available name to search mail for; null when only `description` exists. */
  counterparty: string | null
  description: string | null
  /** Supplier's own invoice number when the verifikat registers a supplier invoice. */
  invoice_number: string | null
  /** Mail is worth searching from `search_from` to `search_to` (inclusive). */
  search_from: string
  search_to: string
  /**
   * False for rows that never have a mailed receipt (salary, tax, bank fees):
   * the agent skips the mail search and reports them as needing a human.
   */
  mail_searchable: boolean
  /** Where the invoice lives when the vendor does not mail it. */
  portal: { vendor: string; url: string; note: string | null } | null
}

export interface AgentWorklist {
  items: AgentWorklistItem[]
  total_count: number
  /** The company's inbox address: mail forwarded here becomes an inbox document. Null when not provisioned. */
  inbox_address: string | null
}

/** Verifikat already carrying a staged or settled link are not asked about twice. */
const CLAIMED_STATUSES = ['pending', 'committing', 'committed'] as const
const LINK_OPERATION_TYPES = [
  'link_document_to_voucher',
  'link_documents_to_vouchers',
  'attach_document_to_transaction',
] as const
const LOOKUP_CHUNK = 150
const MAX_ITEMS = 100

interface VerifikatRow {
  journal_entry_id: string
  voucher_series: string | null
  voucher_number: number
  entry_date: string
  description: string
  source_type: string
  gross_amount: number
}

function shiftDate(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function withSearchHints(
  base: Omit<AgentWorklistItem, 'search_from' | 'search_to' | 'mail_searchable' | 'portal'>,
): AgentWorklistItem {
  const descriptor = base.counterparty ?? base.description
  const portal = lookupPortal(descriptor)
  return {
    ...base,
    search_from: shiftDate(base.date, -FETCH_DATE_WINDOW_DAYS),
    search_to: shiftDate(base.date, FETCH_DATE_WINDOW_DAYS),
    mail_searchable: canHaveEmailReceipt(descriptor),
    portal: portal ? { vendor: portal.vendor, url: portal.url, note: portal.note ?? null } : null,
  }
}

async function fetchClaimedTargets(supabase: SupabaseClient, companyId: string) {
  const rows = await fetchAllRows<{
    params: {
      journal_entry_id?: string
      transaction_id?: string
      /** link_documents_to_vouchers: N links staged as one operation. */
      links?: { journal_entry_id?: string }[]
    } | null
  }>((range) =>
    supabase
      .from('pending_operations')
      .select('params')
      .eq('company_id', companyId)
      .in('operation_type', [...LINK_OPERATION_TYPES])
      .in('status', [...CLAIMED_STATUSES])
      .order('id', { ascending: true })
      .range(range.from, range.to),
  )
  const journalEntryIds = new Set<string>()
  const transactionIds = new Set<string>()
  for (const row of rows) {
    if (row.params?.journal_entry_id) journalEntryIds.add(row.params.journal_entry_id)
    if (row.params?.transaction_id) transactionIds.add(row.params.transaction_id)
    for (const link of row.params?.links ?? []) {
      if (link.journal_entry_id) journalEntryIds.add(link.journal_entry_id)
    }
  }
  return { journalEntryIds, transactionIds }
}

async function fetchInboxAddress(supabase: SupabaseClient, companyId: string): Promise<string | null> {
  const domain = process.env.RESEND_INBOUND_DOMAIN
  if (!domain) return null
  const { data, error } = await supabase
    .from('company_inboxes')
    .select('local_part')
    .eq('company_id', companyId)
    .eq('status', 'active')
    .maybeSingle()
  if (error || !data) return null
  return `${(data as { local_part: string }).local_part}@${domain}`
}

interface VerifikatContext {
  counterparty: string | null
  invoice_number: string | null
  amount: number | null
  currency: string | null
}

/** Who the verifikat is about: the supplier invoice it registers, else the bank row it books. */
async function fetchVerifikatContext(
  supabase: SupabaseClient,
  companyId: string,
  journalEntryIds: string[],
): Promise<Map<string, VerifikatContext>> {
  const context = new Map<string, VerifikatContext>()
  for (let i = 0; i < journalEntryIds.length; i += LOOKUP_CHUNK) {
    const chunk = journalEntryIds.slice(i, i + LOOKUP_CHUNK)
    const [siRes, txRes] = await Promise.all([
      supabase
        .from('supplier_invoices')
        .select('registration_journal_entry_id, supplier_invoice_number, total, currency, supplier:suppliers(name)')
        .eq('company_id', companyId)
        .in('registration_journal_entry_id', chunk),
      supabase
        .from('transactions')
        .select('journal_entry_id, merchant_name, amount, currency')
        .eq('company_id', companyId)
        .in('journal_entry_id', chunk),
    ])
    if (siRes.error) throw new Error(`supplier_invoices lookup failed: ${siRes.error.message}`)
    if (txRes.error) throw new Error(`transactions lookup failed: ${txRes.error.message}`)

    // Bank rows first so a supplier invoice, which names the supplier and the
    // invoice number, overwrites the thinner bank descriptor.
    for (const r of (txRes.data ?? []) as {
      journal_entry_id: string
      merchant_name: string | null
      amount: number
      currency: string | null
    }[]) {
      context.set(r.journal_entry_id, {
        counterparty: r.merchant_name,
        invoice_number: null,
        amount: Math.abs(r.amount),
        currency: r.currency,
      })
    }
    for (const r of (siRes.data ?? []) as unknown as {
      registration_journal_entry_id: string
      supplier_invoice_number: string | null
      total: number
      currency: string | null
      supplier: { name: string | null } | null
    }[]) {
      context.set(r.registration_journal_entry_id, {
        counterparty: r.supplier?.name ?? null,
        invoice_number: r.supplier_invoice_number,
        amount: r.total,
        currency: r.currency,
      })
    }
  }
  return context
}

/**
 * The agent's worklist, largest amount first: the biggest gaps in the
 * räkenskapsinformation are the ones worth a mail search first, and the
 * built-in hunt drains its queue in the same order.
 */
export async function resolveAgentWorklist(
  supabase: SupabaseClient,
  companyId: string,
  opts: { limit?: number; since?: string | null } = {},
): Promise<AgentWorklist> {
  const limit = Math.min(Math.max(1, opts.limit ?? 25), MAX_ITEMS)
  const since = opts.since ?? null

  const [verifikatRes, transactions, claimed, inboxAddress] = await Promise.all([
    supabase.rpc('verifikat_without_documents', {
      p_company_id: companyId,
      p_since: since,
      p_min_amount: 0,
      p_limit: MAX_ITEMS,
      p_offset: 0,
    }),
    fetchCandidateTransactions(supabase, companyId),
    fetchClaimedTargets(supabase, companyId),
    fetchInboxAddress(supabase, companyId),
  ])
  if (verifikatRes.error) throw new Error(`verifikat_without_documents failed: ${verifikatRes.error.message}`)
  const verifikatResult = verifikatRes.data as {
    ok?: boolean
    code?: string
    total_count?: number
    verifikat?: VerifikatRow[]
  } | null
  if (!verifikatResult?.ok) {
    throw new Error(`verifikat_without_documents failed: ${verifikatResult?.code ?? 'unknown error'}`)
  }

  const verifikat = (verifikatResult.verifikat ?? []).filter(
    (v) => !claimed.journalEntryIds.has(v.journal_entry_id),
  )
  const context = await fetchVerifikatContext(
    supabase,
    companyId,
    verifikat.map((v) => v.journal_entry_id),
  )

  // Ranked on the SEK value: `amount` is in the row's own currency, and a
  // USD 90 subscription must not sort under a 100 kr parking receipt.
  const ranked: { item: AgentWorklistItem; sek: number }[] = []
  for (const v of verifikat) {
    const ctx = context.get(v.journal_entry_id)
    ranked.push({
      sek: v.gross_amount,
      item: withSearchHints({
        kind: 'verifikat',
        journal_entry_id: v.journal_entry_id,
        transaction_id: null,
        voucher: v.voucher_series ? `${v.voucher_series}${v.voucher_number}` : String(v.voucher_number),
        date: v.entry_date,
        amount: ctx?.amount ?? v.gross_amount,
        currency: ctx?.currency ?? 'SEK',
        counterparty: ctx?.counterparty ?? null,
        description: v.description,
        invoice_number: ctx?.invoice_number ?? null,
      }),
    })
  }
  for (const tx of transactions) {
    if (claimed.transactionIds.has(tx.id)) continue
    if (!tx.date || tx.amount == null) continue
    if (since && tx.date < since) continue
    ranked.push({
      sek: Math.abs(tx.amount_sek ?? tx.amount),
      item: withSearchHints({
        kind: 'transaction',
        journal_entry_id: null,
        transaction_id: tx.id,
        voucher: null,
        date: tx.date,
        amount: Math.abs(tx.amount),
        currency: tx.currency ?? 'SEK',
        counterparty: tx.merchant_name ?? null,
        description: tx.description ?? null,
        invoice_number: null,
      }),
    })
  }

  ranked.sort((a, b) => b.sek - a.sek)
  return {
    items: ranked.slice(0, limit).map((r) => r.item),
    // The verifikat total comes from the RPC (it may exceed the page fetched
    // here); claimed rows inside that page are subtracted so the number
    // matches what the agent can actually work on.
    total_count:
      (verifikatResult.total_count ?? 0) -
      ((verifikatResult.verifikat ?? []).length - verifikat.length) +
      ranked.filter((r) => r.item.kind === 'transaction').length,
    inbox_address: inboxAddress,
  }
}
