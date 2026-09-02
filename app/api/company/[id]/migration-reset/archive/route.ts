import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { privateNoStore } from '@/lib/api/private-no-store'
import { utcDateStamp } from '@/lib/utils'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import {
  estimateArchiveSize,
  generateBaseDataArchive,
} from '@/lib/reports/full-archive-export'
import { createServiceClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'
export const maxDuration = 300

const SIZE_LIMIT_BYTES = 80 * 1024 * 1024

type Params = { params: Promise<{ id: string }> }

interface ResetArchiveRow {
  source_company_id: string
  created_at: string
}

/**
 * GET /api/company/[id]/migration-reset/archive
 *
 * Gives the replacement-company owner a read-only ZIP of the retained source.
 * The archived source never becomes active and no source row is modified.
 */
export const GET = withRouteContext<Params>(
  'company.migration-reset.archive',
  async (request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    if (id !== companyId) {
      return privateNoStore(errorResponseFromCode('COMPANY_RESET_NOT_FOUND', log, { requestId }))
    }

    const { data: membership, error: membershipError } = await supabase
      .from('company_members')
      .select('role')
      .eq('company_id', companyId)
      .eq('user_id', user.id)
      .maybeSingle()
    if (membershipError) {
      log.error('failed to authorize migration reset archive', membershipError)
      return privateNoStore(errorResponseFromCode('INTERNAL_ERROR', log, { requestId }))
    }
    if (membership?.role !== 'owner') {
      return privateNoStore(errorResponseFromCode('COMPANY_RESET_FORBIDDEN', log, { requestId }))
    }

    const { data: visibleReset, error: visibleResetError } = await supabase
      .from('company_migration_resets')
      .select('source_company_id, created_at')
      .eq('replacement_company_id', companyId)
      .maybeSingle()
    if (visibleResetError) {
      log.error('failed to find migration reset archive', visibleResetError)
      return privateNoStore(errorResponseFromCode('INTERNAL_ERROR', log, { requestId }))
    }
    if (!visibleReset) {
      return privateNoStore(errorResponseFromCode('COMPANY_RESET_NOT_FOUND', log, { requestId }))
    }

    // Service credentials are required for a complete statutory export, but
    // authorization is repeated before they are used. The immutable reset row
    // must still link this active replacement to an archived source. Access is
    // based on current ownership of the replacement, not mutable membership of
    // the retained source, so normal team removal or account anonymization
    // cannot accidentally strand the statutory archive.
    const archiveClient = createServiceClient()
    const { data: verifiedReset, error: verifiedResetError } = await archiveClient
      .from('company_migration_resets')
      .select('source_company_id, created_at')
      .eq('replacement_company_id', companyId)
      .maybeSingle()
    if (verifiedResetError) {
      log.error('failed to verify migration reset archive link', verifiedResetError)
      return privateNoStore(errorResponseFromCode('INTERNAL_ERROR', log, { requestId }))
    }

    const reset = verifiedReset as ResetArchiveRow | null
    if (!reset || reset.source_company_id !== visibleReset.source_company_id) {
      log.warn('migration reset archive link verification denied', {
        userId: user.id,
        companyId,
      })
      return privateNoStore(errorResponseFromCode('COMPANY_RESET_FORBIDDEN', log, { requestId }))
    }

    const [{ data: replacementMembership, error: replacementMembershipError }, {
      data: sourceCompany,
      error: sourceCompanyError,
    }] = await Promise.all([
      archiveClient
        .from('company_members')
        .select('role')
        .eq('company_id', companyId)
        .eq('user_id', user.id)
        .maybeSingle(),
      archiveClient
        .from('companies')
        .select('archived_at')
        .eq('id', reset.source_company_id)
        .maybeSingle(),
    ])
    if (replacementMembershipError || sourceCompanyError) {
      log.error(
        'failed to verify retained migration source',
        replacementMembershipError ?? sourceCompanyError,
      )
      return privateNoStore(errorResponseFromCode('INTERNAL_ERROR', log, { requestId }))
    }
    if (replacementMembership?.role !== 'owner' || !sourceCompany?.archived_at) {
      log.warn('retained migration source access denied', {
        userId: user.id,
        companyId,
        sourceCompanyId: reset.source_company_id,
      })
      return privateNoStore(errorResponseFromCode('COMPANY_RESET_FORBIDDEN', log, { requestId }))
    }

    const { searchParams } = new URL(request.url)
    const estimateOnly = searchParams.get('estimate') === '1'
    const includeDocuments = searchParams.get('include_documents') !== 'false'

    try {
      const estimate = await estimateArchiveSize(archiveClient, reset.source_company_id, 'all')
      const plannedSizeBytes = includeDocuments
        ? estimate.total_bytes
        : Math.max(0, estimate.total_bytes - estimate.document_bytes)
      if (estimateOnly) {
        return privateNoStore(NextResponse.json(
          {
            data: {
              ...estimate,
              archived_at: reset.created_at,
              size_limit_bytes: SIZE_LIMIT_BYTES,
              within_limit: plannedSizeBytes <= SIZE_LIMIT_BYTES,
            },
          },
        ))
      }

      if (plannedSizeBytes > SIZE_LIMIT_BYTES) {
        return privateNoStore(NextResponse.json(
          {
            error: 'archive_too_large',
            size_bytes: plannedSizeBytes,
            size_limit_bytes: SIZE_LIMIT_BYTES,
          },
          { status: 413 },
        ))
      }

      const zipBuffer = await generateBaseDataArchive(archiveClient, reset.source_company_id, {
        include_documents: includeDocuments,
      })
      const filename = `migration_reset_archive_${utcDateStamp(new Date())}.zip`

      log.info('migration reset source archive generated', {
        userId: user.id,
        companyId,
        sourceCompanyId: reset.source_company_id,
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
    } catch (error) {
      log.error('migration reset source archive generation failed', error as Error, {
        userId: user.id,
        companyId,
        sourceCompanyId: reset.source_company_id,
      })
      return privateNoStore(
        errorResponseFromCode('COMPANY_RESET_FAILED', log, { requestId }),
      )
    }
  },
)
