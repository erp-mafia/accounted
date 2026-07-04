import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { markEntriesNoDocRequired } from '@/lib/bookkeeping/no-doc-required'
import { NEEDS_DOC_SOURCE_TYPES } from '@/lib/worklist/categories'

const BatchNoDocSchema = z.object({
  journal_entry_ids: z.array(z.string().uuid()).min(1).max(500),
  reason: z.string().trim().max(200).nullable().optional(),
})

/**
 * Batch-mark posted verifikationer as "Inget underlag krävs". Lets the user
 * clear many entries (e.g. historical SIE imports) out of "Att hantera: saknade
 * underlag" in one action instead of toggling each one.
 *
 * The exemption is shared bookkeeping metadata (company-scoped, like mapping
 * rules): the audit_log trigger records the actor.
 */
export const POST = withRouteContext(
  'journal_entry.batch_no_document_required',
  async (request, { supabase, companyId, user }) => {
    const validation = await validateBody(request, BatchNoDocSchema)
    if (!validation.success) return validation.response

    const { journal_entry_ids, reason } = validation.data

    // Defense in depth: only exempt posted entries that belong to this company.
    // Validate ownership in chunks so the PostgREST `in()` URL stays bounded.
    const ownedIds: string[] = []
    for (let i = 0; i < journal_entry_ids.length; i += 200) {
      const chunk = journal_entry_ids.slice(i, i + 200)
      const { data, error } = await supabase
        .from('journal_entries')
        .select('id')
        .eq('company_id', companyId)
        .eq('status', 'posted')
        .in('source_type', [...NEEDS_DOC_SOURCE_TYPES])
        .in('id', chunk)

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 400 })
      }
      ownedIds.push(...(data ?? []).map((r) => r.id))
    }

    if (ownedIds.length === 0) {
      return NextResponse.json({ data: { exempted: 0 } })
    }

    const exempted = await markEntriesNoDocRequired(
      supabase,
      companyId,
      user.id,
      ownedIds,
      reason ?? null,
    )

    return NextResponse.json({ data: { exempted } })
  },
  { requireWrite: true },
)
