/**
 * Browser PushManager subscribe/unsubscribe against the push-notifications
 * extension. Hidden when the extension is off or VAPID is missing: GET
 * /subscribe then returns 404/500 and fetchVapidPublicKey() is null.
 */

export const PUSH_SUBSCRIBE_PATH = '/api/extensions/ext/push-notifications/subscribe'
export const PUSH_SETTINGS_PATH = '/api/extensions/ext/push-notifications/settings'
export const PUSH_TEST_PATH = '/api/extensions/ext/push-notifications/test'

export type PushEventSettingKey =
  | 'periodLockedEnabled'
  | 'periodYearClosedEnabled'
  | 'invoiceSentEnabled'
  | 'receiptExtractedEnabled'
  | 'receiptMatchedEnabled'
  | 'missingUnderlagEnabled'

export type PushEventSettings = Record<PushEventSettingKey, boolean>

export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const output = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) {
    output[i] = raw.charCodeAt(i)
  }
  return output
}

export function isPushApiSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

/** True when this document runs as an installed home-screen / standalone app. */
export function isInstalledWebApp(): boolean {
  if (typeof window === 'undefined') return false
  if (window.matchMedia('(display-mode: standalone)').matches) return true
  return (navigator as Navigator & { standalone?: boolean }).standalone === true
}

export async function fetchVapidPublicKey(): Promise<string | null> {
  const res = await fetch(PUSH_SUBSCRIBE_PATH, { credentials: 'same-origin' })
  if (!res.ok) return null
  const body = (await res.json()) as { vapidPublicKey?: unknown }
  return typeof body.vapidPublicKey === 'string' && body.vapidPublicKey.length > 0
    ? body.vapidPublicKey
    : null
}

const SW_READY_TIMEOUT_MS = 8_000

/**
 * Register /sw.js if needed and wait until it can control this page.
 * iOS home-screen PWAs often open before the worker controls the client;
 * awaiting `ready` without a timeout hangs forever and used to hide the
 * entire Push settings group.
 */
export async function ensurePushServiceWorker(): Promise<ServiceWorkerRegistration> {
  if (!('serviceWorker' in navigator)) {
    throw new Error('unsupported')
  }
  let registration = await navigator.serviceWorker.getRegistration('/')
  if (!registration) {
    registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
  }
  const ready = navigator.serviceWorker.ready
  const timedOut = new Promise<never>((_, reject) => {
    window.setTimeout(() => reject(new Error('sw-timeout')), SW_READY_TIMEOUT_MS)
  })
  return Promise.race([ready, timedOut])
}

export async function getExistingPushSubscription(): Promise<PushSubscription | null> {
  if (!isPushApiSupported()) return null
  try {
    // Probe only: do not register or wait for control. Init used to hang on
    // `ready` and hide the whole Push settings group on iOS first launch.
    const registration = await navigator.serviceWorker.getRegistration('/')
    if (!registration) return null
    return registration.pushManager.getSubscription()
  } catch {
    return null
  }
}

async function persistSubscription(subscription: PushSubscription): Promise<void> {
  const json = subscription.toJSON()
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error('invalid-subscription')
  }
  const res = await fetch(PUSH_SUBSCRIBE_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
  })
  if (!res.ok) throw new Error('persist-failed')
}

export async function subscribeToPush(vapidPublicKey: string): Promise<void> {
  if (!isPushApiSupported()) throw new Error('unsupported')
  // Ask permission before any other await: iOS drops the user-gesture if we
  // spend it on service-worker registration first.
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('permission-denied')

  const registration = await ensurePushServiceWorker()
  let subscription = await registration.pushManager.getSubscription()
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource,
    })
  }

  try {
    await persistSubscription(subscription)
  } catch (error) {
    await subscription.unsubscribe().catch(() => undefined)
    throw error
  }
}

export async function unsubscribeFromPush(): Promise<void> {
  const subscription = await getExistingPushSubscription()
  if (!subscription) return

  const endpoint = subscription.endpoint
  const res = await fetch(PUSH_SUBSCRIBE_PATH, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint }),
  })
  if (!res.ok && res.status !== 404) throw new Error('unsubscribe-failed')
  await subscription.unsubscribe()
}

export async function fetchPushEventSettings(): Promise<PushEventSettings | null> {
  const res = await fetch(PUSH_SETTINGS_PATH)
  if (!res.ok) return null
  const body = (await res.json()) as { data?: Partial<PushEventSettings> }
  const data = body.data
  if (!data) return null
  return {
    periodLockedEnabled: data.periodLockedEnabled !== false,
    periodYearClosedEnabled: data.periodYearClosedEnabled !== false,
    invoiceSentEnabled: data.invoiceSentEnabled === true,
    receiptExtractedEnabled: data.receiptExtractedEnabled !== false,
    receiptMatchedEnabled: data.receiptMatchedEnabled !== false,
    missingUnderlagEnabled: data.missingUnderlagEnabled !== false,
  }
}

export async function sendTestPush(): Promise<
  'sent' | 'no_subscriptions' | 'failed'
> {
  const res = await fetch(PUSH_TEST_PATH, { method: 'POST' })
  if (res.ok) return 'sent'
  if (res.status === 409) return 'no_subscriptions'
  return 'failed'
}

export async function savePushEventSetting(
  key: PushEventSettingKey,
  value: boolean,
): Promise<boolean> {
  const res = await fetch(PUSH_SETTINGS_PATH, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [key]: value }),
  })
  return res.ok
}
