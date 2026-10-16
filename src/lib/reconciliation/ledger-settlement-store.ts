import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { ORE_TOLERANCE, roundOre } from '@/lib/money'
import { linkBasisColumns } from '@/lib/links/stamp'

const log = createLogger('reconciliation/ledger-settlement')

/**
 * Ledger-only settlements (account_reconciliation_settlements), read and
 * written in one place, plus the one rule that says when a settlement holds.
 *
 * A settlement is the statement "these verifikat explain each other on this
 * account": a wrong verifikat and the rättelse someone booked by hand, with
 * no bank row for either (crm#1074). It never touches the ledger.
 *
 * The rule lives in the reader, not in the row: a settlement is honoured only
 * while EVERY verifikat in it is still in the account's ledger-only list
 * (posted, no bank row) and their open amounts still sum to zero. A verifikat
 * that is later linked to a bank row, makulerat or changed by an inline
 * rättelse breaks its settlement, and the others return to the list by
 * themselves, flagged, with nothing to repair. So no stored row can make the
 * reconciliation claim something the ledger does not say.
 *
 * Pure storage and that rule: no policy (ledger-settlement.ts) and no import
 * of the bank engine, so bank-reconciliation.ts can read settlements without
 * a module cycle (the signoff-store.ts split). Nothing here knows which bank
 * feed delivered the rows: it reads the ledger account and the verifikat.
 */

export const LEDGER_SETTLEMENT_TABLE = 'account_reconciliation_settlements'

const MEMBER_COLUMNS = 'settlement_id, journal_entry_id, amount, settled_by, settled_at'

export interface LedgerSettlementMember {
  settlement_id: string
  journal_entry_id: string
  /** What the verifikat left open on the account when it was settled, debit positive. */
  amount: number
  settled_by: string
  settled_at: string
}

interface MemberRow {
  settlement_id: string
  journal_entry_id: string
  amount: number | string
  settled_by: string
  settled_at: string
}

function mapMember(row: MemberRow): LedgerSettlementMember {
  return {
    settlement_id: row.settlement_id,
    journal_entry_id: row.journal_entry_id,
    amount: roundOre(Number(row.amount)),
    settled_by: row.settled_by,
    settled_at: row.settled_at,
  }
}

/** Every live (not undone) settlement row on one ledger account. Throws on a failed read. */
export async function fetchLiveLedgerSettlements(
  supabase: SupabaseClient,
  companyId: string,
  accountNumber: string,
): Promise<LedgerSettlementMember[]> {
  const { data, error } = await supabase
    .from(LEDGER_SETTLEMENT_TABLE)
    .select(MEMBER_COLUMNS)
    .eq('company_id', companyId)
    .eq('account_number', accountNumber)
    .is('undone_at', null)
  if (error) throw new Error(`Kunde inte läsa kopplade verifikat: ${error.message}`)
  return ((data ?? []) as MemberRow[]).filter((r) => r && r.settlement_id && r.journal_entry_id).map(mapMember)
}

export async function insertLedgerSettlement(
  supabase: SupabaseClient,
  companyId: string,
  input: {
    settlement_id: string
    account_number: string
    settled_by: string
    entries: Array<{ journal_entry_id: string; amount: number }>
  },
): Promise<{ ok: true } | { ok: false; duplicate: boolean; message: string }> {
  // One statement, so the settlement lands whole or not at all. A settlement
  // is always named verifikat by verifikat (no matcher proposes one); the
  // request scope says whether a person or an approved agent named it.
  const { error } = await supabase.from(LEDGER_SETTLEMENT_TABLE).insert(
    input.entries.map((e) => ({
      company_id: companyId,
      settlement_id: input.settlement_id,
      account_number: input.account_number,
      journal_entry_id: e.journal_entry_id,
      amount: e.amount,
      settled_by: input.settled_by,
      ...linkBasisColumns('user_confirmed'),
    })),
  )
  if (!error) return { ok: true }
  const pg = error as { code?: string; message?: string }
  return {
    ok: false,
    // The partial unique index: one of the verifikat was settled in between.
    duplicate: pg.code === '23505' || /ux_account_reconciliation_settlements_active|duplicate key/i.test(pg.message ?? ''),
    message: pg.message ?? 'okänt fel',
  }
}

/**
 * Stamp a settlement as undone. The guarded `.is('undone_at', null)` makes it
 * race-safe; an id that is no live settlement on this account returns [].
 */
export async function stampLedgerSettlementUndone(
  supabase: SupabaseClient,
  companyId: string,
  accountNumber: string,
  settlementId: string,
  undoneBy: string,
): Promise<string[]> {
  const { data, error } = await supabase
    .from(LEDGER_SETTLEMENT_TABLE)
    .update({ undone_at: new Date().toISOString(), undone_by: undoneBy })
    .eq('company_id', companyId)
    .eq('account_number', accountNumber)
    .eq('settlement_id', settlementId)
    .is('undone_at', null)
    .select('journal_entry_id')
  if (error) throw new Error(`Kunde inte koppla bort verifikaten: ${error.message}`)
  return ((data ?? []) as Array<{ journal_entry_id: string }>).map((r) => r.journal_entry_id)
}

export interface SettledLedgerEntry {
  member: LedgerSettlementMember
  /** The verifikat's open amount on the account now, debit positive. */
  amount: number
  /**
   * Another verifikat of the settlement is dated outside the reader's window,
   * so the amounts do not net to zero inside it: the reader carries this one
   * on its own bridge line instead of dropping it silently.
   */
  outside_window: boolean
}

export interface ResolvedLedgerSettlements {
  /** In-window verifikat a settlement that still holds explains: they leave the ledger-only list. */
  settled: Map<string, SettledLedgerEntry>
  /** In-window verifikat whose settlement no longer holds: they stay in the list, flagged. */
  broken: Map<string, LedgerSettlementMember>
  /** Every row of the settlements above, by settlement id. */
  groups: Map<string, LedgerSettlementMember[]>
}

function nothing(): ResolvedLedgerSettlements {
  return { settled: new Map(), broken: new Map(), groups: new Map() }
}

/** Open amounts per verifikat as the bank engine computes them (openAmountByEntry). */
export type OpenAmounts = Map<string, number | null>

/**
 * Whether a settlement holds against a set of open amounts: every verifikat
 * is in the set with an amount, and the amounts sum to zero to the öre.
 */
function holds(members: LedgerSettlementMember[], open: OpenAmounts): boolean {
  let sum = 0
  for (const m of members) {
    const amount = open.get(m.journal_entry_id)
    if (amount === undefined || amount === null) return false
    sum += amount
  }
  return members.length >= 2 && Math.abs(roundOre(sum)) < ORE_TOLERANCE
}

/**
 * Sort the reader's ledger-only verifikat into settled and not.
 *
 * `windowOpen` is what the reader already holds: the open amount of every
 * ledger-only verifikat in its date window. A settlement whose verifikat are
 * all there is judged on it alone. One with a verifikat outside the window
 * (a correction booked the month after) needs that verifikat's state too:
 * `fetchSpanOpen` reads the same list over the dates the settlement spans,
 * through the reader's own candidate RPC, so "ledger-only" has one definition.
 *
 * Reads happen only when there is something to judge: nothing for an empty
 * window, one read for the account's live settlements, and two more only when
 * the window cuts a settlement. A failed read resolves to nothing settled:
 * every verifikat stays listed, which the bridge already accounts for.
 */
export async function resolveLedgerSettlements(
  supabase: SupabaseClient,
  companyId: string,
  accountNumber: string,
  windowOpen: OpenAmounts,
  fetchSpanOpen: (dateFrom: string, dateTo: string) => Promise<OpenAmounts>,
  /** The account's live settlements when the caller has read them already. */
  preRead?: LedgerSettlementMember[],
): Promise<ResolvedLedgerSettlements> {
  if (windowOpen.size === 0) return nothing()
  try {
    const live = preRead ?? (await fetchLiveLedgerSettlements(supabase, companyId, accountNumber))
    if (live.length === 0) return nothing()

    const groups = new Map<string, LedgerSettlementMember[]>()
    for (const m of live) groups.set(m.settlement_id, [...(groups.get(m.settlement_id) ?? []), m])
    // Only settlements with a verifikat in this window concern this reader.
    for (const [id, members] of groups) {
      if (!members.some((m) => windowOpen.has(m.journal_entry_id))) groups.delete(id)
    }
    if (groups.size === 0) return nothing()

    const cut = [...groups.values()].filter((members) => members.some((m) => !windowOpen.has(m.journal_entry_id)))
    let spanOpen: OpenAmounts = new Map()
    if (cut.length > 0) {
      // Every verifikat of the cut settlements, inside the window or not: the
      // span read must cover them all to judge the settlement as a whole.
      const cutIds = [...new Set(cut.flat().map((m) => m.journal_entry_id))]
      const dates: string[] = []
      for (let i = 0; i < cutIds.length; i += 100) {
        const { data, error } = await supabase
          .from('journal_entries')
          .select('id, entry_date')
          .eq('company_id', companyId)
          .in('id', cutIds.slice(i, i + 100))
        if (error) throw new Error(error.message)
        for (const row of (data ?? []) as Array<{ entry_date: string | null }>) {
          if (typeof row.entry_date === 'string') dates.push(row.entry_date)
        }
      }
      if (dates.length > 0) {
        dates.sort()
        spanOpen = await fetchSpanOpen(dates[0], dates[dates.length - 1])
      }
    }

    const settled: ResolvedLedgerSettlements['settled'] = new Map()
    const broken: ResolvedLedgerSettlements['broken'] = new Map()
    for (const members of groups.values()) {
      const whole = members.every((m) => windowOpen.has(m.journal_entry_id))
      const ok = holds(members, whole ? windowOpen : spanOpen)
      for (const m of members) {
        const amount = windowOpen.get(m.journal_entry_id)
        if (amount === undefined) continue
        if (ok && amount !== null) settled.set(m.journal_entry_id, { member: m, amount, outside_window: !whole })
        else broken.set(m.journal_entry_id, m)
      }
    }
    return { settled, broken, groups }
  } catch (err) {
    log.warn('ledger settlement read failed; every verifikat stays listed', {
      companyId,
      accountNumber,
      error: err instanceof Error ? err.message : String(err),
    })
    return nothing()
  }
}
