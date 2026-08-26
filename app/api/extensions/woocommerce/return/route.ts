import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { loadExtensions } from '@/lib/extensions/loader'
import { extensionRegistry } from '@/lib/extensions/registry'
import { createLogger } from '@/lib/logger'

const log = createLogger('woocommerce/return')

/**
 * GET /api/extensions/woocommerce/return
 *
 * Browser leg of the wc-auth handshake: WooCommerce redirects the merchant
 * here with ?success=1|0&user_id=<our oauth_state>. The credentials arrive on
 * the separate server-to-server callback (usually before this redirect, but
 * ordering is not guaranteed), so on success this route only sends the user
 * back to the import page; the panel polls /status until the row is active.
 */
export async function GET(request: Request) {
  loadExtensions()
  if (!extensionRegistry.get('woocommerce')) {
    return NextResponse.json(
      { error: 'WooCommerce extension is not enabled', code: 'EXTENSION_DISABLED' },
      { status: 503 },
    )
  }

  const { searchParams } = new URL(request.url)
  const success = searchParams.get('success')
  const state = searchParams.get('user_id')

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
  // The WooCommerce surface lives on the import page; the base already has a
  // query, so appended params below must use '&'.
  const returnUrl = `${baseUrl}/import?mode=woocommerce`

  if (success === '1') {
    return NextResponse.redirect(`${returnUrl}&woocommerce_connected=true`)
  }

  // Denied (or malformed): close out the pending row so its state can never
  // complete a late callback, then surface the denial to the panel.
  if (state) {
    try {
      const supabase = await createServiceClient()
      await supabase
        .from('woocommerce_connections')
        .update({
          status: 'error',
          error_message: 'Anslutningen nekades i butiken.',
          oauth_state: null,
        })
        .eq('oauth_state', state)
        .eq('status', 'pending')
    } catch (cleanupError) {
      log.error('failed to clean up denied connection', {
        message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      })
    }
  }

  return NextResponse.redirect(`${returnUrl}&woocommerce_error=denied`)
}
