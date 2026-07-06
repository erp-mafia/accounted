import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getJournalEntryUnderlagReferences } from '@/lib/core/bookkeeping/journal-entry-references'

/**
 * GET /api/bookkeeping/journal-entries/[id]/references
 *
 * Resolves the verifikation's followable underlag references, the linked
 * customer / supplier invoices that identify the affärshändelse. Lets the
 * verifikat view make the verifieringskedja traceable from the verifikat side,
 * not only from the invoice side (BFL 5 kap 7§, hänvisning till underlag;
 * BFNAR 2013:2). Read-only.
 *
 * An id that doesn't belong to the active company resolves to no references
 * (every underlying query is company-scoped), so this neither leaks nor 404s.
 *
 * Marked private, no-store: the payload carries invoice numbers (financial
 * data), so no shared proxy / CDN may cache it across users or companies.
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'journal_entry.references',
  async (_request, { supabase, companyId }, { params }) => {
    const { id } = await params
    const references = await getJournalEntryUnderlagReferences(supabase, companyId, id)
    return NextResponse.json(
      { data: { references } },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  },
)
