/**
 * Home-screen / taskbar badge for the installed PWA (Badging API).
 *
 * Chrome and installed Android PWAs support it without a notification
 * permission. iOS 16.4+ does for Add-to-Home-Screen apps; later iOS builds
 * may also require notification permission. Unsupported browsers no-op.
 */

type BadgeNavigator = Navigator & {
  setAppBadge?: (contents?: number) => Promise<void>
  clearAppBadge?: () => Promise<void>
}

export function canSetAppBadge(): boolean {
  if (typeof navigator === 'undefined') return false
  const nav = navigator as BadgeNavigator
  return typeof nav.setAppBadge === 'function'
}

export async function syncAppBadge(count: number): Promise<void> {
  if (!canSetAppBadge()) return
  const nav = navigator as BadgeNavigator
  try {
    if (count > 0) await nav.setAppBadge?.(count)
    else await nav.clearAppBadge?.()
  } catch {
    // Not installed, permission denied, or OS rejected the write.
  }
}
