import type { SupabaseClient } from '@supabase/supabase-js'
import { dbError } from '@/lib/errors/db-error'
import { roundOre } from '@/lib/money'
import { formatCurrency } from '@/lib/utils'
import { resolveSkattekontoAccount, type SkattekontoLedgerAccount } from './skattekonto-account'

/**
 * Link semantics for a skattekonto row (core).
 *
 * A link pairs SKV-posted rows with ONE verifikat whose movement on the
 * skattekonto account (1630, or 2012 for an enskild firma that runs it there:
 * lib/skatteverket/skattekonto-account.ts; "1630" below means that account)
 * the rows settle on the expected side (positive belopp = money into the
 * skattekonto = debit 1630). Several rows may share one verifikat (one
 * combined AGI line for avdragen skatt + arbetsgivaravgift, or a payment and
 * a debit booked in the same voucher); see groupSettlesEntry for the rule.
 *
 * A summarised verifikat (one year-end or month-end voucher that books many
 * events, some of them from before the fetched history) is settled by no
 * group of rows at all. Rows can still be linked to it on the caller's
 * explicit `allowRemainder` (crm#1043): the link explains exactly the rows'
 * amount, and what the verifikat holds on 1630 beyond the rows linked to it
 * is its remainder, which the reconciliation keeps on the ledger side
 * (lib/reconciliation/skattekonto-reconciliation.ts). See
 * evaluateSkattekontoLink.
 *
 * It writes nothing to the verifikat:
 * `skattekonto_transactions.journal_entry_id` is the only thing that changes,
 * so linking and unlinking are allowed in locked periods and need no storno.
 *
 * Lives in core so the reconciliation engine (lib/reconciliation), the
 * dashboard routes, the v1 API and the MCP executors share one implementation;
 * the skatteverket extension's matchSkattekontoToEntry delegates here.
 */

export type SkattekontoLinkErrorCode =
  | 'TRANSACTION_NOT_FOUND'
  | 'ALREADY_BOOKED'
  | 'ROW_IGNORED'
  | 'ENTRY_NOT_FOUND'
  | 'ENTRY_ALREADY_LINKED'
  | 'INVALID_CANDIDATE'
  /**
   * A row goes the opposite way to everything the verifikat books on the
   * account (money out against a debit-only verifikat, or the reverse): not
   * the same event, and no remainder makes it one (crm#1846).
   */
  | 'WRONG_DIRECTION'
  | 'NOT_LINKED'
  | 'LINK_RACE'
  /** Bank rows on the account-keyed surface: the row's verifikat is its booking, not a link (isUnlinkableBankLink). */
  | 'LINK_IS_BOOKING'

export class SkattekontoLinkError extends Error {
  constructor(
    message: string,
    public readonly code: SkattekontoLinkErrorCode,
    /** ENTRY_ALREADY_LINKED: the rows that hold the verifikat, so the caller can name or unlink them. */
    public readonly linkedRowIds?: string[],
  ) {
    super(message)
    this.name = 'SkattekontoLinkError'
  }
}

interface RowForLink {
  id: string
  belopp_skatteverket: number | string
  journal_entry_id: string | null
  is_ignored: boolean | null
  status: 'booked' | 'upcoming'
}

interface EntryForLink {
  id: string
  status: 'draft' | 'posted' | 'reversed'
  lines: Array<{ account_number: string; debit_amount: number | string; credit_amount: number | string }> | null
}

function expectedSide(belopp: number): 'debit' | 'credit' {
  return belopp > 0 ? 'debit' : 'credit'
}

/**
 * Does this entry settle the row? True when a single 1630 line equals the
 * amount on the expected side, or when the entry's 1630 lines net to it (a
 * manual voucher that split the movement over two lines). Exported for the
 * engine's pair validation.
 */
export function entrySettlesAmount(
  lines: EntryForLink['lines'],
  belopp: number,
  account: SkattekontoLedgerAccount,
): { ok: boolean; via: 'line' | 'entry_total' | null } {
  const amount = roundOre(Math.abs(belopp))
  const side = expectedSide(belopp)
  const onAccount = (lines ?? []).filter((l) => l.account_number === account)
  if (onAccount.length === 0) return { ok: false, via: null }
  const single = onAccount.some((l) => {
    const debit = roundOre(Number(l.debit_amount))
    const credit = roundOre(Number(l.credit_amount))
    return side === 'debit' ? debit === amount && credit === 0 : credit === amount && debit === 0
  })
  if (single) return { ok: true, via: 'line' }
  const net = roundOre(
    onAccount.reduce((s, l) => s + Number(l.debit_amount || 0) - Number(l.credit_amount || 0), 0),
  )
  const signed = side === 'debit' ? amount : -amount
  if (onAccount.length > 1 && net === signed) return { ok: true, via: 'entry_total' }
  return { ok: false, via: null }
}

/**
 * How a link was accepted. 'partial': the rows do not settle the verifikat's
 * 1630 movement, and the caller linked them anyway (allowRemainder).
 */
export type SkattekontoSettleVia = 'line' | 'entry_total' | 'lines' | 'partial'

/** Upper bounds for the exact line assignment; beyond them it is not attempted. */
const MAX_ASSIGN_EVENTS = 12
const MAX_ASSIGN_LINES = 20

function toOre(value: number | string | null | undefined): number {
  return Math.round(Number(value || 0) * 100)
}

/**
 * Can the events be split into groups so that every group sums EXACTLY to a
 * distinct 1630 line of the entry, every event is used, every 1630 line is
 * used, and each event sits on its line's side? Full coverage keeps the
 * reconciliation identity intact: the linked rows then sum to the entry's
 * 1630 net, which is what a live link removes from the bridge.
 */
function assignsToLines(
  lines: EntryForLink['lines'],
  belopps: number[],
  account: SkattekontoLedgerAccount,
): boolean {
  const lineOre = (lines ?? [])
    .filter((l) => l.account_number === account)
    .map((l) => toOre(l.debit_amount) - toOre(l.credit_amount))
    .filter((v) => v !== 0)
  const events = belopps.map((b) => toOre(b))
  if (lineOre.length === 0 || events.length === 0) return false
  if (events.length > MAX_ASSIGN_EVENTS || lineOre.length > MAX_ASSIGN_LINES) return false
  if (events.some((e) => e === 0)) return false
  if (events.length < lineOre.length) return false
  const total = events.reduce((s, e) => s + e, 0)
  if (total !== lineOre.reduce((s, v) => s + v, 0)) return false

  // Largest first prunes fastest; remaining capacity shrinks toward 0.
  const sorted = [...events].sort((a, b) => Math.abs(b) - Math.abs(a))
  const remaining = [...lineOre]
  const place = (i: number): boolean => {
    if (i === sorted.length) return remaining.every((r) => r === 0)
    const e = sorted[i]
    const tried = new Set<number>()
    for (let j = 0; j < remaining.length; j++) {
      const r = remaining[j]
      if (r === 0 || Math.sign(r) !== Math.sign(e) || Math.abs(e) > Math.abs(r)) continue
      if (tried.has(r)) continue // identical capacity: same subtree
      tried.add(r)
      remaining[j] = r - e
      if (place(i + 1)) return true
      remaining[j] = r
    }
    return false
  }
  return place(0)
}

/**
 * Do these SKV rows, together, settle this entry's 1630 movement?
 *
 *   * one row: entrySettlesAmount (a single line, or the entry's net).
 *   * several rows, non-zero sum: the SUM settles the entry the same way (one
 *     combined 1630 line for avdragen skatt + arbetsgivaravgift, crm#128).
 *   * otherwise (for example a net-zero pair, crm#104: a payment into the
 *     skattekonto and the debit it paid, booked in one voucher): every row
 *     maps onto its own 1630 line(s) exactly, covering all of them.
 *
 * Exact öre only; there is no tolerance. `via` says which rule held.
 */
export function groupSettlesEntry(
  lines: EntryForLink['lines'],
  belopps: number[],
  account: SkattekontoLedgerAccount,
): { ok: boolean; via: SkattekontoSettleVia | null } {
  if (belopps.length === 0) return { ok: false, via: null }
  if (belopps.length === 1) return entrySettlesAmount(lines, belopps[0], account)
  const sum = roundOre(belopps.reduce((s, b) => s + Number(b), 0))
  if (sum !== 0) {
    const bySum = entrySettlesAmount(lines, sum, account)
    if (bySum.ok) return bySum
  }
  if (assignsToLines(lines, belopps, account)) return { ok: true, via: 'lines' }
  return { ok: false, via: null }
}

/**
 * Net debit - credit of the entry's 1630 lines, and whether it moves 1630 at
 * all (at least one line with an amount). Ledger sign: debit positive, the
 * same sign as a Skatteverket amount.
 */
export function skattekontoEntryNet(
  lines: EntryForLink['lines'],
  account: SkattekontoLedgerAccount,
): { net: number; hasLine: boolean } {
  const onAccount = (lines ?? []).filter((l) => l.account_number === account)
  const ore = onAccount.reduce((s, l) => s + toOre(l.debit_amount) - toOre(l.credit_amount), 0)
  const hasLine = onAccount.some((l) => toOre(l.debit_amount) !== 0 || toOre(l.credit_amount) !== 0)
  return { net: ore / 100, hasLine }
}

export interface SkattekontoLinkEvaluation {
  ok: boolean
  via: SkattekontoSettleVia | null
  /**
   * What the verifikat holds on 1630 beyond every row linked to it once this
   * link is made: its 1630 net minus the rows already linked and the new
   * ones, ledger sign. It may have either sign and exceed the net (rows of
   * the opposite sign outside the fetched history), but only on a verifikat
   * that books the rows' own direction: see 'wrong_direction'. 0 when the
   * rows explain the whole verifikat. NaN when an amount is unreadable.
   */
  remainder: number
  /** Why not, when ok is false. */
  reason: 'no_account_line' | 'wrong_direction' | 'not_settled' | null
  /** With 'wrong_direction': the side of the account a row needs and the verifikat books nothing on. */
  missingSide?: 'debit' | 'credit'
}

/**
 * The side a new row needs that the verifikat books nothing on, or null. A
 * positive amount is money into the skattekonto and needs a debit on the
 * account; a negative one needs a credit. Only a side with NO amount at all
 * counts: a summarised verifikat with lines on both sides takes rows of both
 * signs, in any order and up to any sum (crm#1043).
 */
function missingSideFor(
  lines: EntryForLink['lines'],
  newBelopps: number[],
  account: SkattekontoLedgerAccount,
): 'debit' | 'credit' | null {
  const onAccount = (lines ?? []).filter((l) => l.account_number === account)
  const debitOre = onAccount.reduce((s, l) => s + toOre(l.debit_amount), 0)
  const creditOre = onAccount.reduce((s, l) => s + toOre(l.credit_amount), 0)
  if (debitOre === 0 && newBelopps.some((b) => Number(b) > 0)) return 'debit'
  if (creditOre === 0 && newBelopps.some((b) => Number(b) < 0)) return 'credit'
  return null
}

/**
 * May `newBelopps` be linked to an entry that already carries `linkedBelopps`?
 *
 *   * the whole group settles the entry (groupSettlesEntry): yes, as before.
 *     A single matching 1630 line of a verifikat with more lines on 1630
 *     still counts, and the other lines then show as the remainder.
 *   * never when a new row goes the opposite way to everything the entry
 *     books on 1630 (missingSideFor): 'wrong_direction', with or without
 *     `allowRemainder`. Such a link "left" more on the verifikat than it
 *     holds (a 10 000 verifikat against a row of -10 000 reported a
 *     remainder of 20 000, crm#1846); the pair is simply not the same event.
 *   * otherwise only with `allowRemainder`, and only when the entry moves
 *     1630 at all: `via: 'partial'`. Nothing is hidden by such a link: the
 *     rows leave the Skatteverket side and the same amount leaves the ledger
 *     side, so the reconciliation's unexplained figure cannot change.
 *
 * Pure, so the live link and the dry run share it.
 */
export function evaluateSkattekontoLink(
  lines: EntryForLink['lines'],
  linkedBelopps: number[],
  newBelopps: number[],
  options: { allowRemainder?: boolean; account: SkattekontoLedgerAccount },
): SkattekontoLinkEvaluation {
  const all = [...linkedBelopps, ...newBelopps]
  const { net, hasLine } = skattekontoEntryNet(lines, options.account)
  const remainder = roundOre(net - all.reduce((s, b) => s + Number(b), 0))
  const settles = newBelopps.length > 0 ? groupSettlesEntry(lines, all, options.account) : { ok: false, via: null }
  if (settles.ok && settles.via) return { ok: true, via: settles.via, remainder, reason: null }
  if (!hasLine) return { ok: false, via: null, remainder, reason: 'no_account_line' }
  const missingSide = missingSideFor(lines, newBelopps, options.account)
  if (missingSide) return { ok: false, via: null, remainder, reason: 'wrong_direction', missingSide }
  const readable = newBelopps.length > 0 && all.every((b) => Number.isFinite(Number(b)))
  if (options.allowRemainder && readable) return { ok: true, via: 'partial', remainder, reason: null }
  return { ok: false, via: null, remainder, reason: 'not_settled' }
}

function kr(amount: number): string {
  return formatCurrency(amount, 'SEK', { minimumFractionDigits: 2 })
}

/**
 * The refusal for rows that do not settle the verifikat. It names both sums
 * and the way to link anyway, because a summarised verifikat can never be
 * settled exactly by the rows we hold.
 */
export function skattekontoLinkRefusal(
  evaluation: SkattekontoLinkEvaluation,
  facts: {
    entryNet: number
    rowsTotal: number
    rowCount: number
    alreadyLinked: number
    /** The rows already on the verifikat, when the caller read them: their sum and ids. */
    linkedTotal?: number
    linkedIds?: string[]
    account: SkattekontoLedgerAccount
  },
): { message: string; code: SkattekontoLinkErrorCode } {
  const account = facts.account
  if (evaluation.reason === 'no_account_line') {
    return {
      message: `Verifikatet har ingen rad på ${account} och kan inte kopplas till en händelse på skattekontot.`,
      code: 'INVALID_CANDIDATE',
    }
  }
  if (evaluation.reason === 'wrong_direction') {
    // No allow_remainder hint: the remainder of such a pair is the two
    // amounts added together, and the flag cannot turn the pair around.
    const one = facts.rowCount === 1
    const rows = one ? 'händelsen' : 'minst en av de valda händelserna'
    const [rowWay, entrySide, wantedSide] =
      evaluation.missingSide === 'credit'
        ? ['ett belopp ut från skattekontot', 'debet', 'kredit']
        : ['ett belopp in på skattekontot', 'kredit', 'debet']
    return {
      message:
        `Riktningen stämmer inte: ${rows} är ${rowWay} (${wantedSide} ${account}), men verifikatet bokför bara ${entrySide} på ${account}.` +
        ` Verifikatet har ${kr(facts.entryNet)} på ${account} och ${one ? 'händelsen' : 'händelserna'} är ${kr(facts.rowsTotal)}.` +
        ` Det är inte samma händelse, och allow_remainder ändrar inte det. Koppla i stället mot ett verifikat som bokför ${wantedSide} på ${account} (de öppna verifikaten finns under "I bokföringen, saknas hos Skatteverket"), eller bokför händelsen om den saknas i bokföringen.`,
      code: 'WRONG_DIRECTION',
    }
  }
  if (facts.alreadyLinked > 0) {
    return { message: alreadyLinkedMessage(evaluation, facts), code: 'ENTRY_ALREADY_LINKED' }
  }
  const lead =
    facts.rowCount > 1
      ? `Verifikatets rader på ${account} motsvarar inte summan av de valda händelserna.`
      : `Verifikatet saknar en matchande rad på ${account}.`
  const sums = Number.isFinite(evaluation.remainder)
    ? ` Verifikatet har ${kr(facts.entryNet)} på ${account} och ${facts.rowCount > 1 ? 'händelserna' : 'händelsen'} är ${kr(facts.rowsTotal)}.` +
      ` Är det ett samlingsverifikat som täcker fler händelser kan du koppla ändå med allow_remainder: ${kr(evaluation.remainder)} står då kvar på verifikatet under "I bokföringen, saknas hos Skatteverket".`
    : ''
  return { message: `${lead}${sums}`, code: 'INVALID_CANDIDATE' }
}

/** Ids named in a refusal; the rest are counted. */
const MAX_NAMED_LINKED_ROWS = 5

/**
 * The verifikat is held by other rows. Says which (count, sum, ids), because
 * the open list does not always show them: a row that is still "kommande", or
 * dated after the saldo that was fetched, holds its verifikat without being
 * counted in the comparison (crm#1846). And says what to do: unlink the
 * holder when that link is the wrong one. allow_remainder is offered only
 * while the verifikat has something left beyond the rows already on it.
 */
function alreadyLinkedMessage(
  evaluation: SkattekontoLinkEvaluation,
  facts: Parameters<typeof skattekontoLinkRefusal>[1],
): string {
  const account = facts.account
  const ids = facts.linkedIds ?? []
  const named =
    ids.length > 0
      ? ` (${ids.slice(0, MAX_NAMED_LINKED_ROWS).join(', ')}${ids.length > MAX_NAMED_LINKED_ROWS ? ` och ${ids.length - MAX_NAMED_LINKED_ROWS} till` : ''})`
      : ''
  const held =
    typeof facts.linkedTotal === 'number' && Number.isFinite(facts.linkedTotal)
      ? ` ${facts.alreadyLinked} ${facts.alreadyLinked > 1 ? 'händelser är kopplade' : 'händelse är kopplad'} till det, sammanlagt ${kr(facts.linkedTotal)}${named}.`
      : ''
  const sums = Number.isFinite(evaluation.remainder)
    ? ` Verifikatet har ${kr(facts.entryNet)} på ${account} och ${facts.rowCount > 1 ? 'de valda händelserna' : 'den valda händelsen'} är ${kr(facts.rowsTotal)}.`
    : ''
  const open =
    typeof facts.linkedTotal === 'number' && Number.isFinite(facts.linkedTotal)
      ? roundOre(facts.entryNet - facts.linkedTotal)
      : null
  const next =
    open === 0
      ? ' Inget står kvar på verifikatet att koppla mot. Är den befintliga kopplingen fel, koppla bort den händelsen först (reconcile_unmatch med händelsens id) och koppla sedan om. Annars hör de valda händelserna till ett annat verifikat, eller är dubbletter av de redan kopplade.'
      : Number.isFinite(evaluation.remainder)
        ? ` Är den befintliga kopplingen fel, koppla bort den händelsen först (reconcile_unmatch med händelsens id). Är det ett samlingsverifikat som täcker fler händelser kan du koppla ändå med allow_remainder: ${kr(evaluation.remainder)} står då kvar på verifikatet under "I bokföringen, saknas hos Skatteverket".`
        : ''
  return `Verifikatet är redan kopplat till en annan skattekonto-transaktion.${held}${sums}${next}`
}

/** A remainder link needs a verifikat that is in the ledger: a draft can still change. */
const PARTIAL_NEEDS_POSTED = 'Bara ett bokfört verifikat kan kopplas med ett återstående belopp.'

export interface SkattekontoLinkOptions {
  /**
   * Link although the rows do not settle the verifikat's 1630 movement (a
   * summarised verifikat). Never a default: only the caller's explicit
   * choice, made with the remainder in view.
   */
  allowRemainder?: boolean
  /** The company's skattekonto account when the caller resolved it; read here otherwise. */
  account?: SkattekontoLedgerAccount
}

/** Swedish, shown as is: a failed read of the rows already on a verifikat. */
export const LINKED_ROWS_READ_FAILED =
  'Det gick inte att läsa vilka skattekontohändelser som redan är kopplade till verifikatet. Försök igen.'

/**
 * Rows already linked to an entry, with the amounts the group check needs.
 * A failed read throws (accounted#58): read as "none linked", a verifikat
 * another row already explains would settle this one too and be linked twice.
 */
async function fetchLinkedRows(
  supabase: SupabaseClient,
  companyId: string,
  journalEntryId: string,
): Promise<Array<{ id: string; belopp_skatteverket: number | string }>> {
  const { data, error } = await supabase
    .from('skattekonto_transactions')
    .select('id, belopp_skatteverket')
    .eq('company_id', companyId)
    .eq('journal_entry_id', journalEntryId)
  if (error) throw new Error(LINKED_ROWS_READ_FAILED)
  if (Array.isArray(data)) return data as Array<{ id: string; belopp_skatteverket: number | string }>
  return data ? [data as { id: string; belopp_skatteverket: number | string }] : []
}

type LinkedRow = { id: string; belopp_skatteverket: number | string }

/** The sum and ids of the rows already on a verifikat, for the refusal that names them. */
function linkedFacts(rows: LinkedRow[]): { linkedTotal: number; linkedIds: string[] } {
  return {
    linkedTotal: roundOre(rows.reduce((s, r) => s + Number(r.belopp_skatteverket), 0)),
    linkedIds: rows.map((r) => r.id),
  }
}

function heldBy(code: SkattekontoLinkErrorCode, rows: LinkedRow[]): string[] | undefined {
  return code === 'ENTRY_ALREADY_LINKED' ? rows.map((r) => r.id) : undefined
}

/**
 * The rows that hold each of the given verifikat: EVERY row whose pointer is
 * set, whatever its status or date, which is what a new link is judged
 * against. One read for the dry run and the staged preview, so the two never
 * differ on what a verifikat already carries. Pass at most one `in` chunk of
 * ids. Throws on a failed read.
 */
export async function fetchRowsLinkedToEntries(
  supabase: SupabaseClient,
  companyId: string,
  journalEntryIds: string[],
): Promise<Array<{ id: string; journal_entry_id: string; amount: number }>> {
  const { data, error } = await supabase
    .from('skattekonto_transactions')
    .select('id, journal_entry_id, belopp_skatteverket')
    .eq('company_id', companyId)
    .in('journal_entry_id', journalEntryIds)
  if (error) throw dbError(error, 'Kunde inte läsa kopplade rader')
  return ((data ?? []) as Array<{ id: string; journal_entry_id: string | null; belopp_skatteverket: number | string | null }>).flatMap(
    (r) => (r.journal_entry_id ? [{ id: r.id, journal_entry_id: r.journal_entry_id, amount: Number(r.belopp_skatteverket) }] : []),
  )
}

export interface LinkSkattekontoRowResult {
  skattekonto_transaction_id: string
  journal_entry_id: string
  via: SkattekontoSettleVia
  /** What the verifikat still holds on 1630 beyond the rows linked to it (ledger sign); 0 when fully explained. */
  remainder: number
}

/**
 * Link one open SKV row to one verifikat. Throws SkattekontoLinkError with a
 * stable code on every refusal; the write is guarded on journal_entry_id IS
 * NULL so a concurrent link loses cleanly (LINK_RACE).
 */
export async function linkSkattekontoRow(
  supabase: SupabaseClient,
  companyId: string,
  transactionId: string,
  journalEntryId: string,
  options: SkattekontoLinkOptions = {},
): Promise<LinkSkattekontoRowResult> {
  const { data: row, error: rowError } = await supabase
    .from('skattekonto_transactions')
    .select('id, belopp_skatteverket, journal_entry_id, is_ignored, status')
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .maybeSingle<RowForLink>()
  if (rowError || !row) {
    throw new SkattekontoLinkError('Skattekonto-transaktionen hittades inte.', 'TRANSACTION_NOT_FOUND')
  }
  if (row.journal_entry_id) {
    throw new SkattekontoLinkError('Transaktionen är redan kopplad till ett verifikat.', 'ALREADY_BOOKED')
  }
  if (row.is_ignored) {
    throw new SkattekontoLinkError('Transaktionen är ignorerad. Återställ den innan du kopplar.', 'ROW_IGNORED')
  }
  if (row.status !== 'booked') {
    throw new SkattekontoLinkError('En kommande händelse kan inte kopplas ännu.', 'INVALID_CANDIDATE')
  }

  const { data: entry, error: entryError } = await supabase
    .from('journal_entries')
    .select('id, status, lines:journal_entry_lines ( account_number, debit_amount, credit_amount )')
    .eq('id', journalEntryId)
    .eq('company_id', companyId)
    .maybeSingle<EntryForLink>()
  if (entryError || !entry) {
    throw new SkattekontoLinkError('Verifikatet hittades inte.', 'ENTRY_NOT_FOUND')
  }
  if (entry.status === 'reversed') {
    throw new SkattekontoLinkError('Verifikatet är makulerat och kan inte kopplas.', 'INVALID_CANDIDATE')
  }
  // Rows already on this verifikat join the check: a second event may share
  // it when the whole group still settles the 1630 movement (crm#104,
  // crm#128). Otherwise the verifikat is taken, unless the caller links with
  // a remainder (a summarised verifikat, crm#1043).
  const account = options.account ?? (await resolveSkattekontoAccount(supabase, companyId))
  const linkedRows = await fetchLinkedRows(supabase, companyId, journalEntryId)
  const belopp = Number(row.belopp_skatteverket)
  const settles = evaluateSkattekontoLink(
    entry.lines,
    linkedRows.map((r) => Number(r.belopp_skatteverket)),
    [belopp],
    { allowRemainder: options.allowRemainder, account },
  )
  if (!settles.ok || !settles.via) {
    const refusal = skattekontoLinkRefusal(settles, {
      entryNet: skattekontoEntryNet(entry.lines, account).net,
      rowsTotal: belopp,
      rowCount: 1,
      alreadyLinked: linkedRows.length,
      ...linkedFacts(linkedRows),
      account,
    })
    throw new SkattekontoLinkError(refusal.message, refusal.code, heldBy(refusal.code, linkedRows))
  }
  if (settles.via === 'partial' && entry.status !== 'posted') {
    throw new SkattekontoLinkError(PARTIAL_NEEDS_POSTED, 'INVALID_CANDIDATE')
  }

  const { data: updated, error: updateError } = await supabase
    .from('skattekonto_transactions')
    .update({ journal_entry_id: journalEntryId, suggested_journal_entry_id: null, suggested_at: null })
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .is('journal_entry_id', null)
    .select('id')
  if (updateError) {
    throw new SkattekontoLinkError(`Kunde inte koppla: ${updateError.message}`, 'LINK_RACE')
  }
  if (!updated || (Array.isArray(updated) && updated.length === 0)) {
    throw new SkattekontoLinkError('Transaktionen kopplades av någon annan samtidigt.', 'LINK_RACE')
  }

  return {
    skattekonto_transaction_id: transactionId,
    journal_entry_id: journalEntryId,
    via: settles.via,
    remainder: settles.remainder,
  }
}

/**
 * Remove the link. The verifikat is untouched (BFL: nothing is deleted or
 * edited in the ledger); only the row's pointer is cleared. Proposals are
 * recomputed on the next sync.
 */
export async function unlinkSkattekontoRow(
  supabase: SupabaseClient,
  companyId: string,
  transactionId: string,
): Promise<{ skattekonto_transaction_id: string; previous_journal_entry_id: string }> {
  const { data: row, error } = await supabase
    .from('skattekonto_transactions')
    .select('id, journal_entry_id')
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .maybeSingle<{ id: string; journal_entry_id: string | null }>()
  if (error || !row) {
    throw new SkattekontoLinkError('Skattekonto-transaktionen hittades inte.', 'TRANSACTION_NOT_FOUND')
  }
  if (!row.journal_entry_id) {
    throw new SkattekontoLinkError('Transaktionen är inte kopplad till något verifikat.', 'NOT_LINKED')
  }
  const { error: updateError } = await supabase
    .from('skattekonto_transactions')
    .update({ journal_entry_id: null })
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .eq('journal_entry_id', row.journal_entry_id)
  if (updateError) {
    throw new SkattekontoLinkError(`Kunde inte koppla bort: ${updateError.message}`, 'LINK_RACE')
  }
  return { skattekonto_transaction_id: transactionId, previous_journal_entry_id: row.journal_entry_id }
}

/**
 * Ignore / restore a row. An ignored row never carries a link (DB CHECK,
 * migration 20260819200000), so ignoring a linked row is refused here with a
 * clean code instead of a constraint error.
 */
export async function setSkattekontoRowIgnored(
  supabase: SupabaseClient,
  companyId: string,
  transactionId: string,
  ignored: boolean,
): Promise<{ skattekonto_transaction_id: string; is_ignored: boolean }> {
  const { data: row, error } = await supabase
    .from('skattekonto_transactions')
    .select('id, journal_entry_id, is_ignored')
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .maybeSingle<{ id: string; journal_entry_id: string | null; is_ignored: boolean | null }>()
  if (error || !row) {
    throw new SkattekontoLinkError('Skattekonto-transaktionen hittades inte.', 'TRANSACTION_NOT_FOUND')
  }
  if (ignored && row.journal_entry_id) {
    throw new SkattekontoLinkError('En kopplad händelse kan inte ignoreras. Koppla bort den först.', 'ALREADY_BOOKED')
  }
  if (Boolean(row.is_ignored) === ignored) {
    return { skattekonto_transaction_id: transactionId, is_ignored: ignored }
  }
  // Two literal payloads (not one conditional expression) so the phantom-column
  // guard can read the column set; ignoring also drops a standing proposal.
  // Ignoring is conditional on the row still being unlinked: a booking that
  // lands between the read above and this write makes it match zero rows
  // (ALREADY_BOOKED) instead of tripping the DB CHECK.
  const { data: updated, error: updateError } = ignored
    ? await supabase
        .from('skattekonto_transactions')
        .update({ is_ignored: true, suggested_journal_entry_id: null, suggested_at: null })
        .eq('id', transactionId)
        .eq('company_id', companyId)
        .is('journal_entry_id', null)
        .select('id')
    : await supabase
        .from('skattekonto_transactions')
        .update({ is_ignored: false })
        .eq('id', transactionId)
        .eq('company_id', companyId)
        .select('id')
  if (updateError) {
    throw new SkattekontoLinkError(`Kunde inte uppdatera: ${updateError.message}`, 'LINK_RACE')
  }
  if (!updated || updated.length === 0) {
    throw new SkattekontoLinkError('En kopplad händelse kan inte ignoreras. Koppla bort den först.', 'ALREADY_BOOKED')
  }
  return { skattekonto_transaction_id: transactionId, is_ignored: ignored }
}

export interface LinkSkattekontoRowsResult {
  journal_entry_id: string
  via: SkattekontoSettleVia
  skattekonto_transaction_ids: string[]
  /** What the verifikat still holds on 1630 beyond the rows linked to it (ledger sign); 0 when fully explained. */
  remainder: number
}

/**
 * Link SEVERAL open SKV rows to ONE verifikat: the N:1 worksheet selection
 * (one AGI verifikat settling the avdragen skatt + arbetsgivaravgift rows,
 * one payment verifikat covering a row pair, a payment and a debit booked in
 * one voucher). The rows, together with any rows already on the verifikat,
 * must settle its 1630 side (groupSettlesEntry), or the caller links them
 * with a remainder (`allowRemainder`: a summarised verifikat whose other
 * events we do not hold, crm#1043); each row then gets the same guarded pointer as
 * the single link. The write is ONE guarded UPDATE over the whole group: a
 * concurrent link shrinks the hit set, and a partial hit is rolled back and
 * reported as LINK_RACE, so a group is never left half-linked.
 */
export async function linkSkattekontoRows(
  supabase: SupabaseClient,
  companyId: string,
  transactionIds: string[],
  journalEntryId: string,
  options: SkattekontoLinkOptions = {},
): Promise<LinkSkattekontoRowsResult> {
  const ids = [...new Set(transactionIds)]
  if (ids.length === 0 || ids.length > 50) {
    throw new SkattekontoLinkError('Välj mellan 1 och 50 händelser.', 'INVALID_CANDIDATE')
  }

  const { data: rows, error: rowsError } = await supabase
    .from('skattekonto_transactions')
    .select('id, belopp_skatteverket, journal_entry_id, is_ignored, status')
    .eq('company_id', companyId)
    .in('id', ids)
  if (rowsError || !rows || rows.length !== ids.length) {
    throw new SkattekontoLinkError('Någon av skattekonto-transaktionerna hittades inte.', 'TRANSACTION_NOT_FOUND')
  }
  const typed = rows as RowForLink[]
  if (typed.some((r) => r.journal_entry_id)) {
    throw new SkattekontoLinkError('En av transaktionerna är redan kopplad till ett verifikat.', 'ALREADY_BOOKED')
  }
  if (typed.some((r) => r.is_ignored)) {
    throw new SkattekontoLinkError('En av transaktionerna är ignorerad. Återställ den innan du kopplar.', 'ROW_IGNORED')
  }
  if (typed.some((r) => r.status !== 'booked')) {
    throw new SkattekontoLinkError('En kommande händelse kan inte kopplas ännu.', 'INVALID_CANDIDATE')
  }

  const { data: entry, error: entryError } = await supabase
    .from('journal_entries')
    .select('id, status, lines:journal_entry_lines ( account_number, debit_amount, credit_amount )')
    .eq('id', journalEntryId)
    .eq('company_id', companyId)
    .maybeSingle<EntryForLink>()
  if (entryError || !entry) {
    throw new SkattekontoLinkError('Verifikatet hittades inte.', 'ENTRY_NOT_FOUND')
  }
  if (entry.status === 'reversed') {
    throw new SkattekontoLinkError('Verifikatet är makulerat och kan inte kopplas.', 'INVALID_CANDIDATE')
  }

  const account = options.account ?? (await resolveSkattekontoAccount(supabase, companyId))
  const groupSet = new Set(ids)
  const outside = (await fetchLinkedRows(supabase, companyId, journalEntryId)).filter(
    (r) => !groupSet.has(r.id),
  )
  const belopps = typed.map((r) => Number(r.belopp_skatteverket))
  const settles = evaluateSkattekontoLink(
    entry.lines,
    outside.map((r) => Number(r.belopp_skatteverket)),
    belopps,
    { allowRemainder: options.allowRemainder, account },
  )
  if (!settles.ok || !settles.via) {
    const refusal = skattekontoLinkRefusal(settles, {
      entryNet: skattekontoEntryNet(entry.lines, account).net,
      rowsTotal: roundOre(belopps.reduce((s, b) => s + b, 0)),
      rowCount: belopps.length,
      alreadyLinked: outside.length,
      ...linkedFacts(outside),
      account,
    })
    throw new SkattekontoLinkError(refusal.message, refusal.code, heldBy(refusal.code, outside))
  }
  if (settles.via === 'partial' && entry.status !== 'posted') {
    throw new SkattekontoLinkError(PARTIAL_NEEDS_POSTED, 'INVALID_CANDIDATE')
  }

  const { data: updated, error: updateError } = await supabase
    .from('skattekonto_transactions')
    .update({ journal_entry_id: journalEntryId, suggested_journal_entry_id: null, suggested_at: null })
    .eq('company_id', companyId)
    .in('id', ids)
    .is('journal_entry_id', null)
    .eq('is_ignored', false)
    .select('id')
  if (updateError) {
    throw new SkattekontoLinkError(`Kunde inte koppla: ${updateError.message}`, 'LINK_RACE')
  }
  const updatedIds = ((updated ?? []) as Array<{ id: string }>).map((r) => r.id)
  if (updatedIds.length !== ids.length) {
    // Roll the partial hit back: the group's sum no longer settles the entry.
    if (updatedIds.length > 0) {
      await supabase
        .from('skattekonto_transactions')
        .update({ journal_entry_id: null })
        .eq('company_id', companyId)
        .in('id', updatedIds)
        .eq('journal_entry_id', journalEntryId)
    }
    throw new SkattekontoLinkError('En av transaktionerna kopplades av någon annan samtidigt.', 'LINK_RACE')
  }

  return {
    journal_entry_id: journalEntryId,
    via: settles.via,
    skattekonto_transaction_ids: ids,
    remainder: settles.remainder,
  }
}
