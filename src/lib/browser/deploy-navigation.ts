/**
 * Taking a new deploy at the next page change instead of asking for a reload.
 *
 * A tab that runs an older build than the server used to show a card and wait
 * for a click on "Ladda om". Most people were about to change page anyway, and
 * a page change is the one moment a full document load costs nothing: the
 * page they are on is being left. So once the tab is known to be behind, the
 * next plain click on an in-app link is handed to the browser as an ordinary
 * document navigation, which fetches the new build. Nothing reloads while the
 * person stays on a page; the card remains for the tab that never navigates.
 *
 * How the click is handed over: next/link leaves a click alone, without
 * preventDefault, when the anchor carries a `target` other than `_self`
 * (isModifiedEvent in next/dist/client/app-dir/link.js). `_top` in a
 * top-level window is the window itself, so marking the anchor `_top` for the
 * length of the click makes the browser navigate this tab natively. The
 * marker is set in the capture phase and nothing is prevented here, so every
 * onClick on the way still runs and a handler that calls preventDefault (a
 * row that opens a panel instead of navigating) still wins, exactly as
 * before. If Next ever stops reading `target`, the link soft-navigates as it
 * does today: the failure mode is the old behaviour. A test in
 * __tests__/deploy-navigation.test.ts watches that line in Next.
 *
 * Not covered on purpose: router.push() navigations (they stay soft) and any
 * click while unsaved work is registered through holdSoftNavigation().
 */

/** sessionStorage key for the last hand-over this tab tried. */
export const DEPLOY_NAVIGATION_ATTEMPT_KEY = 'accounted:deploy-navigation-attempt'

/** How long a stale tab that can update itself waits before showing the card. */
export const RELOAD_CARD_DELAY_MS = 10 * 60 * 1000

// Unsaved work that a full load would destroy but a soft navigation keeps
// (or that the browser would answer with its "leave site?" dialog, which a
// soft navigation never shows). While any hold is active, navigation stays
// exactly as it is today.
let holds = 0

/** Keep navigations soft until the returned release is called. */
export function holdSoftNavigation(): () => void {
  holds += 1
  let released = false
  return () => {
    if (released) return
    released = true
    holds -= 1
  }
}

export function softNavigationHeld(): boolean {
  return holds > 0
}

/** One hand-over is tried per (this build, live build) pair and tab. */
export function deployNavigationAttemptKey(currentBuildId: string, liveBuildId: string): string {
  return `${currentBuildId}>${liveBuildId}`
}

/** Read result when sessionStorage throws: never equal to a real attempt key. */
export const STORAGE_UNAVAILABLE = '\u0000unavailable'

type AttemptStorage = Pick<Storage, 'getItem' | 'setItem'>

export function readDeployNavigationAttempt(storage: AttemptStorage | null | undefined): string | null {
  try {
    return storage?.getItem(DEPLOY_NAVIGATION_ATTEMPT_KEY) ?? null
  } catch {
    // Storage is blocked (private mode, site data disabled). Without a
    // memory of the last attempt the loop guard cannot work, so the caller
    // treats this as "do not hand over": see shouldHardNavigate.
    return STORAGE_UNAVAILABLE
  }
}

export function rememberDeployNavigationAttempt(storage: AttemptStorage | null | undefined, key: string): void {
  try {
    storage?.setItem(DEPLOY_NAVIGATION_ATTEMPT_KEY, key)
  } catch {
    // Same blocked-storage case; reads already answer STORAGE_UNAVAILABLE,
    // which keeps navigation soft, so there is nothing to recover here.
  }
}

export interface HardNavigationInput {
  /** Build id baked into this bundle; '' in dev and self-hosted. */
  currentBuildId: string
  /**
   * null: the tab is not known to be behind. A string: it is; the live
   * build's id, or '' when only a failed Server Action told us.
   */
  liveBuildId: string | null
  /** readDeployNavigationAttempt() */
  attempted: string | null
  /** softNavigationHeld() */
  held: boolean
  /** window.top === window */
  isTopWindow: boolean
  /** window.location.href */
  currentUrl: string
  click: {
    button: number
    metaKey: boolean
    ctrlKey: boolean
    shiftKey: boolean
    altKey: boolean
    defaultPrevented: boolean
  }
  anchor: {
    /** The raw href attribute. */
    href: string | null
    target: string | null
    download: boolean
  }
}

/**
 * Should this click leave the page as a full document load?
 *
 * Only when every answer is yes: this build has an id (hosted), a different
 * build is live, this tab has not already tried for that same pair (a rollout
 * can serve the old build once more; then the card takes over instead of
 * every click becoming a full load), no unsaved work is registered, and the
 * click is a plain left click on a same-origin in-app link to another page.
 */
export function shouldHardNavigate(input: HardNavigationInput): boolean {
  const { currentBuildId, liveBuildId, attempted, click, anchor } = input
  if (!currentBuildId || liveBuildId === null || liveBuildId === currentBuildId) return false
  if (attempted === STORAGE_UNAVAILABLE) return false
  if (attempted === deployNavigationAttemptKey(currentBuildId, liveBuildId)) return false
  if (input.held || !input.isTopWindow) return false

  if (click.defaultPrevented || click.button !== 0) return false
  if (click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return false

  if (!anchor.href || anchor.download) return false
  if (anchor.target && anchor.target !== '_self') return false

  let current: URL
  let next: URL
  try {
    current = new URL(input.currentUrl)
    next = new URL(anchor.href, current)
  } catch {
    // An href the URL parser rejects is not an in-app page; leave it alone.
    return false
  }
  if (next.protocol !== 'http:' && next.protocol !== 'https:') return false
  if (next.origin !== current.origin) return false
  // Same page: a hash jump, or the nav link that refreshes the current page.
  if (next.pathname === current.pathname && next.search === current.search) return false
  // Route handlers answer with files and redirects, not pages.
  if (next.pathname === '/api' || next.pathname.startsWith('/api/')) return false
  return true
}

/**
 * How long to wait before showing the reload card, or 0 for at once.
 *
 * A tab that will take the new build on its next page change waits, so the
 * card only reaches someone who stays on one page. Everything else shows it
 * immediately as before: a click that just died on a missing Server Action
 * (the person needs the way out now), a self-hosted build, and a tab that
 * already tried once for this build.
 */
export function reloadCardDelayMs(input: {
  currentBuildId: string
  liveBuildId: string
  attempted: string | null
}): number {
  const { currentBuildId, liveBuildId, attempted } = input
  if (!currentBuildId || !liveBuildId) return 0
  if (attempted === STORAGE_UNAVAILABLE) return 0
  if (attempted === deployNavigationAttemptKey(currentBuildId, liveBuildId)) return 0
  return RELOAD_CARD_DELAY_MS
}

interface ClickLike {
  target: unknown
  button: number
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  defaultPrevented: boolean
}

interface AnchorLike {
  getAttribute(name: string): string | null
  hasAttribute(name: string): boolean
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
}

interface WindowLike {
  location: { href: string }
  top: unknown
  sessionStorage: AttemptStorage
  setTimeout(handler: () => void, ms: number): unknown
}

function storageOf(win: Pick<WindowLike, 'sessionStorage'>): AttemptStorage | null {
  try {
    return win.sessionStorage
  } catch {
    // The getter itself throws when site data is blocked; answered as
    // STORAGE_UNAVAILABLE by attemptedIn below.
    return null
  }
}

/** The attempt this tab remembers, or STORAGE_UNAVAILABLE when it cannot remember any. */
export function attemptedIn(win: Pick<WindowLike, 'sessionStorage'>): string | null {
  const storage = storageOf(win)
  return storage ? readDeployNavigationAttempt(storage) : STORAGE_UNAVAILABLE
}

/** The capture-phase click handler; split out so it runs without a DOM in tests. */
export function handleDeployNavigationClick(
  event: ClickLike,
  win: WindowLike,
  build: { currentBuildId: string; liveBuildId: string },
): boolean {
  const target = event.target as { closest?: (selector: string) => AnchorLike | null } | null
  const anchor = typeof target?.closest === 'function' ? target.closest('a') : null
  if (!anchor) return false

  const attempted = attemptedIn(win)
  const targetBefore = anchor.getAttribute('target')
  const handOver = shouldHardNavigate({
    ...build,
    attempted,
    held: softNavigationHeld(),
    isTopWindow: win.top === win,
    currentUrl: win.location.href,
    click: event,
    anchor: {
      href: anchor.getAttribute('href'),
      target: targetBefore,
      download: anchor.hasAttribute('download'),
    },
  })
  if (!handOver) return false

  anchor.setAttribute('target', '_top')
  // After every click handler has run: put the anchor back, and count the
  // attempt only if nobody cancelled the click (then no navigation happened
  // and the next link should still get its chance).
  win.setTimeout(() => {
    if (targetBefore === null) anchor.removeAttribute('target')
    else anchor.setAttribute('target', targetBefore)
    if (!event.defaultPrevented) {
      rememberDeployNavigationAttempt(storageOf(win), deployNavigationAttemptKey(build.currentBuildId, build.liveBuildId))
    }
  }, 0)
  return true
}

/** Watch `win` for link clicks while the tab is behind. Returns the uninstall. */
export function installDeployNavigation(
  win: Window,
  build: { currentBuildId: string; liveBuildId: string },
): () => void {
  const onClick = (event: MouseEvent) => {
    handleDeployNavigationClick(event, win, build)
  }
  win.addEventListener('click', onClick, true)
  return () => win.removeEventListener('click', onClick, true)
}
