import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  DEPLOY_NAVIGATION_ATTEMPT_KEY,
  RELOAD_CARD_DELAY_MS,
  STORAGE_UNAVAILABLE,
  attemptedIn,
  deployNavigationAttemptKey,
  handleDeployNavigationClick,
  holdSoftNavigation,
  readDeployNavigationAttempt,
  reloadCardDelayMs,
  rememberDeployNavigationAttempt,
  shouldHardNavigate,
  softNavigationHeld,
  type HardNavigationInput,
} from '../deploy-navigation'

const OLD = 'aaaa111'
const NEW = 'bbbb222'

function input(over: Partial<HardNavigationInput> = {}): HardNavigationInput {
  return {
    currentBuildId: OLD,
    liveBuildId: NEW,
    attempted: null,
    held: false,
    isTopWindow: true,
    currentUrl: 'https://app.example.test/transactions?view=all',
    click: { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false },
    anchor: { href: '/invoices', target: null, download: false },
    ...over,
  }
}

function click(over: Partial<HardNavigationInput['click']> = {}) {
  return { ...input().click, ...over }
}

function anchor(over: Partial<HardNavigationInput['anchor']> = {}) {
  return { ...input().anchor, ...over }
}

describe('shouldHardNavigate', () => {
  it('hands a plain click on an in-app link to the browser when a newer build is live', () => {
    expect(shouldHardNavigate(input())).toBe(true)
    expect(shouldHardNavigate(input({ anchor: anchor({ href: 'https://app.example.test/invoices/1' }) }))).toBe(true)
    expect(shouldHardNavigate(input({ anchor: anchor({ target: '_self' }) }))).toBe(true)
  })

  it('counts a change of query on the same path as a page change', () => {
    expect(shouldHardNavigate(input({ anchor: anchor({ href: '/transactions' }) }))).toBe(true)
  })

  it('does nothing while the tab is not known to be behind', () => {
    expect(shouldHardNavigate(input({ liveBuildId: null }))).toBe(false)
    expect(shouldHardNavigate(input({ liveBuildId: OLD }))).toBe(false)
  })

  it('does nothing in a build without an id (dev, self-hosted)', () => {
    expect(shouldHardNavigate(input({ currentBuildId: '' }))).toBe(false)
    expect(shouldHardNavigate(input({ currentBuildId: '', liveBuildId: '' }))).toBe(false)
  })

  it('acts on a failed Server Action too, where the live id is unknown', () => {
    expect(shouldHardNavigate(input({ liveBuildId: '' }))).toBe(true)
  })

  it('tries once per build pair: a rollout that answers with the old build again does not loop', () => {
    const attempted = deployNavigationAttemptKey(OLD, NEW)
    expect(shouldHardNavigate(input({ attempted }))).toBe(false)
    // A later deploy is a new pair and gets its own try.
    expect(shouldHardNavigate(input({ attempted, liveBuildId: 'cccc333' }))).toBe(true)
  })

  it('stays soft when the attempt cannot be remembered', () => {
    expect(shouldHardNavigate(input({ attempted: STORAGE_UNAVAILABLE }))).toBe(false)
  })

  it('stays soft while unsaved work is registered', () => {
    expect(shouldHardNavigate(input({ held: true }))).toBe(false)
  })

  it('stays out of an embedded frame', () => {
    expect(shouldHardNavigate(input({ isTopWindow: false }))).toBe(false)
  })

  it('leaves modified, non-primary and already cancelled clicks alone', () => {
    for (const over of [
      { metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true },
      { button: 1 }, { defaultPrevented: true },
    ]) {
      expect(shouldHardNavigate(input({ click: click(over) }))).toBe(false)
    }
  })

  it('leaves new-tab, download and href-less anchors alone', () => {
    expect(shouldHardNavigate(input({ anchor: anchor({ target: '_blank' }) }))).toBe(false)
    expect(shouldHardNavigate(input({ anchor: anchor({ download: true }) }))).toBe(false)
    expect(shouldHardNavigate(input({ anchor: anchor({ href: null }) }))).toBe(false)
    expect(shouldHardNavigate(input({ anchor: anchor({ href: '' }) }))).toBe(false)
  })

  it('only acts on same-origin pages', () => {
    for (const href of [
      'https://example.org/invoices',
      '//example.org/invoices',
      'mailto:someone@example.test',
      'tel:+4600000000',
      'javascript:void(0)',
      'http://[bad',
    ]) {
      expect(shouldHardNavigate(input({ anchor: anchor({ href }) }))).toBe(false)
    }
  })

  it('leaves the current page alone: hash jumps and the link to the page already showing', () => {
    expect(shouldHardNavigate(input({ anchor: anchor({ href: '#rows' }) }))).toBe(false)
    expect(shouldHardNavigate(input({ anchor: anchor({ href: '/transactions?view=all' }) }))).toBe(false)
    expect(shouldHardNavigate(input({ anchor: anchor({ href: '/transactions?view=all#top' }) }))).toBe(false)
  })

  it('leaves route handlers (files, redirects) to the browser', () => {
    expect(shouldHardNavigate(input({ anchor: anchor({ href: '/api/documents/1/download' }) }))).toBe(false)
    expect(shouldHardNavigate(input({ anchor: anchor({ href: '/apidocs' }) }))).toBe(true)
  })
})

describe('reloadCardDelayMs', () => {
  it('waits when the tab will update itself on the next page change', () => {
    expect(reloadCardDelayMs({ currentBuildId: OLD, liveBuildId: NEW, attempted: null })).toBe(RELOAD_CARD_DELAY_MS)
  })

  it('shows the card at once when it is the only way forward', () => {
    expect(reloadCardDelayMs({ currentBuildId: '', liveBuildId: '', attempted: null })).toBe(0)
    expect(reloadCardDelayMs({ currentBuildId: OLD, liveBuildId: '', attempted: null })).toBe(0)
    expect(reloadCardDelayMs({ currentBuildId: OLD, liveBuildId: NEW, attempted: STORAGE_UNAVAILABLE })).toBe(0)
    expect(reloadCardDelayMs({
      currentBuildId: OLD, liveBuildId: NEW, attempted: deployNavigationAttemptKey(OLD, NEW),
    })).toBe(0)
  })
})

describe('soft navigation holds', () => {
  it('is held until every holder has released, and a double release counts once', () => {
    expect(softNavigationHeld()).toBe(false)
    const a = holdSoftNavigation()
    const b = holdSoftNavigation()
    a()
    a()
    expect(softNavigationHeld()).toBe(true)
    b()
    expect(softNavigationHeld()).toBe(false)
  })
})

function memoryStorage() {
  const data = new Map<string, string>()
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) },
  }
}

const throwingStorage = {
  getItem: () => { throw new Error('blocked') },
  setItem: () => { throw new Error('blocked') },
}

describe('attempt memory', () => {
  it('round-trips through sessionStorage', () => {
    const storage = memoryStorage()
    expect(readDeployNavigationAttempt(storage)).toBeNull()
    rememberDeployNavigationAttempt(storage, 'a>b')
    expect(storage.getItem(DEPLOY_NAVIGATION_ATTEMPT_KEY)).toBe('a>b')
    expect(readDeployNavigationAttempt(storage)).toBe('a>b')
  })

  it('never throws on blocked storage and reports it as unavailable', () => {
    expect(readDeployNavigationAttempt(throwingStorage)).toBe(STORAGE_UNAVAILABLE)
    expect(() => rememberDeployNavigationAttempt(throwingStorage, 'a>b')).not.toThrow()
    const win = { get sessionStorage(): Storage { throw new Error('denied') } }
    expect(attemptedIn(win)).toBe(STORAGE_UNAVAILABLE)
  })
})

function fakeAnchor(attrs: Record<string, string>) {
  const map = new Map(Object.entries(attrs))
  return {
    getAttribute: (name: string) => map.get(name) ?? null,
    hasAttribute: (name: string) => map.has(name),
    setAttribute: (name: string, value: string) => { map.set(name, value) },
    removeAttribute: (name: string) => { map.delete(name) },
  }
}

function fakeWindow() {
  const timers: Array<() => void> = []
  const win = {
    location: { href: 'https://app.example.test/transactions' },
    top: null as unknown,
    sessionStorage: memoryStorage(),
    setTimeout: (handler: () => void) => { timers.push(handler); return timers.length },
  }
  win.top = win
  return { win, runTimers: () => timers.splice(0).forEach((run) => run()) }
}

function clickOn(link: ReturnType<typeof fakeAnchor> | null) {
  return { ...click(), target: { closest: vi.fn(() => link) } }
}

const build = { currentBuildId: OLD, liveBuildId: NEW }

describe('handleDeployNavigationClick', () => {
  it('marks the anchor for the browser during the click, then restores it and remembers the attempt', () => {
    const { win, runTimers } = fakeWindow()
    const link = fakeAnchor({ href: '/invoices' })
    expect(handleDeployNavigationClick(clickOn(link), win, build)).toBe(true)
    expect(link.getAttribute('target')).toBe('_top')
    runTimers()
    expect(link.hasAttribute('target')).toBe(false)
    expect(readDeployNavigationAttempt(win.sessionStorage)).toBe(deployNavigationAttemptKey(OLD, NEW))
    // Second click in the same tab for the same pair: left alone.
    expect(handleDeployNavigationClick(clickOn(link), win, build)).toBe(false)
    expect(link.hasAttribute('target')).toBe(false)
  })

  it('does not count an attempt when a handler cancelled the click', () => {
    const { win, runTimers } = fakeWindow()
    const link = fakeAnchor({ href: '/invoices', target: '_self' })
    const event = clickOn(link)
    expect(handleDeployNavigationClick(event, win, build)).toBe(true)
    event.defaultPrevented = true
    runTimers()
    expect(link.getAttribute('target')).toBe('_self')
    expect(readDeployNavigationAttempt(win.sessionStorage)).toBeNull()
  })

  it('ignores clicks outside links and links it should not touch', () => {
    const { win } = fakeWindow()
    expect(handleDeployNavigationClick(clickOn(null), win, build)).toBe(false)
    expect(handleDeployNavigationClick({ ...click(), target: null }, win, build)).toBe(false)
    const external = fakeAnchor({ href: 'https://example.org/' })
    expect(handleDeployNavigationClick(clickOn(external), win, build)).toBe(false)
    expect(external.hasAttribute('target')).toBe(false)
  })
})

describe('the next/link behaviour the hand-over relies on', () => {
  // deploy-navigation.ts marks the anchor target="_top" so next/link leaves
  // the click to the browser. If Next stops reading `target` there, links
  // soft-navigate as before (safe), but the feature is silently off: this
  // test says so on the upgrade instead.
  it('still leaves a click on an anchor with a non-_self target to the browser', () => {
    const source = readFileSync(
      path.resolve(process.cwd(), 'node_modules/next/dist/client/app-dir/link.js'),
      'utf8',
    )
    expect(source).toContain("getAttribute('target')")
    expect(source).toMatch(/target && target !== '_self'/)
    expect(source).toMatch(/isAnchorNodeName && isModifiedEvent\(e\)/)
  })
})
