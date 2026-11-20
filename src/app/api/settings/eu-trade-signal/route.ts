import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { loadVatDeclarationLedger } from '@/lib/reports/vat-declaration'
import { euTradeInRutor } from '@/lib/vat/eu-trade'

/** How far back to look for EU trade. */
const LOOKBACK_MONTHS = 15

/**
 * GET /api/settings/eu-trade-signal
 *
 * Derived suggestion signal for the tax settings page: EU trade in the
 * ledger, read as the momsdeklaration reads it (the same rutor, the
 * company's own momskoder included) over the last 15 months.
 *
 *   - has_eu_sales (rutor 35, 38, 39): a periodisk sammanställning
 *     obligation (SFL 35 kap.);
 *   - has_eu_purchases (rutor 20, 21, 37): with EU sales, what makes
 *     helårsmoms due earlier (lib/vat/eu-trade.ts). Purchases used to be
 *     invisible here, so a company buying EU services kept the later
 *     yearly deadline (crm#1171, crm#1139).
 *
 * The settings UI uses this to prompt the user to confirm EU trade and PS
 * registration; it never flips the flags itself.
 */
export const GET = withRouteContext(
  'settings.eu_trade_signal',
  async (_request, { supabase, companyId }) => {
    const today = todayIsoStockholm()
    const since = new Date(`${today}T00:00:00Z`)
    since.setUTCMonth(since.getUTCMonth() - LOOKBACK_MONTHS)
    const sinceStr = since.toISOString().slice(0, 10)

    const { rutor } = await loadVatDeclarationLedger(supabase, companyId!, sinceStr, today)
    const { purchases, sales } = euTradeInRutor(rutor)

    return NextResponse.json({
      data: {
        has_eu_sales: sales.length > 0,
        has_eu_purchases: purchases.length > 0,
        eu_trade_rutor: [...purchases, ...sales],
      },
    })
  },
)
