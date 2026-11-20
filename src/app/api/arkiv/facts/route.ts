import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { isArkivBrainEnabled } from '@/lib/arkiv/flag'
import type { FactRow } from '@/lib/arkiv/facts/store'
import { predicateDef } from '@/lib/arkiv/facts/predicates'
import { getErrorMessage } from '@/lib/errors/get-error-message'

/**
 * GET /api/arkiv/facts?subject_kind=company
 * The live facts about the company (or an agreement or party), each with
 * its source and how many earlier readings it replaced. This is what "Vad
 * din agent vet" shows under Fakta.
 */
export interface FactListItem {
  fact_id: string
  predicate: string
  label: string
  value_text: string
  valid_from: string | null
  valid_to: string | null
  sys_from: string
  source_kind: string
  source: { document_id: string | null; file_name: string | null; page: number | null; quote: string | null }
  earlier_readings: number
}

const querySchema = z.object({
  subject_kind: z.enum(['company', 'agreement', 'party']).default('company'),
  subject_id: z.string().uuid().optional(),
})

export const GET = withRouteContext('arkiv.facts', async (request, ctx) => {
  if (!isArkivBrainEnabled(ctx.companyId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const parsed = validateQuery(request, querySchema)
  if (!parsed.success) return parsed.response
  const subjectId = parsed.data.subject_kind === 'company' ? ctx.companyId : parsed.data.subject_id
  if (!subjectId) return NextResponse.json({ error: 'subject_id krävs.' }, { status: 400 })

  const { data, error } = await ctx.supabase
    .from('company_facts')
    .select('id, company_id, subject_kind, subject_id, predicate, value, value_text, single_valued, valid_from, valid_to, sys_from, sys_to, rank, deprecation_reason, supersedes_id, status, source_kind, source_document_id, source_extraction_id, sources, confidence, rationale, approved_by_user_id, created_at')
    .eq('company_id', ctx.companyId)
    .eq('subject_kind', parsed.data.subject_kind)
    .eq('subject_id', subjectId)
    .order('predicate', { ascending: true })
    .order('sys_from', { ascending: false })
    .limit(1000)
  if (error) return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 })
  const rows = (data ?? []) as FactRow[]
  const docIds = [...new Set(rows.map((f) => f.source_document_id).filter((id): id is string => !!id))]
  const docs = docIds.length ? await ctx.supabase.from('document_attachments').select('id, file_name').in('id', docIds) : { data: [], error: null }
  if (docs.error) return NextResponse.json({ error: getErrorMessage(docs.error) }, { status: 500 })
  const fileName = new Map(((docs.data ?? []) as Array<{ id: string; file_name: string }>).map((d) => [d.id, d.file_name]))

  const earlier = new Map<string, number>()
  for (const f of rows) if (f.sys_to != null || f.rank === 'deprecated') earlier.set(f.predicate, (earlier.get(f.predicate) ?? 0) + 1)
  const items: FactListItem[] = rows
    .filter((f) => f.sys_to == null && f.rank !== 'deprecated' && f.status === 'confirmed')
    .map((f) => {
      const first = f.sources[0] ?? {}
      const documentId = f.source_document_id ?? first.document_id ?? null
      return { fact_id: f.id, predicate: f.predicate, label: predicateDef(f.predicate)?.label ?? f.predicate, value_text: f.value_text, valid_from: f.valid_from, valid_to: f.valid_to, sys_from: f.sys_from, source_kind: f.source_kind, source: { document_id: documentId, file_name: documentId ? (fileName.get(documentId) ?? null) : null, page: first.page ?? null, quote: first.quote ?? null }, earlier_readings: earlier.get(f.predicate) ?? 0 }
    })
  return NextResponse.json({ data: items })
})
