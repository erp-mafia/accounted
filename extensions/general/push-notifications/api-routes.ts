import { NextResponse } from 'next/server'
import type { ApiRouteDefinition, ExtensionContext } from '@/lib/extensions/types'
import { getVapidPublicKey } from './notification-sender'
import { getSettings, saveSettings } from './index'

// ============================================================
// /subscribe: GET: get VAPID public key for client-side subscription
// ============================================================

async function handleGetSubscribe(
  _request: Request,
  _ctx?: ExtensionContext
): Promise<Response> {
  const vapidKey = getVapidPublicKey()

  if (!vapidKey) {
    return NextResponse.json(
      { error: 'Push notifications not configured' },
      { status: 500 }
    )
  }

  return NextResponse.json({ vapidPublicKey: vapidKey })
}

// ============================================================
// /subscribe: POST: save a new push subscription
// ============================================================

async function handlePostSubscribe(
  request: Request,
  ctx?: ExtensionContext
): Promise<Response> {
  const userId = ctx!.userId
  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()

  const body = await request.json()
  const { endpoint, keys } = body

  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return NextResponse.json(
      { error: 'Invalid subscription data' },
      { status: 400 }
    )
  }

  // Get user agent for debugging
  const userAgent = request.headers.get('user-agent') || null

  // Upsert subscription (update if endpoint exists)
  const { data, error } = await supabase
    .from('push_subscriptions')
    .upsert(
      {
        user_id: userId,
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
        user_agent: userAgent,
        is_active: true,
        last_used_at: new Date().toISOString(),
      },
      {
        onConflict: 'user_id,endpoint',
      }
    )
    .select()
    .single()

  if (error) {
    console.error('Error saving subscription:', error)
    return NextResponse.json(
      { error: 'Failed to save subscription' },
      { status: 500 }
    )
  }

  // Also ensure notification settings exist with defaults
  await supabase
    .from('notification_settings')
    .upsert(
      {
        user_id: userId,
        tax_deadlines_enabled: true,
        invoice_reminders_enabled: true,
        push_enabled: true,
        email_enabled: true,
        quiet_start: '21:00',
        quiet_end: '08:00',
      },
      {
        onConflict: 'user_id',
        ignoreDuplicates: true,
      }
    )

  return NextResponse.json({ success: true, id: data.id })
}

// ============================================================
// /subscribe: DELETE: remove a push subscription
// ============================================================

async function handleDeleteSubscribe(
  request: Request,
  ctx?: ExtensionContext
): Promise<Response> {
  const userId = ctx!.userId
  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()

  const body = await request.json()
  const { endpoint } = body

  if (!endpoint) {
    return NextResponse.json(
      { error: 'Endpoint is required' },
      { status: 400 }
    )
  }

  const { error } = await supabase
    .from('push_subscriptions')
    .delete()
    .eq('company_id', userId)
    .eq('endpoint', endpoint)

  if (error) {
    return NextResponse.json(
      { error: 'Failed to remove subscription' },
      { status: 500 }
    )
  }

  return NextResponse.json({ success: true })
}

// ============================================================
// /settings: GET: get current notification settings
// ============================================================

async function handleGetSettings(
  _request: Request,
  ctx?: ExtensionContext
): Promise<Response> {
  const userId = ctx!.userId
  const settings = await getSettings(userId)
  return NextResponse.json({ data: settings })
}

// ============================================================
// /settings: PUT: update notification settings
// ============================================================

async function handleUpdateSettings(
  request: Request,
  ctx?: ExtensionContext
): Promise<Response> {
  const userId = ctx!.userId
  const body = await request.json()

  const allowedKeys = [
    'periodLockedEnabled',
    'periodYearClosedEnabled',
    'invoiceSentEnabled',
    'receiptExtractedEnabled',
    'receiptMatchedEnabled',
  ]
  const filtered: Record<string, unknown> = {}
  for (const key of allowedKeys) {
    if (key in body) {
      filtered[key] = body[key]
    }
  }

  if (Object.keys(filtered).length === 0) {
    return NextResponse.json({ error: 'No valid settings provided' }, { status: 400 })
  }

  const settings = await saveSettings(userId, filtered)
  return NextResponse.json({ data: settings })
}

// ============================================================
// Route definitions
// ============================================================

export const pushNotificationsApiRoutes: ApiRouteDefinition[] = [
  {
    method: 'GET',
    path: '/subscribe',
    handler: handleGetSubscribe,
  },
  {
    method: 'POST',
    path: '/subscribe',
    handler: handlePostSubscribe,
  },
  {
    method: 'DELETE',
    path: '/subscribe',
    handler: handleDeleteSubscribe,
  },
  {
    method: 'GET',
    path: '/settings',
    handler: handleGetSettings,
  },
  {
    method: 'PUT',
    path: '/settings',
    handler: handleUpdateSettings,
  },
]
