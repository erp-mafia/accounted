import type { SupabaseClient } from '@supabase/supabase-js'
import { dbError } from '@/lib/errors/db-error'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { ID_READ_CHUNK } from '@/lib/supabase/read-in-slices'
import { chunk } from '@/lib/utils'
import { isWebshopBookingReleased } from './booking-status'

/**
 * The reads behind isWebshopBookingReleased (./booking-status.ts): which of
 * the verifikat orders name a plain storno has released them from. Each
 * throws when a read fails; a caller that guessed would show a booked order
 * as open work, or the reverse.
 */

/** A verifikat that released the orders naming it, with where they book again. */
export interface ReleasedWebshopBooking {
  id: string
  /**
   * The series and fiscal year of the reversed verifikat, which its storno
   * shares: booking the order again there numbers the new verifikat after
   * the storno, so the storno is never the last voucher Radera senaste
   * verifikat may delete while the new booking stands.
   */
  voucher_series: string
  fiscal_period_id: string
}

interface EntryRow {
  id: string
  status: string
  voucher_series: string | null
  fiscal_period_id: string
}

/** The reversed entries no rättelse replaced, by id. */
async function withoutRattelse(
  supabase: SupabaseClient,
  companyId: string,
  entries: EntryRow[],
): Promise<Map<string, ReleasedWebshopBooking>> {
  const reversed = entries.filter((entry) => entry.status === 'reversed')
  const corrected = new Set<string>()
  for (const ids of chunk(reversed.map((entry) => entry.id), ID_READ_CHUNK)) {
    const { data, error } = await supabase
      .from('journal_entries')
      .select('correction_of_id')
      .eq('company_id', companyId)
      .in('correction_of_id', ids)
      .neq('status', 'cancelled')
    if (error) throw dbError(error, 'webshop order booking: rättelse lookup')
    for (const row of (data ?? []) as Array<{ correction_of_id: string }>) corrected.add(row.correction_of_id)
  }
  const released = new Map<string, ReleasedWebshopBooking>()
  for (const entry of reversed) {
    if (!isWebshopBookingReleased(entry, corrected.has(entry.id))) continue
    released.set(entry.id, {
      id: entry.id,
      voucher_series: entry.voucher_series || 'A',
      fiscal_period_id: entry.fiscal_period_id,
    })
  }
  return released
}

/** The verifikat among `entryIds` that released the orders naming them, by id. */
export async function readReleasedWebshopBookings(
  supabase: SupabaseClient,
  companyId: string,
  entryIds: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, ReleasedWebshopBooking>> {
  const ids = Array.from(new Set(entryIds.filter((id): id is string => !!id)))
  const entries: EntryRow[] = []
  for (const part of chunk(ids, ID_READ_CHUNK)) {
    const { data, error } = await supabase
      .from('journal_entries')
      .select('id, status, voucher_series, fiscal_period_id')
      .eq('company_id', companyId)
      .in('id', part)
    if (error) throw dbError(error, 'webshop order booking: verifikat lookup')
    entries.push(...((data ?? []) as EntryRow[]))
  }
  return withoutRattelse(supabase, companyId, entries)
}

/**
 * Every verifikat of the company that released an order still naming it: the
 * orders waiting to be booked again. Read from the company's reversed webshop
 * verifikat, a short list, never from its orders.
 */
export async function readCompanyReleasedWebshopBookings(
  supabase: SupabaseClient,
  companyId: string,
): Promise<Map<string, ReleasedWebshopBooking>> {
  type Page = PromiseLike<{ data: EntryRow[] | null; error: { message: string } | null }>
  const reversed = await fetchAllRows<EntryRow>(({ from, to }) =>
    supabase
      .from('journal_entries')
      .select('id, status, voucher_series, fiscal_period_id')
      .eq('company_id', companyId)
      .eq('source_type', 'webshop_order')
      .eq('status', 'reversed')
      .order('id', { ascending: true })
      .range(from, to) as unknown as Page,
  )
  const released = await withoutRattelse(supabase, companyId, reversed)

  // An order booked again names its new verifikat: the one it left is no
  // longer anybody's, and stays out of the list filters.
  const named = new Set<string>()
  for (const ids of chunk(Array.from(released.keys()), ID_READ_CHUNK)) {
    const rows = await fetchAllRows<{ id: string; journal_entry_id: string }>(({ from, to }) =>
      supabase
        .from('webshop_orders')
        .select('id, journal_entry_id')
        .eq('company_id', companyId)
        .in('journal_entry_id', ids)
        .order('id', { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
          data: Array<{ id: string; journal_entry_id: string }> | null
          error: { message: string } | null
        }>,
    )
    for (const row of rows) named.add(row.journal_entry_id)
  }
  return new Map(Array.from(released).filter(([id]) => named.has(id)))
}
