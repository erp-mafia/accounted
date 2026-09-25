import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { isArkivBrainEnabled } from '@/lib/arkiv/flag'
import type { Payload } from '@/lib/documents/extract/fields'
import type { CheckFailure } from '@/lib/documents/extract/merge'
import { schemaForType, type FieldDef } from '@/lib/documents/extract/schemas'
import { getErrorMessage } from '@/lib/errors/get-error-message'

/**
 * GET /api/documents/[id]/extraction
 * The current record of one document: every field with its value, page,
 * quote and region, the failed checks, the fields waiting for a person, and
 * the schema's field definitions so a client can render them. 404 outside
 * the rollout, for another company's document, and before the first
 * extraction.
 */
export interface ExtractionView {
  extraction_id: string
  document_id: string
  schema_type: string
  schema_version: number
  pass: 'consensus' | 'human'
  payload: Payload
  validation: CheckFailure[]
  review_fields: string[]
  fields: FieldDef[]
  created_at: string
}

type ExtractionRow = Omit<ExtractionView, 'extraction_id' | 'fields'> & { id: string }

export const GET = withRouteContext('document.extraction', async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
  if (!isArkivBrainEnabled(ctx.companyId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const { id } = await params
  const { data, error } = await ctx.supabase
    .from('document_extractions')
    .select('id, document_id, schema_type, schema_version, pass, payload, validation, review_fields, created_at')
    .eq('document_id', id)
    .eq('company_id', ctx.companyId)
    .eq('is_current', true)
    .maybeSingle()
  if (error) return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const { id: extractionId, ...row } = data as ExtractionRow
  const view: ExtractionView = { extraction_id: extractionId, ...row, fields: schemaForType(row.schema_type).fields }
  return NextResponse.json({ data: view })
})
