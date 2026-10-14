import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { dbError } from '@/lib/errors/db-error'
import { isUuid } from '@/lib/invariants/uuid'
import { createLogger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import { formatCurrency } from '@/lib/utils'
import { resolveSkattekontoAccount, type SkattekontoLedgerAccount } from '@/lib/skatteverket/skattekonto-account'
import { linkSkattekontoRow, unlinkSkattekontoRow } from '@/lib/skatteverket/skattekonto-link'
import {
  fetchLiveLedgerSettlements,
  insertLedgerSettlement,
  stampLedgerSettlementUndone,
} from './ledger-settlement-store'
import { getSkattekontoReconciliationStatus, skattekontoOpenLedger } from './skattekonto-reconciliation'

const log = createLogger('reconciliation/skattekonto-split')

/**
 * ONE Skatteverket event over SEVERAL open verifikat on 1630 (crm#1183; "1630"
 * in this file is the company's skattekonto account, 2012 for an enskild firma
 * that runs it there, lib/skatteverket/skattekonto-account.ts): the
 * skattekonto mirror of the bank's 1:N split (#1553). Typical shape: an
 * imported verifikat that booked the event at the wrong amount and a second
 * verifikat that corrected it (+37 and -8 for a +29 event), so no single
 * verifikat settles the row and the link was refused as UNSUPPORTED_PAIR_SHAPE
 * although the reconciliation already showed the rows as covered.
 *
 * The policy is the ledger settlement's sentence: what you can link is what
 * the open ledger list shows, at the amount it shows. Every verifikat must be
 * in the skattekonto engine's unmatched_ledger list now (posted, a line on
 * 1630, not the ingående balans, not a makulering, inside the fetched
 * history, not fully explained by rows already linked) and in no live
 * settlement, and the open amounts must sum to the event's amount exactly,
 * to the öre. Nothing is booked and no verifikat changes.
 *
 * Storage, with no table of its own: a skattekonto row has ONE pointer
 * (skattekonto_transactions.journal_entry_id), which every reader of "is
 * this event booked" already trusts. The row is linked to one of the
 * verifikat (the primary: same sign as the event, largest open amount), with
 * the remainder that leaves on it, exactly as allow_remainder links a row to
 * a summarised verifikat (crm#1043). The primary's remainder and the other
 * verifikat then sum to zero, and that is recorded as a settlement on 1630
 * in account_reconciliation_settlements (who, when, the amounts; undo stamps,
 * never deletes), the table the bank's verifikat-against-verifikat
 * settlements use. The engine honours it only while it still sums to zero,
 * so no stored row can make the bridge claim what the ledger does not say,
 * and unexplained_difference cannot move.
 *
 * Undo is the row's unlink (unmatchLink), which also stamps the settlement.
 * The reverse shape, several rows against ONE verifikat, is the row pointer
 * alone (linkSkattekontoRows) and is untouched; several rows against several
 * verifikat stays UNSUPPORTED_PAIR_SHAPE.
 */

export type SkattekontoSplitRefusal =
  | 'UNSUPPORTED_PAIR_SHAPE'
  | 'NOT_FOUND'
  | 'ROW_IGNORED'
  | 'ALREADY_LINKED'
  | 'ENTRY_NOT_FOUND'
  | 'ENTRY_REVERSED'
  | 'ENTRY_NOT_OPEN'
  | 'ALREADY_SETTLED'
  | 'PAIR_NOT_CLOSED'
  | 'LINK_RACE'

export interface SkattekontoSplitSlice {
  journal_entry_id: string
  /** What the verifikat holds open on 1630 and the event now explains (ledger sign). */
  amount: number
}

export type SplitSkattekontoResult =
  | {
      ok: true
      slices: SkattekontoSplitSlice[]
      /** The verifikat the row's pointer goes to. */
      primary_journal_entry_id: string
      /** Null on a dry run: nothing was written. */
      settlement_id: string | null
    }
  | { ok: false; code: SkattekontoSplitRefusal; message: string }

/** Most verifikat one event is spread over (the settlement's own bound). */
export const MAX_SKATTEKONTO_SPLIT = 50

function refuse(code: SkattekontoSplitRefusal, message: string): SplitSkattekontoResult {
  return { ok: false, code, message }
}

const toOre = (n: number) => Math.round(n * 100)
const kr = (n: number) => formatCurrency(n, 'SEK', { minimumFractionDigits: 2 })

export async function splitSkattekontoRow(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  rowId: string,
  journalEntryIds: string[],
  options: {
    dryRun?: boolean
    /** The slices a staged preview showed; refused unless each still equals the open amount. */
    allocations?: Array<{ journal_entry_id: string; amount: number }>
    /** The company's skattekonto account when the caller resolved it; read here otherwise. */
    account?: SkattekontoLedgerAccount
  } = {},
): Promise<SplitSkattekontoResult> {
  const ids = [...new Set(journalEntryIds)]
  if (ids.length !== journalEntryIds.length) {
    return refuse('UNSUPPORTED_PAIR_SHAPE', 'Samma verifikat förekommer flera gånger i paret.')
  }
  if (ids.length < 2 || ids.length > MAX_SKATTEKONTO_SPLIT) {
    return refuse('UNSUPPORTED_PAIR_SHAPE', `En händelse kan kopplas mot 2 till ${MAX_SKATTEKONTO_SPLIT} verifikat.`)
  }
  for (const id of [rowId, ...ids]) {
    if (!isUuid(id)) return refuse('NOT_FOUND', `${id} är inget giltigt id. Kontrollera id:t.`)
  }

  const { data: row, error: rowError } = await supabase
    .from('skattekonto_transactions')
    .select('id, belopp_skatteverket, journal_entry_id, is_ignored, status')
    .eq('id', rowId)
    .eq('company_id', companyId)
    .maybeSingle<{
      id: string
      belopp_skatteverket: number | string
      journal_entry_id: string | null
      is_ignored: boolean | null
      status: string
    }>()
  if (rowError) throw dbError(rowError, 'Kunde inte läsa skattekonto-transaktionen')
  if (!row) return refuse('NOT_FOUND', `Skattekonto-transaktionen ${rowId} finns inte i företaget. Kontrollera id:t.`)
  if (row.is_ignored) return refuse('ROW_IGNORED', 'Händelsen är ignorerad. Återställ den innan du kopplar.')
  if (row.journal_entry_id) return refuse('ALREADY_LINKED', 'Händelsen är redan kopplad till ett verifikat.')
  if (row.status !== 'booked') return refuse('PAIR_NOT_CLOSED', 'En kommande händelse kan inte kopplas ännu.')
  const account = options.account ?? (await resolveSkattekontoAccount(supabase, companyId))
  const eventOre = toOre(Number(row.belopp_skatteverket))
  if (!Number.isFinite(eventOre) || eventOre === 0) {
    return refuse('PAIR_NOT_CLOSED', `En händelse på 0 kr flyttar inget på ${account} och kopplas inte mot verifikat.`)
  }

  const { data: entryRows, error: entryError } = await supabase
    .from('journal_entries')
    .select('id, status, entry_date, voucher_series, voucher_number')
    .eq('company_id', companyId)
    .in('id', ids)
  if (entryError) throw dbError(entryError, 'Kunde inte läsa verifikaten')
  const entries = new Map(
    ((entryRows ?? []) as Array<{
      id: string
      status: string
      entry_date: string
      voucher_series: string | null
      voucher_number: number | null
    }>).map((e) => [e.id, e]),
  )
  for (const id of ids) {
    const entry = entries.get(id)
    if (!entry) return refuse('ENTRY_NOT_FOUND', `Verifikationen ${id} finns inte i företaget. Kontrollera id:t.`)
    if (entry.status === 'reversed') {
      return refuse('ENTRY_REVERSED', `Verifikat ${formatVoucher(entry)} (${id}) är makulerat och kan inte kopplas.`)
    }
    if (entry.status !== 'posted') return refuse('ENTRY_NOT_FOUND', `Verifikationen ${id} är inte bokförd.`)
  }
  const label = (id: string) => formatVoucher(entries.get(id)!)

  const live = await fetchLiveLedgerSettlements(supabase, companyId, account)
  const taken = live.find((m) => ids.includes(m.journal_entry_id))
  if (taken) {
    return refuse(
      'ALREADY_SETTLED',
      `Verifikat ${label(taken.journal_entry_id)} ingår redan i en annan koppling på ${account}. Koppla bort den först (${taken.settlement_id}).`,
    )
  }

  // The engine's own open list, so "open" has one definition.
  const status = await getSkattekontoReconciliationStatus(supabase, companyId, { account })
  const openLedger = status ? skattekontoOpenLedger(status) : null
  if (!status || !openLedger) return refuse('NOT_FOUND', 'Skattekontot är inte hämtat för företaget.')
  if (status.ledger_read_failed) throw new Error(`Kunde inte läsa bokföringen på ${account}. Försök igen.`)

  const slices: SkattekontoSplitSlice[] = []
  let totalOre = 0
  for (const id of ids) {
    const open = openLedger.get(id)
    if (!open) {
      return refuse(
        'ENTRY_NOT_OPEN',
        `Verifikat ${label(id)} står inte bland verifikaten på ${account} utan händelse hos Skatteverket: det är redan förklarat av kopplade händelser, saknar rad på ${account}, är en ingående balans eller en makulering, eller ligger före den hämtade historiken.`,
      )
    }
    slices.push({ journal_entry_id: id, amount: open.amount })
    totalOre += toOre(open.amount)
  }
  if (totalOre !== eventOre) {
    return refuse(
      'PAIR_NOT_CLOSED',
      `Verifikaten har tillsammans ${kr(totalOre / 100)} öppet på ${account} och händelsen är ${kr(eventOre / 100)}. En händelse kopplas mot flera verifikat bara när de tillsammans är exakt händelsens belopp.`,
    )
  }
  if (options.allocations) {
    const given = new Map(options.allocations.map((a) => [a.journal_entry_id, a.amount]))
    const sameSet = given.size === options.allocations.length && given.size === ids.length && ids.every((id) => given.has(id))
    if (!sameSet) {
      return refuse('UNSUPPORTED_PAIR_SHAPE', 'allocations måste ange ett belopp för varje verifikat i paret, och inga andra.')
    }
    const changed = slices.find((s) => toOre(Number(given.get(s.journal_entry_id))) !== toOre(s.amount))
    if (changed) {
      return refuse(
        'PAIR_NOT_CLOSED',
        `Verifikat ${label(changed.journal_entry_id)} har ${kr(changed.amount)} öppet på ${account}, inte ${kr(Number(given.get(changed.journal_entry_id)))}. På skattekontot kopplas varje verifikat med hela sitt öppna belopp.`,
      )
    }
  }

  // The pointer goes to the verifikat that carries the event's sign the most;
  // date, then id, decide a tie so a dry run and its commit agree.
  const primary = [...slices]
    .filter((s) => Math.sign(s.amount) === Math.sign(eventOre))
    .sort(
      (a, b) =>
        Math.abs(b.amount) - Math.abs(a.amount) ||
        entries.get(a.journal_entry_id)!.entry_date.localeCompare(entries.get(b.journal_entry_id)!.entry_date) ||
        a.journal_entry_id.localeCompare(b.journal_entry_id),
    )[0]
  if (!primary) {
    return refuse('PAIR_NOT_CLOSED', `Inget av verifikaten har händelsens tecken på ${account}.`)
  }
  if (options.dryRun) {
    return { ok: true, slices, primary_journal_entry_id: primary.journal_entry_id, settlement_id: null }
  }

  // What the settlement records: the primary's remainder once the row is on
  // it (left out when the row explains it all), and the others whole. They
  // sum to zero because the slices sum to the event.
  const primaryRemainder = roundOre(primary.amount - eventOre / 100)
  const members = [
    ...(primaryRemainder !== 0 ? [{ journal_entry_id: primary.journal_entry_id, amount: primaryRemainder }] : []),
    ...slices.filter((s) => s.journal_entry_id !== primary.journal_entry_id),
  ]

  // The row's guarded pointer first: a concurrent link of the row makes it
  // throw LINK_RACE before anything else is written.
  await linkSkattekontoRow(supabase, companyId, rowId, primary.journal_entry_id, { allowRemainder: true, account })
  const settlementId = randomUUID()
  const written = await insertLedgerSettlement(supabase, companyId, {
    settlement_id: settlementId,
    account_number: account,
    settled_by: userId,
    entries: members,
  })
  if (!written.ok) {
    // Never leave the row on the primary with the rest unexplained.
    try {
      await unlinkSkattekontoRow(supabase, companyId, rowId)
    } catch (err) {
      log.error('split rollback failed: the row stays linked to its primary verifikat', {
        companyId,
        rowId,
        journalEntryId: primary.journal_entry_id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    if (written.duplicate) {
      return refuse('LINK_RACE', 'Ett av verifikaten kopplades precis av någon annan. Ladda om och försök igen.')
    }
    throw new Error(`Kunde inte koppla händelsen mot verifikaten: ${written.message}`)
  }
  log.info('skattekonto row split over verifikat', { companyId, rowId, settlementId, entries: ids.length })
  return { ok: true, slices, primary_journal_entry_id: primary.journal_entry_id, settlement_id: settlementId }
}

/**
 * After a row is unlinked from `journalEntryId`: the live 1630 settlement
 * that verifikat is in can no longer sum to zero (its open amount just grew
 * by the row), so it is stamped undone with the link it belonged to. Returns
 * the settlement id, or null when the verifikat was in none.
 */
export async function releaseSkattekontoSettlementOf(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  journalEntryId: string,
  skattekontoAccount?: SkattekontoLedgerAccount,
): Promise<string | null> {
  const account = skattekontoAccount ?? (await resolveSkattekontoAccount(supabase, companyId))
  const live = await fetchLiveLedgerSettlements(supabase, companyId, account)
  const member = live.find((m) => m.journal_entry_id === journalEntryId)
  if (!member) return null
  await stampLedgerSettlementUndone(supabase, companyId, account, member.settlement_id, userId)
  return member.settlement_id
}

/**
 * Undo a 1630 settlement by its id (an item's settlement.settlement_id): its
 * verifikat return to the open list. The row a 1:N link put on the primary
 * stays linked to it with its remainder; unlink the row to undo the link.
 * Null when the id is no live settlement on 1630.
 */
export async function undoSkattekontoSettlement(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  settlementId: string,
  skattekontoAccount?: SkattekontoLedgerAccount,
): Promise<{ settlement_id: string; journal_entry_ids: string[] } | null> {
  if (!isUuid(settlementId)) return null
  const account = skattekontoAccount ?? (await resolveSkattekontoAccount(supabase, companyId))
  const journalEntryIds = await stampLedgerSettlementUndone(supabase, companyId, account, settlementId, userId)
  if (journalEntryIds.length === 0) return null
  log.info('skattekonto settlement undone', { companyId, settlementId, entries: journalEntryIds.length })
  return { settlement_id: settlementId, journal_entry_ids: journalEntryIds }
}
