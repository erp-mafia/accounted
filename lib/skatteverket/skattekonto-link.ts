import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import { SKATTEKONTO_ACCOUNT } from './manual-verifikat-prefill'

/**
 * Link semantics for a skattekonto row (core).
 *
 * A link pairs ONE SKV-posted row with ONE verifikat whose 1630 movement
 * equals the row's amount on the expected side (positive belopp = money
 * into the skattekonto = debit 1630). It writes nothing to the verifikat:
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
  | 'NOT_LINKED'
  | 'LINK_RACE'

export class SkattekontoLinkError extends Error {
  constructor(
    message: string,
    public readonly code: SkattekontoLinkErrorCode,
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
): { ok: boolean; via: 'line' | 'entry_total' | null } {
  const amount = roundOre(Math.abs(belopp))
  const side = expectedSide(belopp)
  const onAccount = (lines ?? []).filter((l) => l.account_number === SKATTEKONTO_ACCOUNT)
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

export interface LinkSkattekontoRowResult {
  skattekonto_transaction_id: string
  journal_entry_id: string
  via: 'line' | 'entry_total'
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
  const settles = entrySettlesAmount(entry.lines, Number(row.belopp_skatteverket))
  if (!settles.ok || !settles.via) {
    throw new SkattekontoLinkError('Verifikatet saknar en matchande rad på 1630.', 'INVALID_CANDIDATE')
  }

  const { data: alreadyLinked } = await supabase
    .from('skattekonto_transactions')
    .select('id')
    .eq('company_id', companyId)
    .eq('journal_entry_id', journalEntryId)
    .maybeSingle()
  if (alreadyLinked) {
    throw new SkattekontoLinkError(
      'Verifikatet är redan kopplat till en annan skattekonto-transaktion.',
      'ENTRY_ALREADY_LINKED',
    )
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

  return { skattekonto_transaction_id: transactionId, journal_entry_id: journalEntryId, via: settles.via }
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
  const { error: updateError } = await supabase
    .from('skattekonto_transactions')
    .update(ignored ? { is_ignored: true, suggested_journal_entry_id: null, suggested_at: null } : { is_ignored: false })
    .eq('id', transactionId)
    .eq('company_id', companyId)
  if (updateError) {
    throw new SkattekontoLinkError(`Kunde inte uppdatera: ${updateError.message}`, 'LINK_RACE')
  }
  return { skattekonto_transaction_id: transactionId, is_ignored: ignored }
}
