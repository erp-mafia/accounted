import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import type { ReconciliationSignoff } from './schemas'

/**
 * The account_reconciliations table, read and written in one place. Pure
 * storage: no policy (that is signoff.ts) and no status computation (that is
 * service.ts), so service.ts can read the latest sign-offs without a module
 * cycle.
 */

interface SignoffRow {
  id: string
  account_key: string
  through_date: string
  external_balance: number | string | null
  ledger_balance: number | string | null
  unexplained_difference: number | string | null
  note: string | null
  signed_by: string
  signed_at: string
  reopened_at: string | null
  reopened_by: string | null
  reopen_reason: string | null
}

function num(v: number | string | null): number | null {
  if (v == null) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? roundOre(n) : null
}

export function mapSignoffRow(row: SignoffRow): ReconciliationSignoff {
  return {
    id: row.id,
    account_key: row.account_key,
    through_date: row.through_date,
    external_balance: num(row.external_balance),
    ledger_balance: num(row.ledger_balance),
    unexplained_difference: num(row.unexplained_difference),
    note: row.note,
    signed_by: row.signed_by,
    signed_at: row.signed_at,
    reopened_at: row.reopened_at,
    reopened_by: row.reopened_by,
    reopen_reason: row.reopen_reason,
  }
}

/** Latest active sign-off per account key, one query for the whole company. */
export async function getLatestSignoffs(
  supabase: SupabaseClient,
  companyId: string,
): Promise<Map<string, ReconciliationSignoff>> {
  const { data, error } = await supabase
    .from('account_reconciliations')
    .select(
      'id, account_key, through_date, external_balance, ledger_balance, unexplained_difference, note, signed_by, signed_at, reopened_at, reopened_by, reopen_reason',
    )
    .eq('company_id', companyId)
    .is('reopened_at', null)
    .order('through_date', { ascending: false })
  if (error) throw new Error(`Kunde inte hämta avstämningssigneringar: ${error.message}`)
  const out = new Map<string, ReconciliationSignoff>()
  for (const row of (data ?? []) as SignoffRow[]) {
    if (!out.has(row.account_key)) out.set(row.account_key, mapSignoffRow(row))
  }
  return out
}

/** Latest active sign-off on one account, or null. */
export async function getLatestSignoff(
  supabase: SupabaseClient,
  companyId: string,
  accountKey: string,
): Promise<ReconciliationSignoff | null> {
  const { data, error } = await supabase
    .from('account_reconciliations')
    .select(
      'id, account_key, through_date, external_balance, ledger_balance, unexplained_difference, note, signed_by, signed_at, reopened_at, reopened_by, reopen_reason',
    )
    .eq('company_id', companyId)
    .eq('account_key', accountKey)
    .is('reopened_at', null)
    .order('through_date', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`Kunde inte hämta avstämningssignering: ${error.message}`)
  return data ? mapSignoffRow(data as SignoffRow) : null
}

/** One sign-off by id (any state), scoped to company + account. */
export async function getSignoffById(
  supabase: SupabaseClient,
  companyId: string,
  accountKey: string,
  signoffId: string,
): Promise<ReconciliationSignoff | null> {
  const { data, error } = await supabase
    .from('account_reconciliations')
    .select(
      'id, account_key, through_date, external_balance, ledger_balance, unexplained_difference, note, signed_by, signed_at, reopened_at, reopened_by, reopen_reason',
    )
    .eq('company_id', companyId)
    .eq('account_key', accountKey)
    .eq('id', signoffId)
    .maybeSingle()
  if (error) throw new Error(`Kunde inte hämta avstämningssignering: ${error.message}`)
  return data ? mapSignoffRow(data as SignoffRow) : null
}

/** Sign-off history for one account, newest first; reopened ones included when asked. */
export async function listSignoffs(
  supabase: SupabaseClient,
  companyId: string,
  accountKey: string,
  options: { limit?: number; includeReopened?: boolean } = {},
): Promise<ReconciliationSignoff[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  let query = supabase
    .from('account_reconciliations')
    .select(
      'id, account_key, through_date, external_balance, ledger_balance, unexplained_difference, note, signed_by, signed_at, reopened_at, reopened_by, reopen_reason',
    )
    .eq('company_id', companyId)
    .eq('account_key', accountKey)
    .order('through_date', { ascending: false })
    .order('signed_at', { ascending: false })
    .limit(limit)
  if (!options.includeReopened) query = query.is('reopened_at', null)
  const { data, error } = await query
  if (error) throw new Error(`Kunde inte hämta avstämningssigneringar: ${error.message}`)
  return ((data ?? []) as SignoffRow[]).map(mapSignoffRow)
}

export interface InsertSignoffInput {
  account_key: string
  through_date: string
  external_balance: number | null
  ledger_balance: number | null
  unexplained_difference: number | null
  note: string | null
  signed_by: string
}

export async function insertSignoff(
  supabase: SupabaseClient,
  companyId: string,
  input: InsertSignoffInput,
): Promise<ReconciliationSignoff> {
  const { data, error } = await supabase
    .from('account_reconciliations')
    .insert({
      company_id: companyId,
      account_key: input.account_key,
      through_date: input.through_date,
      external_balance: input.external_balance,
      ledger_balance: input.ledger_balance,
      unexplained_difference: input.unexplained_difference,
      note: input.note,
      signed_by: input.signed_by,
    })
    .select(
      'id, account_key, through_date, external_balance, ledger_balance, unexplained_difference, note, signed_by, signed_at, reopened_at, reopened_by, reopen_reason',
    )
    .single()
  if (error || !data) {
    throw new Error(`Kunde inte spara signeringen: ${error?.message ?? 'okänt fel'}`)
  }
  return mapSignoffRow(data as SignoffRow)
}

/** Stamp a sign-off as reopened; the guarded `.is('reopened_at', null)` makes it race-safe. */
export async function stampReopen(
  supabase: SupabaseClient,
  companyId: string,
  signoffId: string,
  input: { reopened_by: string; reason: string | null },
): Promise<ReconciliationSignoff | null> {
  const { data, error } = await supabase
    .from('account_reconciliations')
    .update({ reopened_at: new Date().toISOString(), reopened_by: input.reopened_by, reopen_reason: input.reason })
    .eq('company_id', companyId)
    .eq('id', signoffId)
    .is('reopened_at', null)
    .select(
      'id, account_key, through_date, external_balance, ledger_balance, unexplained_difference, note, signed_by, signed_at, reopened_at, reopened_by, reopen_reason',
    )
    .maybeSingle()
  if (error) throw new Error(`Kunde inte öppna signeringen igen: ${error.message}`)
  return data ? mapSignoffRow(data as SignoffRow) : null
}
