import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { WebshopStoreSettingsUpdateSchema } from '@/lib/api/schemas'
import { errorResponse } from '@/lib/errors/get-structured-error'

ensureInitialized()

/**
 * Per-store payment-method -> account mapping (webshop_store_settings).
 * The mapping only PREFILLS the booking dialog; nothing here auto-books.
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
    const { platform, store_scope, payment_method_account_map } = validation.data

    const { data, error } = await supabase
      .from('webshop_store_settings')
      .upsert(
        {
          company_id: companyId,
          user_id: user.id,
          platform,
          store_scope,
          payment_method_account_map,
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
