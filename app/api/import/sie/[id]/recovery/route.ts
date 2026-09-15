import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { assessLegacySIEImport } from '@/lib/import/sie-legacy-recovery'

/** GET /api/import/sie/[id]/recovery: read-only legacy import assessment. */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'sie_import.recovery',
  async (_request, { supabase, companyId, log, requestId }, { params }) => {
    const id = z.uuid().parse((await params).id)
    const data = await assessLegacySIEImport(supabase, companyId, id)
    if (!data) return errorResponseFromCode('NOT_FOUND', log, { requestId })
    return NextResponse.json({ data }, { headers: { 'Cache-Control': 'private, no-store' } })
  },
)
