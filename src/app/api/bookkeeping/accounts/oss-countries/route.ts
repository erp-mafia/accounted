import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { SetOssAccountCountriesSchema } from '@/lib/api/schemas'
import { setOssAccountCountries } from '@/lib/vat/oss-account-countries'
import { sessionFailureResponse } from '@/lib/operations/session'

/**
 * POST /api/bookkeeping/accounts/oss-countries
 *
 * Says which EU country each OSS account is for, from the OSS underlag's
 * "Konton per land": { accounts: [{ account_number, country, vat_rate? }] }.
 * A sales account with VAT code OSS takes a country and its rate in percent,
 * a 26xx VAT account a country (or EU) and no rate, and null clears either.
 *
 * The rules live in lib/vat/oss-account-countries.ts, shared with the v1
 * operation accounts.oss-countries and gnubok_set_oss_account_countries.
 */
export const POST = withRouteContext(
  'bookkeeping.accounts.oss_countries',
  async (request, { supabase, companyId, user, log, requestId }) => {
    const validation = await validateBody(request, SetOssAccountCountriesSchema)
    if (!validation.success) return validation.response

    const outcome = await setOssAccountCountries({ supabase, companyId, userId: user.id, log }, validation.data.accounts)
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
