import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'

export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bookkeeping.journal_entry.chain',
  async (_request, { supabase, companyId }, { params }) => {
  const { id } = await params

  // Fetch the requested entry with lines
  const { data: entry, error } = await supabase
    .from('journal_entries')
    .select('*, lines:journal_entry_lines(*)')
    .eq('id', id)
    .eq('company_id', companyId)
    .single()

  if (error || !entry) {
    return NextResponse.json({ error: 'Entry not found' }, { status: 404 })
  }

  // Collect all related entry IDs by following FK links iteratively
  const visited = new Set<string>([id])
  const toVisit = new Set<string>()

  // Seed with direct FK references from this entry
  for (const fk of [entry.reverses_id, entry.reversed_by_id, entry.correction_of_id]) {
    if (fk && !visited.has(fk)) toVisit.add(fk)
  }

  // Also find entries that reference this entry (reverse lookup)
  const { data: referencing } = await supabase
    .from('journal_entries')
    .select('id')
    .eq('company_id', companyId)
    .or(`reverses_id.eq.${id},reversed_by_id.eq.${id},correction_of_id.eq.${id}`)

  if (referencing) {
    for (const r of referencing) {
      if (!visited.has(r.id)) toVisit.add(r.id)
    }
  }

  // Iteratively expand (bounded) to handle multi-level correction chains
  const MAX_ITERATIONS = 10
  for (let i = 0; i < MAX_ITERATIONS && toVisit.size > 0; i++) {
    const batch = Array.from(toVisit)
    toVisit.clear()
    for (const bid of batch) visited.add(bid)

    const { data: batchEntries } = await supabase
      .from('journal_entries')
      .select('id, reverses_id, reversed_by_id, correction_of_id')
      .eq('company_id', companyId)
      .in('id', batch)

    if (!batchEntries) continue

    // Collect FK references from forward links
    for (const e of batchEntries) {
      for (const fk of [e.reverses_id, e.reversed_by_id, e.correction_of_id]) {
        if (fk && !visited.has(fk)) toVisit.add(fk)
      }
    }

    // Single reverse-lookup for the whole batch instead of one per entry
    const batchOr = batch
      .flatMap(bid => [
        `reverses_id.eq.${bid}`,
        `reversed_by_id.eq.${bid}`,
        `correction_of_id.eq.${bid}`,
      ])
      .join(',')

    const { data: refs } = await supabase
      .from('journal_entries')
      .select('id')
      .eq('company_id', companyId)
      .or(batchOr)

    if (refs) {
      for (const r of refs) {
        if (!visited.has(r.id)) toVisit.add(r.id)
      }
    }
  }

  // Fetch all chain entries (excluding the main entry itself) with lines
  const chainIds = Array.from(visited).filter((cid) => cid !== id)
  let chain: typeof entry[] = []

  if (chainIds.length > 0) {
    const { data: chainEntries } = await supabase
      .from('journal_entries')
      .select('*, lines:journal_entry_lines(*)')
      .eq('company_id', companyId)
      .in('id', chainIds)
      .order('created_at', { ascending: true })

    chain = chainEntries || []
  }

  // Check if entry is the last in its voucher series (enables delete button in UI)
  let isLastInSeries = false
  if (entry.status === 'posted') {
    const { data: maxResult } = await supabase
      .from('journal_entries')
      .select('voucher_number')
      .eq('company_id', companyId)
      .eq('fiscal_period_id', entry.fiscal_period_id)
      .eq('voucher_series', entry.voucher_series)
      .in('status', ['posted', 'reversed'])
      .order('voucher_number', { ascending: false })
      .limit(1)
      .single()

    isLastInSeries = maxResult?.voucher_number === entry.voucher_number
  }

  return NextResponse.json({ data: { entry, chain, is_last_in_series: isLastInSeries } })
  },
)
