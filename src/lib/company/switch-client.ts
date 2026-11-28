'use client'

import {
  COMPANY_SWITCH_PATH,
  TAB_SYNC_CHANNEL,
  TAB_SYNC_STORAGE_KEY,
  encodeStorageValue,
  markCompanySwitchInFlight,
  markSelfSwitchTarget,
} from '@/lib/company/tab-guard'
import { isStartPagePath } from '@/lib/company/start-page'

/**
 * Client-side company switch: persists the new active company through
 * POST /api/company/switch, notifies sibling tabs, then hard-reloads onto the
 * new company. Shared by CompanySwitcher (mobile sheet), the sidebar
 * user-menu flyout and the byrå cockpit so all use the exact same mechanism.
 *
 * `destination` is where THIS tab lands after the switch: the cockpit's soft
 * switch (WL-09) enters a client directly on the target page instead of
 * bouncing via the start page. Without one the tab lands on the person's
 * start page in the new company (lib/company/start-page.ts), which the switch
 * route answers with: '/' unless they chose another. It is always a
 * full-page load: the hard navigation is what tears down React state, router
 * cache, in-flight fetches and blob URLs so nothing from the previous company
 * survives.
 *
 * A plain fetch to a route handler, never a server action: an action that
 * sets cookies (the switch sets two) makes Next.js re-render the page being
 * left and stream it back in the action's response, which the hard
 * navigation then aborts mid-stream. Safari and Firefox reject that aborted
 * stream, and the dashboard error boundary flashed "Något gick fel" on every
 * client opened from the byrå client list.
 *
 * Returns an error code instead of navigating when the switch fails:
 * 'not_member', 'company_locked', 'Unauthorized' (signed out) or
 * 'persist_failed' (anything else, retryable).
 */
export async function performCompanySwitch(
  companyId: string,
  options: { destination?: string } = {},
): Promise<{ error: string } | void> {
  // The tab guard blocks /api mutations from a mismatched tab, but the
  // switch is the sanctioned exception: it is both dialog exits and the
  // deliberate re-switch from a stale tab. Flag it around the request so the
  // patched fetch lets exactly this request through.
  markCompanySwitchInFlight(true)
  let persisted: { error: string } | { startPath: string }
  try {
    persisted = await persistActiveCompany(companyId)
  } finally {
    markCompanySwitchInFlight(false)
  }
  if ('error' in persisted) {
    return { error: persisted.error }
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
  window.location.assign(options.destination ?? persisted.startPath)
}

/** The switch route's refusals, as the codes every caller already handles. */
const SWITCH_REFUSALS: Readonly<Record<string, string>> = {
  COMPANY_SWITCH_NOT_MEMBER: 'not_member',
  COMPANY_SWITCH_LOCKED: 'company_locked',
}

/**
 * POST the switch. The start page to land on when the active company was
 * saved (a known start page, else '/'), else the error code
 * performCompanySwitch returns. Success is read from the body, not the
 * status alone: a 200 that does not name the company (a redirect followed to
 * a page) must not send the user on into the company they meant to leave.
 */
async function persistActiveCompany(companyId: string): Promise<{ error: string } | { startPath: string }> {
  let res: Response
  try {
    res = await fetch(COMPANY_SWITCH_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ company_id: companyId }),
    })
  } catch {
    // No answer at all (offline, a dropped connection): the switch may not
    // have reached the server. Every caller turns this code into its own
    // "the switch failed, try again" message, so the user can retry instead
    // of facing a spinner that never stops.
    return { error: 'persist_failed' }
  }
  if (res.status === 401) return { error: 'Unauthorized' }
  const body = (await res.json().catch(() => null)) as {
    data?: { company_id?: unknown; start_path?: unknown } | null
    error?: unknown
  } | null
  if (res.ok && body?.data?.company_id === companyId) {
    // Whitelisted: only a known start page is ever followed.
    const startPath = body?.data?.start_path
    return { startPath: isStartPagePath(startPath) ? startPath : '/' }
  }
  const code =
    body?.error && typeof body.error === 'object' ? (body.error as { code?: unknown }).code : undefined
  return { error: (typeof code === 'string' && SWITCH_REFUSALS[code]) || 'persist_failed' }
}

/**
 * The company_switcher message key for a switch that failed (the error code
 * performCompanySwitch returns): a lost membership and a company paused for
 * this account each say so; anything else is "could not be saved, try
 * again". For every entry point that enters a company (the byrå client list,
 * Nyckeltal), so a failed entry names its cause instead of a bare "could not
 * open".
 */
export function companySwitchErrorKey(error: string): 'error_no_access' | 'error_locked' | 'error_switch_failed' {
  if (error === 'not_member') return 'error_no_access'
  if (error === 'company_locked') return 'error_locked'
  return 'error_switch_failed'
}
