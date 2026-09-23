/**
 * Per-tab memory of what the user has typed into the support dialog.
 *
 * The dialog's state lives in React, and the dialog can unmount on close (the
 * account menu that hosts one trigger is removed from the DOM when it closes),
 * so a closed dialog used to take the typed message with it for good. The
 * draft is kept here until the message is actually delivered, so closing and
 * reopening the dialog, or opening it from another trigger, finds the text
 * again.
 *
 * sessionStorage on purpose: "this tab, this session". It survives a reload
 * and nothing else, never follows the user to another device, and a closed
 * tab forgets it. Logout clears it, so the next person on a shared tab does
 * not see it. Every access is wrapped: storage can throw (privacy modes,
 * sandboxed frames), and then the draft simply lives as long as the dialog.
 */

export const SUPPORT_DRAFT_KEY = 'accounted-support-draft'

function storage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null
    return window.sessionStorage
  } catch {
    return null
  }
}

export function readSupportDraft(): string {
  const store = storage()
  if (!store) return ''
  try {
    return store.getItem(SUPPORT_DRAFT_KEY) ?? ''
  } catch {
    return ''
  }
}

/** Stores the draft; blank text removes it, so whitespace never reads as a draft. */
export function writeSupportDraft(text: string): void {
  const store = storage()
  if (!store) return
  try {
    if (text.trim().length === 0) store.removeItem(SUPPORT_DRAFT_KEY)
    else store.setItem(SUPPORT_DRAFT_KEY, text)
  } catch {
    // Quota or privacy mode: the draft then lives only while the dialog does.
  }
}

export function clearSupportDraft(): void {
  writeSupportDraft('')
}
