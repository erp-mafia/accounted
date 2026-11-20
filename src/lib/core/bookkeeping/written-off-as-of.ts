/**
 * Which invoices stood written off (konstaterad kundförlust) at the end of a
 * date, for the readers that rebuild the kundreskontra as it stood on a past
 * day: the AR ledger's as-of view and the kontantmetod year-end cut-off.
 *
 * A written-off invoice carries the status 'written_off' from the day of the
 * decision, but on an earlier day it was an open claim like any other (on
 * 1510, or under kontantmetoden owed by the customer). So those readers fetch
 * 'written_off' too and leave out only the invoices this answers: a live
 * konstaterad decision dated on or before the day, unless its annulment (the
 * storno of its voucher) is also dated on or before the day.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

export async function invoicesWrittenOffAsOf(
  supabase: SupabaseClient,
  companyId: string,
  asOfDate: string,
): Promise<Set<string>> {
  const rows = await fetchAllRows<{ id: string; invoice_id: string; kind: string; reverses_id: string | null }>(
    ({ from, to }) =>
      supabase
        .from('invoice_write_offs')
        .select('id, invoice_id, kind, reverses_id')
        .eq('company_id', companyId)
        .in('kind', ['confirmed', 'annulled'])
        .lte('entry_date', asOfDate)
        .order('id', { ascending: true })
        .range(from, to),
  )
  const annulled = new Set(rows.filter((r) => r.kind === 'annulled').map((r) => r.reverses_id))
  return new Set(rows.filter((r) => r.kind === 'confirmed' && !annulled.has(r.id)).map((r) => r.invoice_id))
}
