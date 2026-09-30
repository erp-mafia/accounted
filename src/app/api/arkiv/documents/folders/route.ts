import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { isArkivEnabled } from '@/lib/arkiv/flag'
import { foldersFromCounts, type FolderCount } from '@/lib/arkiv/folders'
import { getErrorMessage } from '@/lib/errors/get-error-message'

/**
 * GET /api/arkiv/documents/folders?year=
 * The Dokument tree's folders with their counts and type mix over the whole
 * archive (arkiv_document_type_counts). The tree loaded the newest 500
 * documents and counted those, so a larger archive showed wrong counts and
 * left older documents out (prod 2026-09-25: 35 369 documents in 21
 * companies). Each folder then loads its own rows, page by page.
 */
export interface ArkivFoldersResponse {
  total: number
  folders: FolderCount[]
}

const querySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
})

export const GET = withRouteContext('arkiv.documents.folders', async (request, ctx) => {
  if (!isArkivEnabled(ctx.companyId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const parsed = validateQuery(request, querySchema)
  if (!parsed.success) return parsed.response
  const { data, error } = await ctx.supabase.rpc('arkiv_document_type_counts', { p_company_id: ctx.companyId, p_year: parsed.data.year ?? null })
  if (error) return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 })
  const counts = ((data ?? []) as Array<{ doc_type: string | null; booked?: boolean | null; n: number | string }>).map((r) => ({ doc_type: r.doc_type, booked: !!r.booked, n: Number(r.n) }))
  const folders = foldersFromCounts(counts)
  const body: ArkivFoldersResponse = { total: folders.reduce((a, f) => a + f.count, 0), folders }
  return NextResponse.json({ data: body })
})
