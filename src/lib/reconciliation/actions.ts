import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events/bus'
import { createLogger } from '@/lib/logger'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { dbError } from '@/lib/errors/db-error'
import { isUuid } from '@/lib/invariants/uuid'
import { hasBankLineJunctionRow } from '@/lib/transactions/is-booked'
import { chunk } from '@/lib/utils'
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
  type BankLinkRefusalCode,
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
  via?: 'line' | 'entry_total' | 'lines'
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

/**
 * The bank engine's refusals in this surface's vocabulary. PAIR_NOT_CLOSED is
 * the amounts only (the verifikat does not settle the row on the account):
 * every refusal used to carry it, so a mistyped journal_entry_id read as a
 * gap to book as a residual (feedback seq 740266).
 */
const BANK_SKIP_CODE: Record<BankLinkRefusalCode, PairSkipCode> = {
  TRANSACTION_NOT_FOUND: 'NOT_FOUND',
  TRANSACTION_OTHER_ACCOUNT: 'NOT_FOUND',
  TRANSACTION_IGNORED: 'ROW_IGNORED',
  TRANSACTION_ALREADY_LINKED: 'ALREADY_LINKED',
  ENTRY_NOT_FOUND: 'ENTRY_NOT_FOUND',
  ENTRY_NOT_POSTED: 'ENTRY_NOT_FOUND',
  ENTRY_REVERSED: 'ENTRY_REVERSED',
  NOT_SETTLED: 'PAIR_NOT_CLOSED',
  INVALID_SPLIT: 'UNSUPPORTED_PAIR_SHAPE',
  LINK_RACE: 'LINK_RACE',
  WRITE_FAILED: 'UNKNOWN',
}

function bankSkipCode(code: BankLinkRefusalCode | undefined): PairSkipCode {
  return code ? BANK_SKIP_CODE[code] : 'UNKNOWN'
}

/** Ids per read: keeps a PostgREST `in` filter well inside URL limits. */
const FACT_READ_CHUNK = 100

interface PairFacts {
  entries: Map<string, { status: string; voucher_series: string | null; voucher_number: number | null }>
  /** Outside rows by id; `linked` already folds in the live-pointer and junction rules. */
  rows: Map<string, { is_ignored: boolean; linked: boolean }>
}

/**
 * What the commit would refuse before it looks at amounts, for every pair of
 * one verifikat at once: the verifikat is not a posted entry of the company,
 * or an outside row is not the company's, is ignored or is already linked.
 * Two batched reads whatever the pair count. The commit path re-validates
 * all of it and the amounts; this only stops a stage-time preview from
 * offering a pair that can never be linked (feedback seq 740266: a
 * journal_entry_id with one wrong character was staged, approved and only
 * then refused).
 */
async function readPairFacts(
  supabase: SupabaseClient,
  companyId: string,
  kind: 'bank' | 'skattekonto',
  pairs: ReconciliationPair[],
): Promise<PairFacts> {
  const entryIds = new Set<string>()
  const rowIds = new Set<string>()
  for (const pair of pairs) {
    if (pair.journal_entry_ids.length !== 1) continue
    // A malformed id is simply absent (22P02 would fail the whole read).
    if (isUuid(pair.journal_entry_ids[0])) entryIds.add(pair.journal_entry_ids[0])
    for (const id of pair.external_ids) if (isUuid(id)) rowIds.add(id)
  }

  const rowFacts: Array<{ id: string; journal_entry_id: string | null; is_ignored: boolean; bank_line: boolean }> = []
  for (const part of chunk([...rowIds], FACT_READ_CHUNK)) {
    const { data, error } =
      kind === 'bank'
        ? await supabase
            .from('transactions')
            .select('id, journal_entry_id, is_ignored, transaction_voucher_links(role)')
            .eq('company_id', companyId)
            .in('id', part)
        : await supabase
            .from('skattekonto_transactions')
            .select('id, journal_entry_id, is_ignored')
            .eq('company_id', companyId)
            .in('id', part)
    if (error) throw dbError(error, 'Kunde inte läsa raderna')
    for (const row of (data ?? []) as Array<{
      id: string
      journal_entry_id: string | null
      is_ignored: boolean | null
      transaction_voucher_links?: Array<{ role?: string | null }> | null
    }>) {
      rowFacts.push({
        id: row.id,
        journal_entry_id: row.journal_entry_id,
        is_ignored: row.is_ignored === true,
        bank_line: hasBankLineJunctionRow(row.transaction_voucher_links),
      })
      // A bank row's pointer blocks a link only while its verifikat is
      // posted (manualLink, issue #988), so its status is read with the rest.
      if (kind === 'bank' && row.journal_entry_id && isUuid(row.journal_entry_id)) {
        entryIds.add(row.journal_entry_id)
      }
    }
  }

  const entries: PairFacts['entries'] = new Map()
  for (const part of chunk([...entryIds], FACT_READ_CHUNK)) {
    const { data, error } = await supabase
      .from('journal_entries')
      .select('id, status, voucher_series, voucher_number')
      .eq('company_id', companyId)
      .in('id', part)
    if (error) throw dbError(error, 'Kunde inte läsa verifikaten')
    for (const e of (data ?? []) as Array<{ id: string; status: string; voucher_series: string | null; voucher_number: number | null }>) {
      entries.set(e.id, e)
    }
  }

  const rows: PairFacts['rows'] = new Map()
  for (const r of rowFacts) {
    const linked =
      kind === 'bank'
        ? r.bank_line || (r.journal_entry_id !== null && entries.get(r.journal_entry_id)?.status === 'posted')
        : r.journal_entry_id !== null
    rows.set(r.id, { is_ignored: r.is_ignored, linked })
  }
  return { entries, rows }
}

function entrySkip(facts: PairFacts, journalEntryId: string): { code: PairSkipCode; message: string } | null {
  const entry = facts.entries.get(journalEntryId)
  if (!entry) {
    return {
      code: 'ENTRY_NOT_FOUND',
      message: `Verifikationen ${journalEntryId} finns inte i företaget. Kontrollera id:t.`,
    }
  }
  if (entry.status === 'reversed') {
    return {
      code: 'ENTRY_REVERSED',
      message: `Verifikat ${formatVoucher(entry)} (${journalEntryId}) är makulerat och kan inte kopplas.`,
    }
  }
  if (entry.status !== 'posted') {
    return { code: 'ENTRY_NOT_FOUND', message: `Verifikationen ${journalEntryId} är inte bokförd.` }
  }
  return null
}

function rowSkip(
  facts: PairFacts,
  kind: 'bank' | 'skattekonto',
  externalId: string,
): { code: PairSkipCode; message: string } | null {
  const row = facts.rows.get(externalId)
  const noun = kind === 'bank' ? 'Transaktionen' : 'Skattekonto-transaktionen'
  if (!row) return { code: 'NOT_FOUND', message: `${noun} ${externalId} finns inte i företaget. Kontrollera id:t.` }
  if (row.is_ignored) {
    return { code: 'ROW_IGNORED', message: `${noun} ${externalId} är ignorerad. Återställ den innan du kopplar.` }
  }
  if (row.linked) {
    return { code: 'ALREADY_LINKED', message: `${noun} ${externalId} är redan kopplad till en verifikation.` }
  }
  return null
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
    // Rows of one combined proposal become ONE pair so the group is linked
    // together (a single row alone does not settle the verifikat).
    const pairsByEntry = new Map<string, ReconciliationPair>()
    for (const i of status.items.proposed) {
      if (!i.proposal || i.proposal.confidence < threshold) continue
      const entryId = i.proposal.journal_entry_id
      const ids = i.proposal.external_ids ?? [i.item_id]
      const key = i.proposal.external_ids ? `group:${entryId}` : `row:${i.item_id}`
      if (!pairsByEntry.has(key)) pairsByEntry.set(key, { external_ids: ids, journal_entry_ids: [entryId] })
    }
    return Array.from(pairsByEntry.values())
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
 * UNSUPPORTED_PAIR_SHAPE, never silently reduced. Dry run validates shapes,
 * resolves proposals and checks every verifikat and outside row against the
 * ledger (readPairFacts) without writing; a 1:N dry run also resolves the
 * slices so a reviewer sees exactly what would be linked.
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
  // A dry run checks every pair of one verifikat against the ledger up front
  // (the 1:N split validates itself below); a live run leaves that to the
  // link helpers, which re-check under the write.
  const facts = dryRun ? await readPairFacts(supabase, companyId, parsed.kind, pairs) : null

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
          skipped.push({ pair, code: bankSkipCode(r.code), message: r.error ?? 'Kunde inte koppla' })
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

    if (facts) {
      const entryProblem = entrySkip(facts, journalEntryId)
      if (entryProblem) {
        skipped.push({ pair, ...entryProblem })
        continue
      }
      if (parsed.kind === 'skattekonto') {
        // All or nothing, as linkSkattekontoRows: one bad row skips the group.
        const rowProblem = externalIds.map((id) => rowSkip(facts, 'skattekonto', id)).find((p) => p !== null)
        if (rowProblem) {
          skipped.push({ pair, ...rowProblem })
          continue
        }
        for (const externalId of externalIds) {
          applied.push({ external_id: externalId, journal_entry_id: journalEntryId })
        }
        continue
      }
      // Bank rows link one by one (manualLink per transaction), so a bad row
      // skips alone, reported the way the live run reports it.
      for (const externalId of externalIds) {
        const rowProblem = rowSkip(facts, 'bank', externalId)
        if (rowProblem) {
          skipped.push({ pair: { external_ids: [externalId], journal_entry_ids: [journalEntryId] }, ...rowProblem })
        } else {
          applied.push({ external_id: externalId, journal_entry_id: journalEntryId })
        }
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
              code: bankSkipCode(r.code),
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
