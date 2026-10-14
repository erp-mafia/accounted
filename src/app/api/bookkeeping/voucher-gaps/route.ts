import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody, validateQuery } from '@/lib/api/validate'
import { VoucherGapQuerySchema, SaveGapExplanationSchema } from '@/lib/api/schemas'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import {
  listVoucherGaps,
  saveVoucherGapExplanation,
  type VoucherGapListing,
} from '@/lib/core/bookkeeping/voucher-gaps'
import { getErrorEntry } from '@/lib/errors/structured-errors'

// Voucher gap detection + explanations (BFNAR 2013:2 — gaps in voucher
// sequences must be documented). Response shapes are legacy `{ data }` /
// `{ error: string }`.

export const GET = withRouteContext('voucher_gaps.list', async (request, ctx) => {
  const { supabase, companyId, log } = ctx

  const validation = validateQuery(request, VoucherGapQuerySchema, {
    log,
    operation: 'voucher_gaps.list',
  })
  if (!validation.success) return validation.response
  const { fiscal_period_id, voucher_series } = validation.data

  // The listing every door shares (lib/core/bookkeeping/voucher-gaps.ts):
  // series A is checked when the year has no sequence row, and any failed
  // read is a 500, never "no gaps" on a compliance view whose check did not run.
  let listing: VoucherGapListing
  try {
    listing = await listVoucherGaps(supabase, companyId, fiscal_period_id, { series: voucher_series })
  } catch (err) {
    log.error('voucher gap listing failed', err as Error)
    return NextResponse.json({ error: getUserErrorMessage(err) }, { status: 500 })
  }

  const allGaps = listing.gaps
  const unexplained = allGaps.filter((g) => !g.explanation).length

  return NextResponse.json({
    data: {
      gaps: allGaps,
      totalGaps: allGaps.length,
      unexplainedGaps: unexplained,
    },
  })
})

export const POST = withRouteContext(
  'voucher_gaps.explain',
  async (request, ctx) => {
    const { supabase, companyId, user, log } = ctx

    const validation = await validateBody(request, SaveGapExplanationSchema, {
      log,
      operation: 'voucher_gaps.explain',
    })
    if (!validation.success) return validation.response

    // Insert only, through the write every door shares: an explanation is
    // write-once (DECISIONS 2026-10-01), so an explained gap answers 409
    // instead of being overwritten without a trace (this used to upsert).
    // The service also refuses a series outside A-Z and a reversed range,
    // which this route's schema let through to the database.
    const result = await saveVoucherGapExplanation(supabase, companyId, user.id, validation.data)
    if (!result.ok) {
      if (result.code === 'FORBIDDEN') {
        return NextResponse.json(
          { error: 'Only company owners and admins can document gap explanations' },
          { status: 403 }
        )
      }
      if (result.status === 500) log.error('voucher gap explanation save failed', { details: result.details })
      const entry = getErrorEntry(result.code)
      return NextResponse.json(
        { error: entry?.message_sv ?? getUserErrorMessage(result.code), code: result.code, details: result.details },
        { status: result.status }
      )
    }
    return NextResponse.json({ data: result.data })
  },
  { requireWrite: true },
)
