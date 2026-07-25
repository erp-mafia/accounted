/**
 * Pre-open a browser tab inside a click handler, then point it at a URL once
 * an async result arrives.
 *
 * Why: window.open() called after an `await` runs outside the click's
 * transient user activation. Browsers expire that activation after ~5 seconds
 * (Safari sooner), so popup blocking kicks in exactly when the request is
 * slow: a cold serverless start made "Förhandsgranska PDF" silently do
 * nothing (support: cbysea.se). Opening the tab synchronously keeps the
 * trusted gesture; the tab is then navigated to the real URL, or closed again
 * if the request fails. Same pattern as AGIPanel's signing tab.
 */

export interface DeferredTab {
  /** True when even the synchronous open was blocked (strict popup blocker). */
  blocked: boolean
  /** Point the pending tab at the final URL. False if the tab is gone. */
  navigate(url: string): boolean
  /** Close the pending tab; call on request failure so no blank tab lingers. */
  close(): void
}

/**
 * Must be called synchronously from a user-gesture handler (click), before
 * any `await`, or the open is popup-blocked in the exact slow cases this
 * helper exists for.
 */
export function openDeferredTab(placeholder?: string): DeferredTab {
  const tab = typeof window !== 'undefined' ? window.open('', '_blank') : null

  if (tab) {
    try {
      // Sever the reverse channel up front: the final page never gets a
      // window.opener, preserving the noopener semantics the direct
      // window.open(url, '_blank', 'noopener') call sites had.
      tab.opener = null
      if (placeholder) {
        tab.document.title = placeholder
        const note = tab.document.createElement('p')
        note.textContent = placeholder
        note.style.cssText =
          'font-family: system-ui, sans-serif; color: #666; padding: 24px;'
        tab.document.body.appendChild(note)
      }
    } catch {
      // The placeholder is cosmetic; never let it break the open.
    }
  }

  return {
    blocked: tab === null,
    navigate(url: string): boolean {
      if (!tab || tab.closed) return false
      try {
        tab.location.href = url
        return true
      } catch {
        return false
      }
    },
    close() {
      try {
        if (tab && !tab.closed) tab.close()
      } catch {
        // Already gone; nothing to clean up.
      }
    },
  }
}
