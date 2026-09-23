import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { isArkivEnabled } from '@/lib/arkiv/flag'
import type { FindingKind, FindingSeverity, FindingSubjectKind } from '@/lib/arkiv/lint/checks'
import { getErrorMessage } from '@/lib/errors/get-error-message'

/**
 * GET /api/arkiv/findings
 * The open findings of the nightly lint, newest first, for the Granska page
 * and the Att göra row.
 */
export interface FindingView {
  finding_id: string
  kind: FindingKind
  key: string
  severity: FindingSeverity
  subject_kind: FindingSubjectKind
  subject_id: string | null
  detail: Record<string, unknown>
  first_seen_at: string
  last_seen_at: string
}

export const GET = withRouteContext('arkiv.findings', async (_request, ctx) => {
  if (!isArkivEnabled(ctx.companyId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const { data, error } = await ctx.supabase
    .from('arkiv_findings')
    .select('id, kind, key, severity, subject_kind, subject_id, detail, first_seen_at, last_seen_at')
    .eq('company_id', ctx.companyId)
    .eq('status', 'open')
    .order('severity', { ascending: false })
    .order('first_seen_at', { ascending: false })
    .limit(200)
  if (error) return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 })
  const rows = (data ?? []) as Array<{
    id: string
    kind: FindingKind
    key: string
    severity: FindingSeverity
    subject_kind: FindingSubjectKind
    subject_id: string | null
    detail: Record<string, unknown>
    first_seen_at: string
    last_seen_at: string
  }>
  const view: FindingView[] = rows.map((r) => ({
    finding_id: r.id,
    kind: r.kind,
    key: r.key,
    severity: r.severity,
    subject_kind: r.subject_kind,
    subject_id: r.subject_id,
    detail: r.detail,
    first_seen_at: r.first_seen_at,
    last_seen_at: r.last_seen_at,
  }))
  return NextResponse.json({ data: view })
})
