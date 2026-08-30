import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events/bus'
import { createLogger } from '@/lib/logger'
import {
  linkSkattekontoRow,
  linkSkattekontoRows,
  setSkattekontoRowIgnored,
  SkattekontoLinkError,
  unlinkSkattekontoRow,
} from '@/lib/skatteverket/skattekonto-link'
import {
  fetchJunctionLinkedTxIds,
  linkTransactionToVouchers,
  manualLink,
  unlinkReconciliation,
} from './bank-reconciliation'
import { getSkattekontoReconciliationStatus } from './skattekonto-reconciliation'
import { parseAccountKey } from './schemas'

const log = createLogger('reconciliation/actions')

/**
 * Write actions of the account-keyed reconciliation surface. Every door (page
 * route, v1, MCP commit executor) calls these; none of them links on its own.
 *
 * Links never touch the ledger: they pair an outside row with an existing
 * verifikat, so they are allowed in locked periods and reversible by
 * unmatch. Bookings (residual postings) are a separate, later action.
 */

export interface ReconciliationPair {
  /** Outside rows: transaction ids (bank) or skattekonto_transaction ids. */
  external_ids: string[]
  journal_entry_ids: string[]
  /**
   * Bank only, for the 1:N shape (one transaction over several verifikat):
   * the signed slice per verifikat, in the transaction's sign convention.
   * Omitted: each slice defaults to the voucher's net line on the account.
   * Either way the slices must sum to the transaction amount.
   */
  allocations?: Array<{ journal_entry_id: string; amount: number }>
}

export type PairSkipCode =
  | 'UNSUPPORTED_PAIR_SHAPE'
  | 'ALREADY_LINKED'
  | 'ENTRY_NOT_FOUND'
  | 'ENTRY_REVERSED'
  | 'PAIR_NOT_CLOSED'
  | 'ROW_IGNORED'
  | 'NOT_FOUND'
  | 'LINK_RACE'
  | 'UNKNOWN'

export interface AppliedLink {
  external_id: string
  journal_entry_id: string
  via?: 'line' | 'entry_total'
  /** Present on the links of a 1:N split: the slice of the row this verifikat settles. */
  allocated_amount?: number
}

export interface SkippedPair {
  pair: ReconciliationPair
  code: PairSkipCode
  message: string
}

export interface MatchPairsInput {
  pairs?: ReconciliationPair[]
  /** Use the persisted proposals (skattekonto) or potential matches (bank) as pairs. */
  use_proposals?: boolean
  /** Only with use_proposals: skip proposals below this confidence. */
  confidence_threshold?: number
}

export interface MatchPairsResult {
  dry_run: boolean
  applied: AppliedLink[]
  skipped: SkippedPair[]
  considered: number
}

function skipCodeFor(err: unknown): { code: PairSkipCode; message: string } {
  if (err instanceof SkattekontoLinkError) {
    const map: Record<string, PairSkipCode> = {
      TRANSACTION_NOT_FOUND: 'NOT_FOUND',
      ALREADY_BOOKED: 'ALREADY_LINKED',
      ROW_IGNORED: 'ROW_IGNORED',
      ENTRY_NOT_FOUND: 'ENTRY_NOT_FOUND',
      ENTRY_ALREADY_LINKED: 'ALREADY_LINKED',
      INVALID_CANDIDATE: 'PAIR_NOT_CLOSED',
      NOT_LINKED: 'UNKNOWN',
      LINK_RACE: 'LINK_RACE',
    }
    return { code: map[err.code] ?? 'UNKNOWN', message: err.message }
  }
  return { code: 'UNKNOWN', message: err instanceof Error ? err.message : String(err) }
}

async function proposalsAsPairs(
  supabase: SupabaseClient,
  companyId: string,
  accountKey: string,
  threshold: number,
): Promise<ReconciliationPair[]> {
  const parsed = parseAccountKey(accountKey)
  if (!parsed) return []
  if (parsed.kind === 'skattekonto') {
    const status = await getSkattekontoReconciliationStatus(supabase, companyId)
    if (!status) return []
    return status.items.proposed
      .filter((i) => i.proposal && i.proposal.confidence >= threshold)
      .map((i) => ({ external_ids: [i.item_id], journal_entry_ids: [i.proposal!.journal_entry_id] }))
  }
  if (parsed.kind === 'bank') {
    const { data } = await supabase
      .from('transactions')
      .select('id, potential_journal_entry_id, potential_match_confidence')
      .eq('company_id', companyId)
      .eq('cash_account_id', parsed.cashAccountId)
      .is('journal_entry_id', null)
      .eq('is_ignored', false)
      .not('potential_journal_entry_id', 'is', null)
    return ((data ?? []) as Array<{ id: string; potential_journal_entry_id: string; potential_match_confidence: number | string | null }>)
      .filter((r) => Number(r.potential_match_confidence ?? 0) >= threshold)
      .map((r) => ({ external_ids: [r.id], journal_entry_ids: [r.potential_journal_entry_id] }))
  }
  return []
}

/**
 * Link pairs on one account. A pair is one OR MANY outside rows against
 * exactly one verifikat (bank: independent links per transaction; skattekonto:
 * all-or-nothing with the sum settling the verifikat), or, on a bank account,
 * ONE transaction against SEVERAL verifikat (1:N, issue #1553): all-or-nothing
 * with the slices summing to the transaction. Any other shape is reported as
 * UNSUPPORTED_PAIR_SHAPE, never silently reduced. Dry run validates shapes and
 * resolves proposals without writing; a 1:N dry run also resolves the slices
 * so a reviewer sees exactly what would be linked.
 * Partial success is first-class: `applied` and `skipped` together cover
 * every considered pair.
 */
export async function matchPairs(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  accountKey: string,
  input: MatchPairsInput,
  options: { dryRun?: boolean } = {},
): Promise<MatchPairsResult | null> {
  const parsed = parseAccountKey(accountKey)
  if (!parsed || parsed.kind === 'manual') return null
  const dryRun = options.dryRun ?? false

  const pairs: ReconciliationPair[] = [...(input.pairs ?? [])]
  if (input.use_proposals) {
    pairs.push(
      ...(await proposalsAsPairs(supabase, companyId, accountKey, input.confidence_threshold ?? 0)),
    )
  }

  const applied: AppliedLink[] = []
  const skipped: SkippedPair[] = []

  const emitMatched = async (externalId: string, journalEntryId: string) => {
    await eventBus.emit({
      type: 'reconciliation.matched',
      payload: {
        accountKey,
        externalId,
        journalEntryId,
        method: input.use_proposals ? 'proposal' : 'manual',
        userId,
        companyId,
      },
    })
  }

  // Resolved once, lazily: only bank pairs need the ledger account.
  let ledgerAccount: string | null = null
  const resolveLedgerAccount = async (): Promise<string> => {
    if (ledgerAccount) return ledgerAccount
    if (parsed.kind !== 'bank') return '1930'
    const { data: account } = await supabase
      .from('cash_accounts')
      .select('ledger_account')
      .eq('company_id', companyId)
      .eq('id', parsed.cashAccountId)
      .maybeSingle<{ ledger_account: string }>()
    ledgerAccount = account?.ledger_account ?? '1930'
    return ledgerAccount
  }

  for (const pair of pairs) {
    // N outside rows may settle ONE verifikat (the worksheet selection). ONE
    // bank transaction may settle SEVERAL verifikat (the split, #1553). A
    // skattekonto row never splits (Skatteverket posts each event as its own
    // row), and N:M is refused loudly, never silently reduced.
    if (pair.journal_entry_ids.length !== 1) {
      const journalEntryIds = [...new Set(pair.journal_entry_ids)]
      const isBankSplit =
        parsed.kind === 'bank' && pair.external_ids.length === 1 && journalEntryIds.length >= 2
      if (!isBankSplit) {
        skipped.push({
          pair,
          code: 'UNSUPPORTED_PAIR_SHAPE',
          message:
            parsed.kind === 'bank'
              ? 'Ett par är en eller flera händelser mot ett verifikat, eller en händelse mot flera verifikat.'
              : 'Flera verifikat i samma par stöds inte på skattekontot: ett par är en eller flera händelser mot ett verifikat.',
        })
        continue
      }
      if (journalEntryIds.length > 50) {
        skipped.push({
          pair,
          code: 'UNSUPPORTED_PAIR_SHAPE',
          message: 'En händelse kan delas på högst 50 verifikat.',
        })
        continue
      }
      // Explicit allocations must name exactly the pair's verifikat, once each.
      const given = pair.allocations
      if (given) {
        const namedIds = given.map((a) => a.journal_entry_id)
        const namedSet = new Set(namedIds)
        const coversPair =
          namedSet.size === namedIds.length &&
          namedSet.size === journalEntryIds.length &&
          journalEntryIds.every((id) => namedSet.has(id))
        if (!coversPair) {
          skipped.push({
            pair,
            code: 'UNSUPPORTED_PAIR_SHAPE',
            message: 'allocations måste ange ett belopp för varje verifikat i paret, och inga andra.',
          })
          continue
        }
      }
      const [externalId] = pair.external_ids
      const allocationInput = journalEntryIds.map((id) => ({
        journal_entry_id: id,
        amount: given?.find((a) => a.journal_entry_id === id)?.amount,
      }))
      try {
        const r = await linkTransactionToVouchers(
          supabase,
          companyId,
          externalId,
          allocationInput,
          userId,
          await resolveLedgerAccount(),
          { dryRun },
        )
        if (!r.success || !r.allocations) {
          skipped.push({ pair, code: 'PAIR_NOT_CLOSED', message: r.error ?? 'Kunde inte koppla' })
          continue
        }
        for (const a of r.allocations) {
          applied.push({ external_id: externalId, journal_entry_id: a.journal_entry_id, allocated_amount: a.amount })
          if (!dryRun) await emitMatched(externalId, a.journal_entry_id)
        }
      } catch (err) {
        const { code, message } = skipCodeFor(err)
        skipped.push({ pair, code, message })
      }
      continue
    }
    const externalIds = [...new Set(pair.external_ids)]
    if (externalIds.length === 0 || externalIds.length > 50) {
      skipped.push({
        pair,
        code: 'UNSUPPORTED_PAIR_SHAPE',
        message: 'Ett par kopplar mellan 1 och 50 händelser mot ett verifikat.',
      })
      continue
    }
    const [journalEntryId] = pair.journal_entry_ids

    if (dryRun) {
      for (const externalId of externalIds) {
        applied.push({ external_id: externalId, journal_entry_id: journalEntryId })
      }
      continue
    }

    try {
      if (parsed.kind === 'skattekonto') {
        if (externalIds.length === 1) {
          const r = await linkSkattekontoRow(supabase, companyId, externalIds[0], journalEntryId)
          applied.push({ external_id: externalIds[0], journal_entry_id: journalEntryId, via: r.via })
          await emitMatched(externalIds[0], journalEntryId)
        } else {
          // All-or-nothing: the group's sum must settle the verifikat, and a
          // lost race rolls the whole group back inside the link helper.
          const r = await linkSkattekontoRows(supabase, companyId, externalIds, journalEntryId)
          for (const externalId of r.skattekonto_transaction_ids) {
            applied.push({ external_id: externalId, journal_entry_id: journalEntryId, via: r.via })
            await emitMatched(externalId, journalEntryId)
          }
        }
      } else {
        const account = await resolveLedgerAccount()
        // Bank N:1 is per-transaction by design (manualLink documents why the
        // engine allows several transactions on one verifikat): each link is
        // independent, so partial success is reported per transaction.
        for (const externalId of externalIds) {
          const r = await manualLink(supabase, companyId, externalId, journalEntryId, userId, account)
          if (!r.success) {
            skipped.push({
              pair: { external_ids: [externalId], journal_entry_ids: [journalEntryId] },
              code: 'PAIR_NOT_CLOSED',
              message: r.error ?? 'Kunde inte koppla',
            })
            continue
          }
          applied.push({ external_id: externalId, journal_entry_id: journalEntryId })
          await emitMatched(externalId, journalEntryId)
        }
      }
    } catch (err) {
      const { code, message } = skipCodeFor(err)
      skipped.push({ pair, code, message })
    }
  }

  if (!dryRun && applied.length > 0) {
    log.info('reconciliation pairs linked', { companyId, accountKey, applied: applied.length, skipped: skipped.length })
  }

  return { dry_run: dryRun, applied, skipped, considered: pairs.length }
}

export interface UnmatchResult {
  external_id: string
  previous_journal_entry_id: string | null
}

/**
 * Remove one link. link id = the outside row's id (transaction or
 * skattekonto row), which is the one-link-per-row identity both kinds share.
 */
export async function unmatchLink(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  accountKey: string,
  linkId: string,
): Promise<UnmatchResult | null> {
  const parsed = parseAccountKey(accountKey)
  if (!parsed || parsed.kind === 'manual') return null

  let previous: string | null = null
  if (parsed.kind === 'skattekonto') {
    const r = await unlinkSkattekontoRow(supabase, companyId, linkId)
    previous = r.previous_journal_entry_id
  } else {
    const { data: tx } = await supabase
      .from('transactions')
      .select('journal_entry_id')
      .eq('company_id', companyId)
      .eq('id', linkId)
      .maybeSingle<{ journal_entry_id: string | null }>()
    const r = await unlinkReconciliation(supabase, companyId, linkId, userId)
    if (!r.success) throw new Error(r.error ?? 'Kunde inte koppla bort')
    // A split row (1:N) has no pointer: the engine collected its junction
    // vouchers before deleting them, so the first one is reported here.
    previous = tx?.journal_entry_id ?? r.previousJournalEntryIds?.[0] ?? null
  }
  await eventBus.emit({
    type: 'reconciliation.unmatched',
    payload: { accountKey, externalId: linkId, previousJournalEntryId: previous, userId, companyId },
  })
  return { external_id: linkId, previous_journal_entry_id: previous }
}

/**
 * Ignore / restore one outside row. Ignored rows leave the unmatched totals
 * and surface on the bridge's exclusion line (bank #1705 precedent).
 */
export async function setItemIgnored(
  supabase: SupabaseClient,
  companyId: string,
  accountKey: string,
  itemId: string,
  ignored: boolean,
): Promise<{ external_id: string; is_ignored: boolean } | null> {
  const parsed = parseAccountKey(accountKey)
  if (!parsed || parsed.kind === 'manual') return null
  if (parsed.kind === 'skattekonto') {
    const r = await setSkattekontoRowIgnored(supabase, companyId, itemId, ignored)
    return { external_id: r.skattekonto_transaction_id, is_ignored: r.is_ignored }
  }
  const { data: tx, error } = await supabase
    .from('transactions')
    .select('id, journal_entry_id, is_ignored')
    .eq('company_id', companyId)
    .eq('id', itemId)
    .maybeSingle<{ id: string; journal_entry_id: string | null; is_ignored: boolean | null }>()
  if (error) throw new Error(`Kunde inte hämta transaktionen: ${error.message}`)
  if (!tx) throw new SkattekontoLinkError('Transaktionen hittades inte.', 'TRANSACTION_NOT_FOUND')
  if (ignored && tx.journal_entry_id) {
    throw new SkattekontoLinkError('En bokförd transaktion kan inte ignoreras.', 'ALREADY_BOOKED')
  }
  // A row anchored only through transaction_voucher_links (bulk-book, 1:N
  // split) has two counterparts in the ledger; ignoring it would drop the
  // bank side while the ledger keeps it and manufacture a difference of the
  // full amount (issue #1553, field note).
  if (ignored && !tx.journal_entry_id) {
    const junctionLinked = await fetchJunctionLinkedTxIds(supabase, companyId, [itemId])
    if (junctionLinked.has(itemId)) {
      throw new SkattekontoLinkError('En bokförd transaktion kan inte ignoreras.', 'ALREADY_BOOKED')
    }
  }
  if (Boolean(tx.is_ignored) !== ignored) {
    const { error: updateError } = await supabase
      .from('transactions')
      .update({ is_ignored: ignored })
      .eq('company_id', companyId)
      .eq('id', itemId)
    if (updateError) throw new Error(`Kunde inte uppdatera: ${updateError.message}`)
  }
  return { external_id: itemId, is_ignored: ignored }
}
