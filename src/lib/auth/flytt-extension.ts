/**
 * The browser extension "Flytta till Accounted": Accounted's own tool that
 * moves a company's books and documents out of Fortnox from the user's own
 * logged-in browser, and writes them to Accounted through the MCP endpoint
 * as that user.
 *
 * A Chrome extension's id is fixed by the public key in its manifest, so the
 * id below is the same for everyone who loads this build. It is the beta
 * build, handed out as a folder. A Chrome Web Store listing gets an id of
 * its own from the store: add it here when the listing exists, and remove
 * the beta id once nobody runs it.
 *
 * Two doors read these values, and nothing else may:
 *   - the MCP endpoint's Origin check (extensions/general/mcp-server/
 *     origin-guard.ts), so the extension's page may call the endpoint
 *     without hiding where it comes from. A valid key is still required.
 *   - the OAuth redirect allowlist (oauth-allowlist.ts), so the extension
 *     can offer "Logga in med Accounted" instead of a pasted API key.
 *     Chrome delivers https://<id>.chromiumapp.org/ only to the extension
 *     with that id, and the code is PKCE-bound like every other.
 */
export const FLYTT_EXTENSION_ID = 'ooeaogbjfhciekiidjaehikcbccomkmj'

/** The Origin header Chrome sends from the extension's own pages. */
export const FLYTT_EXTENSION_ORIGIN = `chrome-extension://${FLYTT_EXTENSION_ID}`

/** What chrome.identity.getRedirectURL() answers for the extension. */
export const FLYTT_EXTENSION_REDIRECT_URI = `https://${FLYTT_EXTENSION_ID}.chromiumapp.org/`
