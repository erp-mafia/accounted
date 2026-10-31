import { NextResponse } from 'next/server'
import {
  streamFullArchive,
  estimateArchiveSize,
  type ArchiveScope,
} from '@/lib/reports/full-archive-export'
import { withRouteContext } from '@/lib/api/with-route-context'
import { PRIVATE_NO_STORE_HEADERS, privateNoStore } from '@/lib/api/private-no-store'
import { utcDateStamp } from '@/lib/utils'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createServiceClient } from '@/lib/supabase/server'
import { fileResponse, streamedBody } from '@/lib/api/file-response'

export const runtime = 'nodejs'
// The ZIP streams as it is written, so its size is bounded by time, not
// memory: the Pro-plan ceiling with Fluid compute, since years of underlag
// (gigabytes) take minutes to send.
export const maxDuration = 800

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

  if (estimateOnly) {
    try {
      const estimate = await estimateArchiveSize(
        archiveClient,
        companyId,
        scope,
        scope === 'period' ? periodId! : undefined
      )
      return NextResponse.json({ data: estimate }, { headers: PRIVATE_NO_STORE_HEADERS })
    } catch (err) {
      log.error('full archive estimate failed', err as Error, { userId: user.id, companyId, scope })
      return privateNoStore(errorResponseFromCode('INTERNAL_ERROR', log, { requestId }))
    }
  }

  const filename =
    scope === 'period'
      ? `arkiv_${periodId}.zip`
      : `arkiv_full_${companyId}_${utcDateStamp(new Date())}.zip`
  const logContext = { userId: user.id, companyId, scope, includeDocuments, filename }

  // The headers go out at once and the ZIP follows as it is written, so the
  // browser shows the download from the click and memory holds a few files,
  // never the archive. Once the response has started, a failure can only cut
  // it off: it is logged here and the browser reports the download as failed.
  const archive = streamFullArchive(
    archiveClient,
    companyId,
    scope === 'period'
      ? { scope: 'period', period_id: periodId!, include_documents: includeDocuments }
      : { scope: 'all', include_documents: includeDocuments }
  )
  return fileResponse(
    streamedBody(archive, {
      onEnd: (sizeBytes) => log.info('full archive generated', { ...logContext, sizeBytes }),
      onError: (err, bytesSent) =>
        log.error('full archive generation failed', err as Error, { ...logContext, bytesSent }),
      onCancel: (bytesSent) => log.info('full archive download cancelled', { ...logContext, bytesSent }),
    }),
    { filename, contentType: 'application/zip', cacheControl: 'private, no-store' },
  )
})
