import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events/bus'
import { createLogger } from '@/lib/logger'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { dbError } from '@/lib/errors/db-error'
import { isUuid } from '@/lib/invariants/uuid'
import { hasBankLineJunctionRow } from '@/lib/transactions/is-booked'
import { chunk } from '@/lib/utils'
import { roundOre } from '@/lib/money'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import {
  evaluateSkattekontoLink,
  linkSkattekontoRow,
  linkSkattekontoRows,
  setSkattekontoRowIgnored,
  skattekontoEntryNet,
  SkattekontoLinkError,
  skattekontoLinkRefusal,
  unlinkSkattekontoRow,
} from '@/lib/skatteverket/skattekonto-link'
import { setTransactionIgnored } from '@/lib/transactions/ignore'
import {
  linkTransactionToVouchers,
  manualLink,
  unlinkReconciliation,
  type BankLinkRefusalCode,
} from './bank-reconciliation'
import { resolveSkattekontoAccount, type SkattekontoLedgerAccount } from '@/lib/skatteverket/skattekonto-account'
import { getSkattekontoReconciliationStatus } from './skattekonto-reconciliation'
import {
  releaseSkattekontoSettlementOf,
  splitSkattekontoRow,
  undoSkattekontoSettlement,
} from './skattekonto-split'
import { settleLedgerEntries, undoLedgerSettlement, type LedgerSettlement } from './ledger-settlement'
import { parseAccountKey } from './schemas'
import { DEFAULT_SETTLEMENT_ACCOUNT } from './cash-account-scope'
import { linkBasisForReconciliationMethod, type LinkEvidence } from '@/lib/links/link-basis'

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
  /**
   * Outside rows: transaction ids (bank) or skattekonto_transaction ids.
   * Empty on a bank account for the ledger-only shape: two or more verifikat
   * that take each other out on the account (ledger-settlement.ts).
   */
  external_ids: string[]
  journal_entry_ids: string[]
  /**
   * For the 1:N shape (one outside row over several verifikat): the signed
   * slice per verifikat, in the row's sign convention. Bank: omitted, each
   * slice defaults to the voucher's net line on the account; either way the
   * slices must sum to the transaction amount. Skattekonto: each slice is the
   * verifikat's whole open amount on 1630 (skattekonto-split.ts); slices
   * given (a staged preview's) must still equal it.
   */
  allocations?: Array<{ journal_entry_id: string; amount: number }>
  /**
   * Skattekonto only: link although the rows do not settle the verifikat's
   * 1630 movement (a summarised verifikat that books more events than these,
   * crm#1043). The rows' amount leaves both sides; what the verifikat holds
   * beyond them stays in unmatched_ledger as its remainder. Never a default.
   */
  allow_remainder?: boolean
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
  | 'BANK_ANCHOR_REFUSED'
  /** Ledger-only pair: a verifikat is not in the account's list of verifikat without a bank row. */
  | 'ENTRY_NOT_OPEN'
  /** Ledger-only pair: a verifikat is already settled against another verifikat. */
  | 'ALREADY_SETTLED'
  | 'UNKNOWN'

export interface AppliedLink {
  external_id: string
  journal_entry_id: string
  /**
   * Skattekonto: how the link was accepted; 'partial' = linked with a
   * remainder (allow_remainder); 'split' = one event over several verifikat.
   */
  via?: 'line' | 'entry_total' | 'lines' | 'partial' | 'split'
  /** Present on the links of a 1:N split: the slice of the row this verifikat settles. */
  allocated_amount?: number
  /**
   * Skattekonto, present when not zero: what the verifikat holds on 1630
   * beyond the rows linked to it once this pair is linked (ledger sign). It
   * stays in unmatched_ledger with that amount.
   */
  remainder_amount?: number
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
  /** Ledger-only pairs: verifikat settled against each other. settlement_id is null on a dry run. */
  settled: LedgerSettlement[]
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
  // Only the row's-own-account link asks it (manualLink names the account);
  // the bank-anchor guard refuses the same row at the write.
  CURRENCY_MISMATCH: 'BANK_ANCHOR_REFUSED',
  ENTRY_NOT_FOUND: 'ENTRY_NOT_FOUND',
  ENTRY_NOT_POSTED: 'ENTRY_NOT_FOUND',
  ENTRY_REVERSED: 'ENTRY_REVERSED',
  NOT_SETTLED: 'PAIR_NOT_CLOSED',
  INVALID_SPLIT: 'UNSUPPORTED_PAIR_SHAPE',
  LINK_RACE: 'LINK_RACE',
  // Its own code, not UNKNOWN: that one invited retries of a refusal that
  // repeats (agent feedback seq 853921, 877706).
  BANK_ANCHOR_REFUSED: 'BANK_ANCHOR_REFUSED',
  // An amounts refusal: the verifikat has less left than the slice asks for.
  OVER_ALLOCATED: 'PAIR_NOT_CLOSED',
  WRITE_FAILED: 'UNKNOWN',
}

function bankSkipCode(code: BankLinkRefusalCode | undefined): PairSkipCode {
  return code ? BANK_SKIP_CODE[code] : 'UNKNOWN'
}

/** Ids per read: keeps a PostgREST `in` filter well inside URL limits. */
const FACT_READ_CHUNK = 100

type AccountLine = { account_number: string; debit_amount: number | string; credit_amount: number | string }

interface PairFacts {
  entries: Map<
    string,
    {
      status: string
      voucher_series: string | null
      voucher_number: number | null
      /** Skattekonto only: the verifikat's lines, for the amount check. */
      lines?: AccountLine[] | null
    }
  >
  /** Outside rows by id; `linked` already folds in the live-pointer and junction rules. */
  rows: Map<string, { is_ignored: boolean; linked: boolean; amount?: number; settled?: boolean }>
  /** Skattekonto only: amounts of the rows already linked to each verifikat. */
  linkedAmounts: Map<string, number[]>
}

/**
 * What the commit would refuse before it looks at amounts, for every pair of
 * one verifikat at once: the verifikat is not a posted entry of the company,
 * or an outside row is not the company's, is ignored or is already linked.
 * Two batched reads whatever the pair count (three on the skattekonto, whose
 * amounts the dry run checks too: the verifikat's lines ride on the entry
 * read and the rows already linked to it are one more read). The commit path
 * re-validates all of it; this only stops a stage-time preview from offering
 * a pair that can never be linked (feedback seq 740266: a journal_entry_id
 * with one wrong character was staged, approved and only then refused;
 * crm#1043: rows against a summarised verifikat were refused only at
 * approval).
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

  const rowFacts: Array<{
    id: string
    journal_entry_id: string | null
    is_ignored: boolean
    bank_line: boolean
    amount?: number
    settled?: boolean
  }> = []
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
            .select('id, journal_entry_id, is_ignored, belopp_skatteverket, status')
            .eq('company_id', companyId)
            .in('id', part)
    if (error) throw dbError(error, 'Kunde inte läsa raderna')
    for (const row of (data ?? []) as Array<{
      id: string
      journal_entry_id: string | null
      is_ignored: boolean | null
      belopp_skatteverket?: number | string | null
      status?: string | null
      transaction_voucher_links?: Array<{ role?: string | null }> | null
    }>) {
      rowFacts.push({
        id: row.id,
        journal_entry_id: row.journal_entry_id,
        is_ignored: row.is_ignored === true,
        bank_line: hasBankLineJunctionRow(row.transaction_voucher_links),
        ...(kind === 'skattekonto'
          ? { amount: Number(row.belopp_skatteverket), settled: row.status === 'booked' }
          : {}),
      })
      // A bank row's pointer blocks a link only while its verifikat is
      // posted (manualLink, issue #988), so its status is read with the rest.
      if (kind === 'bank' && row.journal_entry_id && isUuid(row.journal_entry_id)) {
        entryIds.add(row.journal_entry_id)
      }
    }
  }

  const entries: PairFacts['entries'] = new Map()
  const linkedAmounts: PairFacts['linkedAmounts'] = new Map()
  for (const part of chunk([...entryIds], FACT_READ_CHUNK)) {
    // Two literal selects so the phantom-column guard can read each one.
    const { data, error } =
      kind === 'skattekonto'
        ? await supabase
            .from('journal_entries')
            .select(
              'id, status, voucher_series, voucher_number, lines:journal_entry_lines ( account_number, debit_amount, credit_amount )',
            )
            .eq('company_id', companyId)
            .in('id', part)
        : await supabase
            .from('journal_entries')
            .select('id, status, voucher_series, voucher_number')
            .eq('company_id', companyId)
            .in('id', part)
    if (error) throw dbError(error, 'Kunde inte läsa verifikaten')
    for (const e of (data ?? []) as Array<{
      id: string
      status: string
      voucher_series: string | null
      voucher_number: number | null
      lines?: AccountLine[] | null
    }>) {
      entries.set(e.id, e)
    }
    if (kind !== 'skattekonto') continue
    const { data: linked, error: linkedError } = await supabase
      .from('skattekonto_transactions')
      .select('id, journal_entry_id, belopp_skatteverket')
      .eq('company_id', companyId)
      .in('journal_entry_id', part)
    if (linkedError) throw dbError(linkedError, 'Kunde inte läsa kopplade rader')
    for (const r of (linked ?? []) as Array<{ journal_entry_id: string | null; belopp_skatteverket: number | string | null }>) {
      if (!r.journal_entry_id) continue
      linkedAmounts.set(r.journal_entry_id, [
        ...(linkedAmounts.get(r.journal_entry_id) ?? []),
        Number(r.belopp_skatteverket),
      ])
    }
  }

  const rows: PairFacts['rows'] = new Map()
  for (const r of rowFacts) {
    const linked =
      kind === 'bank'
        ? r.bank_line || (r.journal_entry_id !== null && entries.get(r.journal_entry_id)?.status === 'posted')
        : r.journal_entry_id !== null
    rows.set(r.id, {
      is_ignored: r.is_ignored,
      linked,
      ...(kind === 'skattekonto' ? { amount: r.amount, settled: r.settled } : {}),
    })
  }
  return { entries, rows, linkedAmounts }
}

/**
 * The amount half of a skattekonto dry run: the same evaluation the live
 * link makes (evaluateSkattekontoLink), over the facts already read. Returns
 * the refusal the live link would give, or how the pair would be linked and
 * what it leaves on the verifikat.
 */
function skattekontoAmountCheck(
  facts: PairFacts,
  externalIds: string[],
  journalEntryId: string,
  allowRemainder: boolean,
  account: SkattekontoLedgerAccount,
):
  | { ok: true; via: 'line' | 'entry_total' | 'lines' | 'partial'; remainder: number }
  | { ok: false; code: PairSkipCode; message: string } {
  if (externalIds.some((id) => facts.rows.get(id)?.settled === false)) {
    return { ok: false, code: 'PAIR_NOT_CLOSED', message: 'En kommande händelse kan inte kopplas ännu.' }
  }
  const lines = facts.entries.get(journalEntryId)?.lines ?? null
  const amounts = externalIds.map((id) => Number(facts.rows.get(id)?.amount))
  const linked = facts.linkedAmounts.get(journalEntryId) ?? []
  const evaluation = evaluateSkattekontoLink(lines, linked, amounts, { allowRemainder, account })
  if (evaluation.ok && evaluation.via) {
    return { ok: true, via: evaluation.via, remainder: evaluation.remainder }
  }
  const refusal = skattekontoLinkRefusal(evaluation, {
    entryNet: skattekontoEntryNet(lines, account).net,
    rowsTotal: roundOre(amounts.reduce((sum, a) => sum + a, 0)),
    rowCount: amounts.length,
    alreadyLinked: linked.length,
    account,
  })
  return { ok: false, ...skipCodeFor(new SkattekontoLinkError(refusal.message, refusal.code)) }
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

/**
 * Why a bank pair is linked: a pair the caller named is their choice (the
 * request scope says whether a person, an approved agent or a client named
 * it); a proposal applied in bulk was chosen by the matcher, whose method and
 * score are the evidence.
 */
function bankPairLinkBasis(
  named: boolean,
  proposal: { method: string | null; confidence: number | null } | undefined,
): { basis: 'user_confirmed' | ReturnType<typeof linkBasisForReconciliationMethod>; evidence?: LinkEvidence } {
  if (named || !proposal) return { basis: 'user_confirmed' }
  return {
    basis: linkBasisForReconciliationMethod(proposal.method),
    evidence: {
      rule_id: proposal.method ?? 'reconciliation_proposal',
      ...(proposal.confidence !== null ? { score: proposal.confidence } : {}),
    },
  }
}

async function proposalsAsPairs(
  supabase: SupabaseClient,
  companyId: string,
  accountKey: string,
  threshold: number,
  skattekontoAccount: SkattekontoLedgerAccount | null,
  /** Filled per bank transaction with the matcher's method and score, for the link basis. */
  bankProposalOut?: Map<string, { method: string | null; confidence: number | null }>,
): Promise<ReconciliationPair[]> {
  const parsed = parseAccountKey(accountKey)
  if (!parsed) return []
  if (parsed.kind === 'skattekonto') {
    const status = await getSkattekontoReconciliationStatus(supabase, companyId, {
      ...(skattekontoAccount ? { account: skattekontoAccount } : {}),
    })
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
    // Paged: past 1,000 open proposals the rest were silently left out.
    const data = await fetchAllRows<{
      id: string
      potential_journal_entry_id: string
      potential_match_method: string | null
      potential_match_confidence: number | string | null
    }>(
      ({ from, to }) =>
        supabase
          .from('transactions')
          .select('id, potential_journal_entry_id, potential_match_method, potential_match_confidence')
          .eq('company_id', companyId)
          .eq('cash_account_id', parsed.cashAccountId)
          .is('journal_entry_id', null)
          .eq('is_ignored', false)
          .not('potential_journal_entry_id', 'is', null)
          .order('date')
          .order('id')
          .range(from, to),
    )
    const kept = data.filter((r) => Number(r.potential_match_confidence ?? 0) >= threshold)
    for (const r of kept) {
      bankProposalOut?.set(r.id, {
        method: r.potential_match_method,
        confidence: r.potential_match_confidence === null ? null : Number(r.potential_match_confidence),
      })
    }
    return kept.map((r) => ({ external_ids: [r.id], journal_entry_ids: [r.potential_journal_entry_id] }))
  }
  return []
}

/**
 * Link pairs on one account. A pair is one OR MANY outside rows against
 * exactly one verifikat (bank: independent links per transaction; skattekonto:
 * all-or-nothing with the sum settling the verifikat, or, with the pair's
 * allow_remainder, against a summarised verifikat that keeps the rest as its
 * remainder), or ONE outside row against SEVERAL verifikat (1:N; bank issue
 * #1553, skattekonto crm#1183 in skattekonto-split.ts): all-or-nothing
 * with the slices summing to the row, or, on a bank account, NO
 * outside row and two or more verifikat that take each other out (a wrong
 * verifikat and its hand-made rättelse: all-or-nothing, reported in
 * `settled`). Any other shape is reported as
 * UNSUPPORTED_PAIR_SHAPE, never silently reduced. Dry run validates shapes,
 * resolves proposals and checks every verifikat and outside row against the
 * ledger (readPairFacts) without writing; a 1:N dry run also resolves the
 * slices so a reviewer sees exactly what would be linked.
 * Partial success is first-class: `applied`, `settled` and `skipped`
 * together cover every considered pair.
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
  // The skattekonto's ledger account (1630, or 2012 for an enskild firma that
  // runs it there), resolved once for every pair, proposal and check below.
  const skattekontoAccount =
    parsed.kind === 'skattekonto' ? await resolveSkattekontoAccount(supabase, companyId) : null

  const pairs: ReconciliationPair[] = [...(input.pairs ?? [])]
  // The pairs the caller named (a person's or an agent's choice, a staged
  // operation's approved list), as against the proposals use_proposals
  // applies in bulk: only a named bank pair takes the row's underlag onto
  // the verifikat (manualLink anchorUnderlag).
  const namedPairs = new Set(pairs)
  // The matcher's method and score per proposed bank row: a proposal applied
  // in bulk records the matcher as its link basis, not a person's choice.
  const bankProposals = new Map<string, { method: string | null; confidence: number | null }>()
  if (input.use_proposals) {
    pairs.push(
      ...(await proposalsAsPairs(supabase, companyId, accountKey, input.confidence_threshold ?? 0, skattekontoAccount, bankProposals)),
    )
  }

  const applied: AppliedLink[] = []
  const settled: LedgerSettlement[] = []
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
    if (parsed.kind !== 'bank') return DEFAULT_SETTLEMENT_ACCOUNT
    const { data: account } = await supabase
      .from('cash_accounts')
      .select('ledger_account')
      .eq('company_id', companyId)
      .eq('id', parsed.cashAccountId)
      .maybeSingle<{ ledger_account: string }>()
    ledgerAccount = account?.ledger_account ?? DEFAULT_SETTLEMENT_ACCOUNT
    return ledgerAccount
  }

  for (const pair of pairs) {
    // No outside row at all: verifikat that take each other out on the
    // account. The whole policy, dry run included, is ledger-settlement.ts.
    if ((pair.external_ids ?? []).length === 0) {
      if (pair.allocations) {
        skipped.push({
          pair,
          code: 'UNSUPPORTED_PAIR_SHAPE',
          message: 'allocations hör till en händelse som delas på flera verifikat, inte till verifikat som kopplas mot varandra.',
        })
        continue
      }
      try {
        const r = await settleLedgerEntries(supabase, companyId, userId, accountKey, pair.journal_entry_ids, { dryRun })
        if (r.ok) settled.push(r.settlement)
        else skipped.push({ pair, code: r.code, message: r.message })
      } catch (err) {
        const { code, message } = skipCodeFor(err)
        skipped.push({ pair, code, message })
      }
      continue
    }
    // N outside rows may settle ONE verifikat (the worksheet selection). ONE
    // outside row may settle SEVERAL verifikat (the split: bank #1553, and on
    // the skattekonto one event booked over several verifikat, crm#1183).
    // N:M is refused loudly, never silently reduced.
    if (pair.journal_entry_ids.length !== 1) {
      const journalEntryIds = [...new Set(pair.journal_entry_ids)]
      const isSplit = pair.external_ids.length === 1 && journalEntryIds.length >= 2
      if (!isSplit || (parsed.kind === 'skattekonto' && pair.allow_remainder === true)) {
        skipped.push({
          pair,
          code: 'UNSUPPORTED_PAIR_SHAPE',
          message: isSplit
            ? 'allow_remainder hör till ett samlingsverifikat: en händelse mot flera verifikat kopplas bara när de tillsammans är exakt händelsens belopp.'
            : 'Ett par är en eller flera händelser mot ett verifikat, eller en händelse mot flera verifikat.',
        })
        continue
      }
      if (parsed.kind === 'skattekonto' && skattekontoAccount) {
        // The whole policy, dry run included, is skattekonto-split.ts.
        const [externalId] = pair.external_ids
        try {
          const r = await splitSkattekontoRow(supabase, companyId, userId, externalId, journalEntryIds, {
            dryRun,
            ...(pair.allocations ? { allocations: pair.allocations } : {}),
            account: skattekontoAccount,
          })
          if (!r.ok) {
            skipped.push({ pair, code: r.code, message: r.message })
            continue
          }
          for (const slice of r.slices) {
            applied.push({
              external_id: externalId,
              journal_entry_id: slice.journal_entry_id,
              via: 'split',
              allocated_amount: slice.amount,
            })
            if (!dryRun) await emitMatched(externalId, slice.journal_entry_id)
          }
        } catch (err) {
          const { code, message } = skipCodeFor(err)
          skipped.push({ pair, code, message })
        }
        continue
      }
      // How many verifikat one row may split across is the engine's rule
      // (MAX_BANK_ROW_SPLIT, refused as INVALID_SPLIT), not repeated here.
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
      if (parsed.kind === 'skattekonto' && skattekontoAccount) {
        // All or nothing, as linkSkattekontoRows: one bad row skips the group.
        const rowProblem = externalIds.map((id) => rowSkip(facts, 'skattekonto', id)).find((p) => p !== null)
        if (rowProblem) {
          skipped.push({ pair, ...rowProblem })
          continue
        }
        // The amounts, as the live link checks them: a pair that cannot
        // close is refused here, not after approval.
        const amounts = skattekontoAmountCheck(
          facts,
          externalIds,
          journalEntryId,
          pair.allow_remainder === true,
          skattekontoAccount,
        )
        if (!amounts.ok) {
          skipped.push({ pair, code: amounts.code, message: amounts.message })
          continue
        }
        for (const externalId of externalIds) {
          applied.push({
            external_id: externalId,
            journal_entry_id: journalEntryId,
            via: amounts.via,
            ...(amounts.remainder !== 0 ? { remainder_amount: amounts.remainder } : {}),
          })
        }
        // A later pair on the same verifikat sees these rows as linked.
        facts.linkedAmounts.set(journalEntryId, [
          ...(facts.linkedAmounts.get(journalEntryId) ?? []),
          ...externalIds.map((id) => Number(facts.rows.get(id)?.amount)),
        ])
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
      if (parsed.kind === 'skattekonto' && skattekontoAccount) {
        // Only an explicit allow_remainder allows a remainder; the account
        // is the one resolved above for every pair.
        const linkOptions = {
          ...(pair.allow_remainder === true ? { allowRemainder: true } : {}),
          account: skattekontoAccount,
        }
        const remainderOf = (remainder: unknown) =>
          typeof remainder === 'number' && remainder !== 0 ? { remainder_amount: remainder } : {}
        if (externalIds.length === 1) {
          const r = await linkSkattekontoRow(supabase, companyId, externalIds[0], journalEntryId, linkOptions)
          applied.push({
            external_id: externalIds[0],
            journal_entry_id: journalEntryId,
            via: r.via,
            ...remainderOf(r.remainder),
          })
          await emitMatched(externalIds[0], journalEntryId)
        } else {
          // All-or-nothing: the group's sum must settle the verifikat (or the
          // pair allows a remainder), and a lost race rolls the whole group
          // back inside the link helper.
          const r = await linkSkattekontoRows(supabase, companyId, externalIds, journalEntryId, linkOptions)
          for (const externalId of r.skattekonto_transaction_ids) {
            applied.push({
              external_id: externalId,
              journal_entry_id: journalEntryId,
              via: r.via,
              ...remainderOf(r.remainder),
            })
            await emitMatched(externalId, journalEntryId)
          }
        }
      } else {
        const account = await resolveLedgerAccount()
        // Bank N:1 is per-transaction by design (manualLink documents why the
        // engine allows several transactions on one verifikat): each link is
        // independent, so partial success is reported per transaction.
        for (const externalId of externalIds) {
          const r = await manualLink(supabase, companyId, externalId, journalEntryId, userId, account, {
            anchorUnderlag: namedPairs.has(pair),
            linkBasis: bankPairLinkBasis(namedPairs.has(pair), bankProposals.get(externalId)),
          })
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

  if (!dryRun && applied.length + settled.length > 0) {
    log.info('reconciliation pairs linked', {
      companyId,
      accountKey,
      applied: applied.length,
      settled: settled.length,
      skipped: skipped.length,
    })
  }

  return { dry_run: dryRun, applied, settled, skipped, considered: pairs.length }
}

export interface UnmatchResult {
  external_id: string
  previous_journal_entry_id: string | null
  /** Set when the id was a ledger-only settlement: its verifikat are back in the ledger-only list. */
  settlement_id?: string
  journal_entry_ids?: string[]
}

/**
 * Remove one link. link id = the outside row's id (transaction or
 * skattekonto row), which is the one-link-per-row identity both kinds share,
 * or the settlement_id of verifikat settled against each other (bank:
 * ledger-settlement.ts; skattekonto: the rest of a 1:N link,
 * skattekonto-split.ts): an id that is no outside row of the company is
 * tried as one before it is reported missing. Unlinking a skattekonto row
 * also undoes the settlement its verifikat is in.
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
    let r: Awaited<ReturnType<typeof unlinkSkattekontoRow>>
    try {
      r = await unlinkSkattekontoRow(supabase, companyId, linkId)
    } catch (err) {
      // No row of the company: the id may be a settlement on the skattekonto
      // account (an item's settlement.settlement_id), as on the bank.
      if (err instanceof SkattekontoLinkError && err.code === 'TRANSACTION_NOT_FOUND') {
        const undone = await undoSkattekontoSettlement(supabase, companyId, userId, linkId)
        if (undone) {
          return {
            external_id: linkId,
            previous_journal_entry_id: null,
            settlement_id: undone.settlement_id,
            journal_entry_ids: undone.journal_entry_ids,
          }
        }
      }
      throw err
    }
    previous = r.previous_journal_entry_id
    // A 1:N link is the row on its primary verifikat plus a settlement of
    // the rest (skattekonto-split.ts): unlinking the row undoes both.
    const released = await releaseSkattekontoSettlementOf(supabase, companyId, userId, previous)
    if (released) {
      log.info('skattekonto split undone with its row link', { companyId, rowId: linkId, settlementId: released })
    }
  } else {
    const { data: tx } = await supabase
      .from('transactions')
      .select('journal_entry_id')
      .eq('company_id', companyId)
      .eq('id', linkId)
      .maybeSingle<{ journal_entry_id: string | null }>()
    if (!tx) {
      const undone = await undoLedgerSettlement(supabase, companyId, userId, accountKey, linkId)
      if (undone) {
        return {
          external_id: linkId,
          previous_journal_entry_id: null,
          settlement_id: undone.settlement_id,
          journal_entry_ids: undone.journal_entry_ids,
        }
      }
    }
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
 *
 * A bank row goes through the one ignore rule every other door uses
 * (setTransactionIgnored, lib/transactions/ignore.ts): it refuses a row
 * booked through any of the three anchors, journal_entry_id, a voucher link
 * or a payment allocation (crm#1183). The copy this replaced checked the
 * first two only, and let a failed link read through as "not booked". The
 * refusals keep this door's error codes.
 */
export async function setItemIgnored(
  supabase: SupabaseClient,
  companyId: string,
  accountKey: string,
  itemId: string,
  ignored: boolean,
  /** Who decided: recorded with the dismissed suggestions, as on the other doors. */
  userId?: string,
): Promise<{ external_id: string; is_ignored: boolean } | null> {
  const parsed = parseAccountKey(accountKey)
  if (!parsed || parsed.kind === 'manual') return null
  if (parsed.kind === 'skattekonto') {
    const r = await setSkattekontoRowIgnored(supabase, companyId, itemId, ignored)
    return { external_id: r.skattekonto_transaction_id, is_ignored: r.is_ignored }
  }
  const outcome = await setTransactionIgnored(supabase, companyId, itemId, ignored, { userId })
  if (!outcome.ok) {
    if (outcome.code === 'TX_IGNORE_ALREADY_BOOKED') {
      throw new SkattekontoLinkError('En bokförd transaktion kan inte ignoreras.', 'ALREADY_BOOKED')
    }
    throw new SkattekontoLinkError('Transaktionen hittades inte.', 'TRANSACTION_NOT_FOUND')
  }
  return { external_id: itemId, is_ignored: ignored }
}
