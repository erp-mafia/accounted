/**
 * Per-URL authentication mode for the MCP endpoint.
 *
 * The default is lazy (issue #1814): a client with no token may initialize,
 * list the catalog and call the public documentation tools (public-tools.ts);
 * the first protected call answers 401 + WWW-Authenticate, which the client
 * turns into its Connect prompt.
 *
 * `auth=required` on the endpoint URL makes that URL eager instead: EVERY
 * tokenless request answers the 401 challenge, `initialize` included. It has
 * one consumer. claude.ai's two-step "Add custom connector" dialog probes the
 * URL without credentials and pre-fills the Authentication choice from the
 * answer (Anthropic: "Claude checks the URL and pre-fills the authentication
 * settings it detects"). A 200 on that probe is read as "None", an authless
 * server, and a connector added with that default never opens the sign-in
 * when the challenge arrives later. A 401 is the only answer the dialog reads
 * as OAuth (Anthropic: "Claude does not honor a WWW-Authenticate header on a
 * 200 response"), so the links we control (Settings -> API & MCP, the
 * onboarding checklist, both docs pages, the website) carry the flag.
 *
 * The bare URL keeps lazy authentication for Claude Code, the plugin, Cursor,
 * ChatGPT developer mode and hand-typed adds, and connector records created
 * before the flag existed are unaffected. Either way the flag only changes the
 * answer to tokenless requests: a caller that holds a token never notices it.
 */
export const AUTH_MODE_QUERY_PARAM = 'auth'
export const AUTH_MODE_REQUIRED = 'required'

export function isEagerAuthRequested(request: Request): boolean {
  return new URL(request.url).searchParams.get(AUTH_MODE_QUERY_PARAM) === AUTH_MODE_REQUIRED
}
