import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { WebshopStoreSettingsUpdateSchema } from '@/lib/api/schemas'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { prepareCountryRules } from '@/lib/webshop-orders/country-rule-settings'

/**
 * Per-store booking settings (webshop_store_settings): the payment-method ->
 * account mapping and, for Shopify, the accounts per destination country.
 * Both only shape the booking prefill and the bulk sweep; nothing here
 * auto-books.
 */
export const GET = withRouteContext(
  'webshop_order.settings.read',
  async (request, { supabase, companyId, log, requestId }) => {
    const { searchParams } = new URL(request.url)
    const platform = searchParams.get('platform')
    const storeScope = searchParams.get('store_scope')

    let query = supabase
      .from('webshop_store_settings')
      .select('*')
      .eq('company_id', companyId)
    if (platform) query = query.eq('platform', platform)
    if (storeScope) query = query.eq('store_scope', storeScope)

    const { data, error } = await query
    if (error) {
      log.error('failed to read webshop store settings', error)
      return errorResponse(error, log, { requestId })
    }
    return NextResponse.json({ data: data ?? [] })
  },
)

export const PUT = withRouteContext(
  'webshop_order.settings.update',
  async (request, { supabase, user, companyId, log, requestId }) => {
    const validation = await validateBody(request, WebshopStoreSettingsUpdateSchema)
    if (!validation.success) return validation.response
    const { platform, store_scope, payment_method_account_map, country_account_rules } =
      validation.data

    // Country rules are checked against the chart before anything is stored,
    // and the chart gets the preset accounts they name.
    if (country_account_rules !== undefined) {
      const prepared = await prepareCountryRules(
        supabase,
        companyId,
        user.id,
        platform,
        country_account_rules,
        log,
      )
      if (!prepared.ok) {
        if (prepared.kind === 'db_error') {
          log.error('failed to check webshop country rules', prepared.error as Error)
          return errorResponse(prepared.error, log, { requestId })
        }
        return errorResponseFromCode('WEBSHOP_COUNTRY_RULES_INVALID', log, {
          requestId,
          details: { problems: prepared.problems },
        })
      }
    }

    // Only the parts the request carries: the payment-method form and the
    // country form save independently and must not reset each other. A part
    // left undefined is dropped from the JSON body, so the upsert neither
    // inserts nor updates that column (the column default applies on insert).
    const { data, error } = await supabase
      .from('webshop_store_settings')
      .upsert(
        {
          company_id: companyId,
          user_id: user.id,
          platform,
          store_scope,
          payment_method_account_map,
          country_account_rules,
        },
        { onConflict: 'company_id,platform,store_scope' },
      )
      .select()
      .single()

    if (error) {
      log.error('failed to upsert webshop store settings', error)
      return errorResponse(error, log, { requestId })
    }
    return NextResponse.json({ data })
  },
  { requireWrite: true },
)
