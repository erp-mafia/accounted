import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'

/**
 * GET /api/settings/rot-rut-signal
 *
 * Derived suggestion signal for the tax settings page: a company with
 * invoices carrying ROT/RUT deductions must request the Skatteverket payout
 * by 31 January after the payment year (Lag 2009:194 8 §), and missing the
 * date forfeits the payout on account 1513. The settings UI uses this to
 * prompt the user to enable the ROT/RUT deadline; it never flips the flag
 * itself (mirrors the EU-trade and KU signals).
 */
export const GET = withRouteContext(
  'settings.rot_rut_signal',
  async (_request, { supabase, companyId, log }) => {
    const { count, error } = await supabase
      .from('invoices')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .gt('deduction_total', 0)

    // Best-effort signal: on error just hide the suggestion, but keep the
    // failure observable for forensics.
    if (error) {
      log.warn('rot-rut-signal: invoice count failed', { code: error.code })
    }
    const hasRotRut = !error && (count ?? 0) > 0
    return NextResponse.json({ data: { has_rot_rut: hasRotRut } })
  },
)
