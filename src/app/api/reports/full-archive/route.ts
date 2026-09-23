import { NextResponse } from 'next/server'
import {
  generateFullArchive,
  estimateArchiveSize,
  type ArchiveScope,
} from '@/lib/reports/full-archive-export'
import { withRouteContext } from '@/lib/api/with-route-context'
import { PRIVATE_NO_STORE_HEADERS, privateNoStore } from '@/lib/api/private-no-store'
import { utcDateStamp } from '@/lib/utils'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createServiceClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'
export const maxDuration = 300

const SIZE_LIMIT_BYTES = 80 * 1024 * 1024

export const GET = withRouteContext('report.full_archive', async (request, ctx) => {
  const { supabase, companyId, user, log, requestId } = ctx
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
      { status: 400, headers: PRIVATE_NO_STORE_HEADERS }
    )
  }

  const { data: membership, error: membershipError } = await supabase
    .from('company_members')
    .select('role')
    .eq('company_id', companyId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (membershipError) {
    log.error('failed to authorize full archive export', membershipError, {
      userId: user.id,
      companyId,
    })
    return privateNoStore(errorResponseFromCode('INTERNAL_ERROR', log, { requestId }))
  }
  if (!membership || !['owner', 'admin'].includes(membership.role)) {
    log.warn('full archive access denied', {
      userId: user.id,
      companyId,
      role: membership?.role ?? null,
    })
    return privateNoStore(errorResponseFromCode('FORBIDDEN', log, {
      requestId,
      details: { required_roles: ['owner', 'admin'] },
    }))
  }

  // The complete statutory archive includes exact delivery evidence from all
  // company senders. Only this owner/admin server path receives a service-role
  // client; normal delivery history remains data-minimized by RLS. companyId
  // comes from withRouteContext's authenticated active-company resolution,
  // never from a request parameter, and is verified again below.
  const archiveClient = createServiceClient()
  const { data: verifiedMembership, error: verificationError } = await archiveClient
    .from('company_members')
    .select('role')
    .eq('company_id', companyId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (verificationError) {
    log.error('failed to verify full archive export with service role', verificationError, {
      userId: user.id,
      companyId,
    })
    return privateNoStore(errorResponseFromCode('INTERNAL_ERROR', log, { requestId }))
  }
  if (!verifiedMembership || !['owner', 'admin'].includes(verifiedMembership.role)) {
    log.warn('full archive service-role verification denied', {
      userId: user.id,
      companyId,
      role: verifiedMembership?.role ?? null,
    })
    return privateNoStore(errorResponseFromCode('FORBIDDEN', log, {
      requestId,
      details: { required_roles: ['owner', 'admin'] },
    }))
  }

  try {
    const estimate = await estimateArchiveSize(
      archiveClient,
      companyId,
      scope,
      scope === 'period' ? periodId! : undefined
    )

    if (estimateOnly) {
      return NextResponse.json(
        {
          data: {
            ...estimate,
            size_limit_bytes: SIZE_LIMIT_BYTES,
            within_limit: estimate.total_bytes <= SIZE_LIMIT_BYTES,
          },
        },
        { headers: PRIVATE_NO_STORE_HEADERS },
      )
    }

    if (includeDocuments && estimate.total_bytes > SIZE_LIMIT_BYTES) {
      return NextResponse.json(
        {
          error: 'archive_too_large',
          size_bytes: estimate.total_bytes,
          size_limit_bytes: SIZE_LIMIT_BYTES,
        },
        { status: 413, headers: PRIVATE_NO_STORE_HEADERS }
      )
    }

    const zipBuffer = await generateFullArchive(
      archiveClient,
      companyId,
      scope === 'period'
        ? { scope: 'period', period_id: periodId!, include_documents: includeDocuments }
        : { scope: 'all', include_documents: includeDocuments }
    )

    const filename =
      scope === 'period'
        ? `arkiv_${periodId}.zip`
        : `arkiv_full_${companyId}_${utcDateStamp(new Date())}.zip`

    log.info('full archive generated', {
      userId: user.id,
      companyId,
      scope,
      includeDocuments,
      filename,
      sizeBytes: zipBuffer.byteLength,
    })

    return new NextResponse(zipBuffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (err) {
    log.error('full archive generation failed', err as Error, {
      userId: user.id,
      companyId,
      scope,
      includeDocuments,
    })
    const message = err instanceof Error ? err.message : 'Failed to generate archive'
    const status = message.includes('not found') ? 404 : 500
    return NextResponse.json(
      { error: getErrorMessage(err) },
      { status, headers: PRIVATE_NO_STORE_HEADERS },
    )
  }
})
