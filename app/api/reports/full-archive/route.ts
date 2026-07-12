import { NextResponse } from 'next/server'
import {
  generateFullArchive,
  estimateArchiveSize,
  type ArchiveScope,
} from '@/lib/reports/full-archive-export'
import { withRouteContext } from '@/lib/api/with-route-context'

export const runtime = 'nodejs'
export const maxDuration = 300

const SIZE_LIMIT_BYTES = 80 * 1024 * 1024

export const GET = withRouteContext('report.full_archive', async (request, { supabase, companyId }) => {
  const { searchParams } = new URL(request.url)
  const scopeParam = searchParams.get('scope')
  const periodId = searchParams.get('period_id')
  const estimateOnly = searchParams.get('estimate') === '1'
  const includeDocuments = searchParams.get('include_documents') !== 'false'

  // Backward compat: a bare `period_id` without `scope` is treated as scope=period.
  const scope: ArchiveScope =
    scopeParam === 'period' || (!scopeParam && periodId) ? 'period' : 'all'

  if (scope === 'period' && !periodId) {
    return NextResponse.json(
      { error: 'period_id is required when scope=period' },
      { status: 400 }
    )
  }

  try {
    const estimate = await estimateArchiveSize(
      supabase,
      companyId,
      scope,
      scope === 'period' ? periodId! : undefined
    )

    if (estimateOnly) {
      return NextResponse.json({
        data: {
          ...estimate,
          size_limit_bytes: SIZE_LIMIT_BYTES,
          within_limit: estimate.total_bytes <= SIZE_LIMIT_BYTES,
        },
      })
    }

    if (includeDocuments && estimate.total_bytes > SIZE_LIMIT_BYTES) {
      return NextResponse.json(
        {
          error: 'archive_too_large',
          size_bytes: estimate.total_bytes,
          size_limit_bytes: SIZE_LIMIT_BYTES,
        },
        { status: 413 }
      )
    }

    const zipBuffer = await generateFullArchive(
      supabase,
      companyId,
      scope === 'period'
        ? { scope: 'period', period_id: periodId!, include_documents: includeDocuments }
        : { scope: 'all', include_documents: includeDocuments }
    )

    const filename =
      scope === 'period'
        ? `arkiv_${periodId}.zip`
        : `arkiv_full_${companyId}_${formatDateStamp(new Date())}.zip`

    return new NextResponse(zipBuffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to generate archive'
    const status = message.includes('not found') ? 404 : 500
    return NextResponse.json({ error: message }, { status })
  }
})

function formatDateStamp(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}${m}${day}`
}
