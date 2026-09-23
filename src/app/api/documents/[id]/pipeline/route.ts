import { NextResponse } from 'next/server'
import { z } from 'zod'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { createServiceClient } from '@/lib/supabase/server'
import { isArkivEnabled } from '@/lib/arkiv/flag'
import { documentTitle } from '@/lib/arkiv/documents/title'
import { runDocumentJobFor } from '@/lib/documents/jobs/queue'
import type { Payload } from '@/lib/documents/extract/fields'
import { getErrorMessage } from '@/lib/errors/get-error-message'

// Advancing a step classifies, which emits document.classified for the inbox extension's handler.
ensureInitialized()

/**
 * GET /api/documents/[id]/pipeline?advance=1
 * Where an uploaded document is on its way and where it landed, for the
 * upload surface that shows the sorting moment. With advance=1 the next due
 * step of this document runs before the answer, so a person watching sees
 * it land in seconds rather than on the cron's ticks.
 */
export const maxDuration = 60

export type PipelineStage = 'reading' | 'classifying' | 'landing' | 'landed' | 'failed'
export type StepState = 'none' | 'queued' | 'running' | 'done' | 'failed'
export type LandingKind = 'underlag' | 'agreement' | 'authority' | 'document' | 'review' | 'held'

export interface PipelineView {
  document_id: string
  file_name: string
  title: string
  doc_type: string | null
  admission_state: string
  stage: PipelineStage
  steps: Record<'read' | 'classify' | 'extract' | 'derive', StepState>
  landed: { kind: LandingKind; href: string; label: string | null; matched: boolean } | null
  error: string | null
}

const AUTHORITY = new Set(['registration.bolagsverket', 'filing.bolagsverket', 'decision.skatteverket'])
const VOUCHER = new Set(['receipt', 'supplier_invoice', 'credit_note'])
const UNDERLAG_HREF = '/e/general/invoice-inbox'

const querySchema = z.object({ advance: z.enum(['1', '0']).optional() })

export const GET = withRouteContext('document.pipeline', async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
  if (!isArkivEnabled(ctx.companyId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const { id } = await params
  const parsed = validateQuery(request, querySchema)
  if (!parsed.success) return parsed.response
  const { data: owned, error: ownedError } = await ctx.supabase.from('document_attachments').select('id').eq('id', id).eq('company_id', ctx.companyId).maybeSingle()
  if (ownedError) return NextResponse.json({ error: getErrorMessage(ownedError) }, { status: 500 })
  if (!owned) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const service = createServiceClient()
  try {
    if (parsed.data.advance === '1') await runDocumentJobFor(service, id, `pipeline:${ctx.user.id}`)
  } catch (err) {
    return NextResponse.json({ error: getErrorMessage(err) }, { status: 500 })
  }

  const [doc, jobs, extraction, agreement, item] = await Promise.all([
    ctx.supabase.from('document_attachments').select('id, file_name, doc_type, admission_state, journal_entry_id').eq('id', id).maybeSingle(),
    service.from('document_jobs').select('kind, status, attempts, max_attempts, last_error').eq('document_id', id),
    ctx.supabase.from('document_extractions').select('payload').eq('document_id', id).eq('is_current', true).maybeSingle(),
    ctx.supabase.from('agreements').select('id, title').eq('source_document_id', id).maybeSingle(),
    ctx.supabase
      .from('invoice_inbox_items')
      .select('id, matched_transaction_id, routed_to_arkiv_at')
      .eq('document_id', id)
      .is('created_supplier_invoice_id', null)
      .is('created_journal_entry_id', null)
      .limit(1)
      .maybeSingle(),
  ])
  for (const r of [doc, jobs, extraction, agreement, item]) if (r.error) return NextResponse.json({ error: getErrorMessage(r.error) }, { status: 500 })
  const d = doc.data as { id: string; file_name: string; doc_type: string | null; admission_state: string; journal_entry_id: string | null } | null
  if (!d) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const rows = (jobs.data ?? []) as Array<{
    kind: 'read' | 'classify' | 'extract' | 'derive'
    status: 'queued' | 'running' | 'done' | 'failed'
    attempts: number
    max_attempts: number
    last_error: string | null
  }>
  const steps: PipelineView['steps'] = { read: 'none', classify: 'none', extract: 'none', derive: 'none' }
  let error: string | null = null
  for (const j of rows) {
    steps[j.kind] = j.status === 'failed' && j.attempts < j.max_attempts ? 'queued' : j.status
    if (j.status === 'failed' && j.attempts >= j.max_attempts) error = j.last_error
  }
  const gaveUp = (step: StepState) => step === 'failed'
  const stage: PipelineStage =
    gaveUp(steps.read) || gaveUp(steps.classify)
      ? 'failed'
      : steps.read !== 'done'
        ? 'reading'
        : steps.classify !== 'done'
          ? 'classifying'
          : steps.extract === 'queued' || steps.extract === 'running' || steps.derive === 'queued' || steps.derive === 'running'
            ? 'landing'
            : 'landed'

  const payload = (extraction.data as { payload: Payload } | null)?.payload ?? null
  const agr = agreement.data as { id: string; title: string } | null
  const inbox = item.data as { id: string; matched_transaction_id: string | null; routed_to_arkiv_at: string | null } | null
  const title = documentTitle({ docType: d.doc_type, fileName: d.file_name, payload, agreementTitle: agr?.title ?? null })

  let landed: PipelineView['landed'] = null
  if (steps.classify === 'done' || d.admission_state === 'held') {
    if (d.admission_state === 'held') landed = { kind: 'held', href: '/arkiv/granska', label: null, matched: false }
    else if (!d.doc_type || d.doc_type === 'other') landed = { kind: 'review', href: '/arkiv/granska#typ', label: null, matched: false }
    else if (VOUCHER.has(d.doc_type)) landed = { kind: 'underlag', href: UNDERLAG_HREF, label: null, matched: !!inbox?.matched_transaction_id }
    else if (d.doc_type.startsWith('agreement.')) landed = { kind: 'agreement', href: agr ? `/arkiv/avtal/${agr.id}` : '/arkiv/avtal', label: agr?.title ?? null, matched: false }
    else if (AUTHORITY.has(d.doc_type)) landed = { kind: 'authority', href: `/arkiv/dokument/${d.id}`, label: null, matched: false }
    else landed = { kind: 'document', href: `/arkiv/dokument/${d.id}`, label: null, matched: false }
  }

  const view: PipelineView = { document_id: d.id, file_name: d.file_name, title, doc_type: d.doc_type, admission_state: d.admission_state, stage, steps, landed, error }
  return NextResponse.json({ data: view })
})
