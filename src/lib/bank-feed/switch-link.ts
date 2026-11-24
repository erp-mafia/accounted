/**
 * Where the switch from Enable Banking to Open Payments is done, as a URL:
 * the Kopplingar page with the connection named, which the page turns into
 * Koppla banken in switch mode for that row. Dependency-free so the browser
 * (the Kopplingar page reads the param) and the server (worklist, notices,
 * mails) build and read the same link.
 */

export const SWITCH_DEEP_LINK_PARAM = 'bank_connect_switch'

/** `/settings/connections?bank_connect_switch=<connection id>`, with an origin for mail. */
export function switchDeepLink(connectionId: string, origin = ''): string {
  return `${origin}/settings/connections?${SWITCH_DEEP_LINK_PARAM}=${encodeURIComponent(connectionId)}`
}

/** The one connection's deep link, or Kopplingar when several wait (each row there offers the switch). */
export function switchLinkFor(state: { pending: ReadonlyArray<{ connection_id: string }> }, origin = ''): string {
  return state.pending.length === 1 ? switchDeepLink(state.pending[0].connection_id, origin) : `${origin}/settings/connections`
}

/**
 * Where a bank the new provider does not reach goes on: the bank file import.
 * The mail to such a company and its Kopplingar row both lead here.
 */
export const BANK_FILE_IMPORT_PATH = '/import?mode=bank'
