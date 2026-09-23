/**
 * Copy text to the clipboard and report honestly whether it worked.
 *
 * Why: `navigator.clipboard.writeText` rejects for ordinary, non-exceptional
 * reasons (insecure context on plain http, a Permissions-Policy that blocks
 * clipboard-write, the document having lost focus) and the API is absent
 * entirely in older or hardened browsers. A copy button that swallows the
 * rejection, or that never awaits it before flipping to a check mark, tells
 * the user "copied" when nothing was copied. On a one-time secret (an API key
 * shown once, a TOTP enrolment key) that turns a recoverable click into an
 * unrecoverable one: the key is gone and every integration has to be
 * re-pointed at a new one.
 *
 * Callers must render a visible failure state and keep the text on screen as
 * selectable content. No clipboard means no programmatic fallback either, so
 * manual selection is the only fallback that actually works.
 *
 * Call this as the first `await` in a click handler: a clipboard write issued
 * after some other await runs outside the click's transient user activation
 * and is rejected on that ground alone.
 */
export type CopyResult =
  /** The write resolved: the text is on the clipboard. */
  | 'copied'
  /** No Clipboard API at all (SSR, pre-2018 browser, stripped navigator). */
  | 'unavailable'
  /** The API exists but the write was rejected (permissions, focus, http). */
  | 'failed'

export async function copyToClipboard(text: string): Promise<CopyResult> {
  const clipboard =
    typeof navigator !== 'undefined'
      ? (navigator.clipboard as Clipboard | undefined)
      : undefined

  if (!clipboard || typeof clipboard.writeText !== 'function') {
    return 'unavailable'
  }

  try {
    await clipboard.writeText(text)
    return 'copied'
  } catch {
    return 'failed'
  }
}
