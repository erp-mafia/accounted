import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { apartmentRegisterCsv, apartmentRegisterExtract } from '@/lib/brf/apartment-register'
import { brfRegisterErrorResponse } from '@/lib/brf/route-helpers'
import { requireBrfForm } from '@/lib/company/brf-tax-profile'

/**
 * GET /api/brf/lagenhetsforteckning[?format=csv]
 *
 * The lägenhetsförteckning extract (BRL 9 kap. 10-11 §§): every apartment
 * with its current bostadsrättshavare and unreleased pantsättningar. JSON by
 * default, CSV (semicolon, UTF-8 BOM for Excel) on request.
 */
export const GET = withRouteContext('brf.lagenhetsforteckning', async (request, ctx) => {
  const { supabase, companyId, log, requestId } = ctx
  try {
    await requireBrfForm(supabase, companyId)
    const rows = await apartmentRegisterExtract(supabase, companyId)
    if (new URL(request.url).searchParams.get('format') === 'csv') {
      return new NextResponse('﻿' + apartmentRegisterCsv(rows), {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="lagenhetsforteckning.csv"',
          'Cache-Control': 'private, no-store',
        },
      })
    }
    return NextResponse.json({ data: rows })
  } catch (err) {
    return brfRegisterErrorResponse(err, log, requestId)
  }
})
