'use client'

import { switchCompany } from '@/lib/company/actions'

/**
 * Client-side company switch: persists the new active company via the
 * server action, notifies sibling tabs, then hard-reloads onto the new
 * company. Shared by CompanySwitcher (top of the desktop sidebar and the
 * mobile sheet) and the sidebar user-menu flyout so all paths use the
 * exact same mechanism.
 *
 * Returns an error code instead of navigating when the switch fails.
 */
export async function performCompanySwitch(
  companyId: string,
): Promise<{ error: string } | void> {
  const result = await switchCompany(companyId)
  if (result.error) {
    return { error: result.error }
  }
  // Notify every other open tab of the same user so they hard-reload
  // onto the new company. BroadcastChannel is best-effort: if the
  // browser doesn't support it (very old) we still hard-reload
  // ourselves, and other tabs will self-correct via the visibilitychange
  // / pageshow listeners in CompanyTabSync on their next focus event.
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      const channel = new BroadcastChannel('gnubok-company-switch')
      channel.postMessage({ companyId })
      channel.close()
    } catch {
      // Ignore: hard reload still happens below
    }
  }
  // Hard navigation: tears down React state, router cache, in-flight
  // fetches, blob URLs, etc. This is the whole point: nothing from the
  // previous company can survive the switch.
  window.location.assign('/')
}
