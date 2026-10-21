/**
 * GET /api/transactions/migration-coverage
 *
 * Which open rows in Att bokföra carry the "från perioden före din
 * migrering" marker (crm#1239): the rows dated on or before the end of the
 * company's imported bookkeeping that the ledger already explains, i.e. one
 * to four posted vouchers with no bank link whose bank legs add up to the
 * row to the öre within ±7 days.
 *
 * The marker tells the user to match the row instead of booking it, so it
 * may only appear where there is something to match. Date alone said so for
 * every row the old system's period covered, including the rows the matcher
 * had already searched in vain, and a byrå read that as "already booked".
 * The answer here comes from the same detector the booking doors refuse a
 * double booking with and the reconciliation view proposes sets from: one
 * definition of "explained by the ledger" in all three places.
 *
 * Read-only and advisory: the detector fails open (no ids) and the page then
 * shows no marker, which is what a row without evidence shows anyway. The
 * booking doors keep their own guard.
 */
import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { detectExplainingVoucherSets } from '@/lib/invoices/duplicate-payment-detection'
import { fetchMigrationCoverageEnd, fetchOpenPreMigrationRows } from '@/lib/transactions/migration-coverage'

export const GET = withRouteContext('transaction.migration_coverage', async (_request, { supabase, companyId }) => {
  const coverageEnd = await fetchMigrationCoverageEnd(supabase, companyId)
  if (!coverageEnd) {
    return NextResponse.json({ data: { coverage_end: null, explained_ids: [] } })
  }

  const groups = await fetchOpenPreMigrationRows(supabase, companyId, coverageEnd)
  const explainedIds: string[] = []
  for (const group of groups) {
    const sets = await detectExplainingVoucherSets(supabase, {
      companyId,
      bankAccountNumber: group.scanAccount,
      transactions: group.rows,
    })
    explainedIds.push(...sets.keys())
  }

  return NextResponse.json({ data: { coverage_end: coverageEnd, explained_ids: explainedIds } })
})
