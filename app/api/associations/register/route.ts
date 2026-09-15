import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import {
  memberRegisterCsv,
  memberRegisterExtract,
  requireMemberCapitalForm,
} from '@/lib/associations/member-register'
import { associationErrorResponse } from '@/lib/associations/route-helpers'

/**
 * GET /api/associations/register[?format=csv]
 *
 * The medlemsförteckning extract per EFL 5 kap. 2 §: every member, past and
 * present, with insatser held. JSON by default, CSV (semicolon, UTF-8 BOM
 * for Excel) on request.
 */
export const GET = withRouteContext('association.register_extract', async (request, ctx) => {
  const { supabase, companyId, log, requestId } = ctx
  try {
    await requireMemberCapitalForm(supabase, companyId)
    const rows = await memberRegisterExtract(supabase, companyId)
    if (new URL(request.url).searchParams.get('format') === 'csv') {
      return new NextResponse('﻿' + memberRegisterCsv(rows), {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="medlemsforteckning.csv"',
          'Cache-Control': 'private, no-store',
        },
      })
    }
    return NextResponse.json({ data: rows })
  } catch (err) {
    return associationErrorResponse(err, log, requestId)
  }
})
