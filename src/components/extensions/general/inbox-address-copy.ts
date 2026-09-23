import { copyToClipboard } from '@/lib/browser/copy-to-clipboard'

/**
 * Copy state for the inbox address in the workspace header.
 *
 * `idle` claims nothing, `copied` is only reachable after the clipboard write
 * resolved, and `failed` means the address is NOT on the clipboard.
 */
export type AddressCopyState = 'idle' | 'copied' | 'failed'

/**
 * Copy the document-inbox address and report which state the header must show.
 *
 * Why this exists as its own function: the previous handler fired
 * `navigator.clipboard.writeText(...).catch(() => {})` and then showed
 * "Adress kopierad" unconditionally, so an insecure context, a blocking
 * Permissions-Policy or a document that had lost focus produced a success
 * message with an empty clipboard. The user then waits for supplier invoices at
 * an address they never captured, and nothing in the UI ever contradicts that.
 *
 * `unavailable` (no Clipboard API at all) and `failed` (the write was rejected)
 * collapse into one UI state on purpose: from the user's side both mean the
 * address is not on the clipboard and manual selection is the only way to get
 * it. The distinction only matters for logging, which this surface does not do.
 *
 * Call this as the first `await` in the click handler: a clipboard write issued
 * after another await runs outside the click's transient user activation and is
 * rejected on that ground alone.
 */
export async function copyInboxAddress(
  address: string,
): Promise<Exclude<AddressCopyState, 'idle'>> {
  const result = await copyToClipboard(address)
  return result === 'copied' ? 'copied' : 'failed'
}
