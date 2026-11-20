import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { countUnderlagForJournalEntries } from '@/lib/core/documents/underlag-counts'

const uuidSchema = z.string().uuid()

/**
 * GET /api/documents/counts?journal_entry_ids=id1,id2,...
 * Returns underlag counts per journal entry ID.
 * Max 50 IDs per request; every ID must be a UUID (the ids are interpolated
 * into a PostgREST .or() filter string, so validation doubles as injection
 * protection).
 *
 * `data` is the underlag document count per entry and `invoice_references`
 * the customer invoices referencing it (lib/core/documents/underlag-counts.ts
 * says what counts). The verifikat list now gets both with its rows
 * (GET /api/bookkeeping/journal-entries?include_counts=true) and calls this
 * only when that part of its response is missing.
 */
export const GET = withRouteContext('document.counts', async (request, ctx) => {
  const { supabase, companyId } = ctx

  const { searchParams } = new URL(request.url)
  const idsParam = searchParams.get('journal_entry_ids')

  if (!idsParam) {
    return NextResponse.json({ error: 'journal_entry_ids is required' }, { status: 400 })
  }

  const ids = idsParam.split(',').filter(Boolean)

  if (ids.length === 0) {
    return NextResponse.json({ data: {} })
  }

  if (ids.length > 50) {
    return NextResponse.json({ error: 'Maximum 50 IDs per request' }, { status: 400 })
  }

  if (ids.some((id) => !uuidSchema.safeParse(id).success)) {
    return NextResponse.json(
      { error: 'journal_entry_ids must be UUIDs' },
      { status: 400 },
    )
  }

  let counted: Awaited<ReturnType<typeof countUnderlagForJournalEntries>>
  try {
    counted = await countUnderlagForJournalEntries(supabase, companyId, ids)
  } catch (err) {
    return NextResponse.json({ error: getUserErrorMessage(err) }, { status: 500 })
  }

  return NextResponse.json({ data: counted.counts, invoice_references: counted.invoice_references })
})
