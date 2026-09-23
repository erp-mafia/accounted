/**
 * Pure keyboard-guard rules for useDetailPager, extracted from the hook so
 * they are testable in the node test environment (the hook itself needs a
 * browser to render). Only structural types: the hook passes the real
 * document, tests pass plain objects.
 */

/**
 * Overlays that are actually open. Mirrors the Esc guard selector in
 * components/agent/AgentSheet.tsx: match on data-state="open", never on the
 * container alone. The agent sheet renders role="dialog" and stays mounted
 * with display:none once it has been opened, so keying off a bare
 * [role="dialog"] would kill arrow paging for the rest of the tab session;
 * conversely open dropdown menus (Radix menu/select/listbox content) carry
 * no dialog role and must still block.
 */
const OPEN_OVERLAY_SELECTOR = [
  '[data-radix-popper-content-wrapper] [data-state="open"]',
  '[role="dialog"][data-state="open"]',
  '[role="alertdialog"][data-state="open"]',
  '[role="listbox"][data-state="open"]',
  '[data-radix-menu-content][data-state="open"]',
  '[data-radix-select-content][data-state="open"]',
].join(', ')

/**
 * Containers whose focused content owns the arrow keys regardless of
 * data-state, for overlays that do not mark themselves the Radix way.
 * A display:none container can never hold focus, so a mounted-but-hidden
 * sheet does not block through this path either.
 */
const FOCUS_CONTAINER_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]'

export interface OverlayProbeElement {
  closest(selectors: string): unknown
}

export interface OverlayProbeDocument {
  querySelector(selectors: string): unknown
  readonly activeElement: OverlayProbeElement | null
}

/** True while an overlay that should own the keyboard is open or focused. */
export function isOverlayBlocking(doc: OverlayProbeDocument): boolean {
  if (doc.querySelector(OPEN_OVERLAY_SELECTOR)) return true
  const active = doc.activeElement
  return Boolean(active?.closest(FOCUS_CONTAINER_SELECTOR))
}

/**
 * True for targets that own arrow keys: text fields, selects, contentEditable.
 * Duck-typed on tagName/isContentEditable instead of instanceof HTMLElement so
 * the rule works without DOM globals (tests, SSR); the semantics are the same
 * for real elements.
 */
export function isEditableTarget(target: unknown): boolean {
  if (target === null || typeof target !== 'object') return false
  const el = target as { tagName?: unknown; isContentEditable?: unknown }
  if (el.isContentEditable === true) return true
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
}

export interface ArrowKeyEventLike {
  key: string
  defaultPrevented: boolean
  isComposing: boolean
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  target: unknown
}

/**
 * The full keydown decision: which paging action, if any, a keydown event
 * should trigger. Returns null whenever anything nearer the user owns the key.
 */
export function resolveArrowKeyAction(
  e: ArrowKeyEventLike,
  doc: OverlayProbeDocument,
): 'prev' | 'next' | null {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return null
  if (e.defaultPrevented || e.isComposing) return null
  // Plain arrows only: modified arrows are browser/OS shortcuts
  // (cmd+arrow is history navigation on macOS).
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null
  // Never steal arrows from text editing (e.g. the notes textarea on the
  // verifikat page).
  if (isEditableTarget(e.target)) return null
  if (isOverlayBlocking(doc)) return null
  return e.key === 'ArrowLeft' ? 'prev' : 'next'
}
