'use client'

import { unstable_isUnrecognizedActionError } from 'next/navigation'
import { switchCompany } from '@/lib/company/actions'
import {
  TAB_SYNC_CHANNEL,
  TAB_SYNC_STORAGE_KEY,
  encodeStorageValue,
  markCompanySwitchInFlight,
  markSelfSwitchTarget,
} from '@/lib/company/tab-guard'

/**
 * Client-side company switch: persists the new active company via the
 * server action, notifies sibling tabs, then hard-reloads onto the new
 * company. Shared by CompanySwitcher (mobile sheet), the sidebar user-menu
 * flyout and the byrå cockpit so all use the exact same mechanism.
 *
 * `destination` (default '/') is where THIS tab lands after the switch: the
 * cockpit's soft switch (WL-09) enters a client directly on the target page
 * instead of bouncing via the start page. It is always a full-page load: the
 * hard navigation is what tears down React state, router cache, in-flight
 * fetches and blob URLs so nothing from the previous company survives.
 *
 * Returns an error code instead of navigating when the switch fails.
 */
export async function performCompanySwitch(
  companyId: string,
  options: { destination?: string } = {},
): Promise<{ error: string } | void> {
  // The tab guard blocks server-action POSTs from a mismatched tab, but the
  // switch action is the sanctioned exception: it is both dialog exits and
  // the deliberate re-switch from a stale tab. Flag it around the call so the
  // patched fetch lets exactly this action through.
  markCompanySwitchInFlight(true)
  let result: { error?: string }
  try {
    result = await switchCompany(companyId)
  } catch (err) {
    // A tab loaded before a deploy still holds the old build's action id,
    // which the new server does not know ("Server Action ... was not found
    // on the server"). The switch never ran. Reloading loads the new build,
    // where picking the company again works (Next.js docs: "Surface the
    // error as a retry path ... so a refresh recovers the user").
    if (unstable_isUnrecognizedActionError(err)) {
      return reloadOnceForNewDeploy() ? undefined : { error: 'stale_client' }
    }
    throw err
  } finally {
    markCompanySwitchInFlight(false)
  }
  if (result.error) {
    return { error: result.error }
  }
  // This tab's own switch: the broadcast below loops back into this tab's
  // CompanyTabSync (BroadcastChannel delivers to every same-name channel in
  // the same context except the posting object), and without this marker the
  // guard would raise its blocking dialog over the hard navigation already
  // in flight. The marker suppresses only the dialog; stray mutations from
  // this tab are still blocked until the reload lands.
  markSelfSwitchTarget(companyId)
  // Notify every other open tab of the same user so their tab guard can
  // react (blocking dialog, WL-09). BroadcastChannel is the live signal;
  // the localStorage write is the fallback (storage events fire in every
  // other same-origin tab even where BroadcastChannel is unavailable) and
  // the synchronous last-known value the mutation guard reads.
  try {
    window.localStorage.setItem(TAB_SYNC_STORAGE_KEY, encodeStorageValue(companyId))
  } catch {
    // Storage may be unavailable (private mode); BroadcastChannel and the
    // focus-time server checks in CompanyTabSync still cover the other tabs.
  }
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      const channel = new BroadcastChannel(TAB_SYNC_CHANNEL)
      channel.postMessage({ companyId })
      channel.close()
    } catch {
      // Ignore: hard reload still happens below
    }
  }
  // Hard navigation: tears down React state, router cache, in-flight
  // fetches, blob URLs, etc. This is the whole point: nothing from the
  // previous company can survive the switch.
  window.location.assign(options.destination ?? '/')
}

const STALE_DEPLOY_RELOAD_KEY = 'accounted:stale-deploy-reload-at'
const STALE_DEPLOY_RELOAD_WINDOW_MS = 60_000

/**
 * Reload once onto the current deploy. Returns false, without reloading,
 * when this tab already reloaded for the same reason within the last minute
 * (a server that is itself behind the client would otherwise loop us) or
 * when sessionStorage is unavailable (no guard, so no automatic reload).
 */
function reloadOnceForNewDeploy(): boolean {
  try {
    const now = Date.now()
    const last = Number(window.sessionStorage.getItem(STALE_DEPLOY_RELOAD_KEY) ?? 0)
    if (now - last < STALE_DEPLOY_RELOAD_WINDOW_MS) return false
    window.sessionStorage.setItem(STALE_DEPLOY_RELOAD_KEY, String(now))
  } catch {
    // sessionStorage unavailable (private mode, blocked storage): without the
    // guard we cannot rule out a reload loop, so we do not reload and the
    // caller shows its "switch failed" toast instead.
    return false
  }
  window.location.reload()
  return true
}
