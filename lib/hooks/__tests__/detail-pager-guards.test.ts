import { describe, it, expect } from 'vitest'
import {
  isEditableTarget,
  isOverlayBlocking,
  resolveArrowKeyAction,
  type ArrowKeyEventLike,
  type OverlayProbeDocument,
} from '@/lib/hooks/detail-pager-guards'

/**
 * Minimal fake DOM for the node test environment: elements are attribute
 * bags with an optional parent, and the matcher supports exactly the two
 * selector shapes the guard uses: compound attribute selectors
 * ([role="dialog"][data-state="open"]) and one-level descendant chains
 * ([data-radix-popper-content-wrapper] [data-state="open"]), comma-separated.
 */
interface FakeEl {
  attrs: Record<string, string>
  parent?: FakeEl
}

function matchesCompound(el: FakeEl, compound: string): boolean {
  const attrRe = /\[([a-zA-Z-]+)(?:="([^"]*)")?\]/g
  let m: RegExpExecArray | null
  let sawAny = false
  while ((m = attrRe.exec(compound))) {
    sawAny = true
    const [, name, value] = m
    if (!(name in el.attrs)) return false
    if (value !== undefined && el.attrs[name] !== value) return false
  }
  return sawAny
}

function matchesSelector(el: FakeEl, selector: string): boolean {
  const parts = selector.trim().split(/\s+/)
  if (!matchesCompound(el, parts[parts.length - 1])) return false
  let ancestor = el.parent
  for (let i = parts.length - 2; i >= 0; i--) {
    let match: FakeEl | undefined
    while (ancestor) {
      if (matchesCompound(ancestor, parts[i])) {
        match = ancestor
        break
      }
      ancestor = ancestor.parent
    }
    if (!match) return false
    ancestor = match.parent
  }
  return true
}

function matchesAny(el: FakeEl, selectors: string): boolean {
  return selectors.split(',').some((s) => matchesSelector(el, s))
}

function makeDoc(elements: FakeEl[], activeElement: FakeEl | null = null): OverlayProbeDocument {
  return {
    querySelector: (selectors: string) =>
      elements.find((el) => matchesAny(el, selectors)) ?? null,
    activeElement: activeElement
      ? {
          closest: (selectors: string) => {
            let node: FakeEl | undefined = activeElement
            while (node) {
              if (matchesAny(node, selectors)) return node
              node = node.parent
            }
            return null
          },
        }
      : null,
  }
}

function arrowEvent(overrides: Partial<ArrowKeyEventLike> = {}): ArrowKeyEventLike {
  return {
    key: 'ArrowRight',
    defaultPrevented: false,
    isComposing: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    target: { tagName: 'BODY' },
    ...overrides,
  }
}

const emptyDoc = () => makeDoc([])

describe('isOverlayBlocking', () => {
  it('does not block on an empty page', () => {
    expect(isOverlayBlocking(emptyDoc())).toBe(false)
  })

  it('does NOT block on a mounted-but-closed dialog (agent sheet hidden with display:none)', () => {
    // AgentSheet renders role="dialog" and stays in the DOM once opened; a
    // bare [role="dialog"] query would block paging forever.
    const hiddenSheet: FakeEl = { attrs: { role: 'dialog' } }
    expect(isOverlayBlocking(makeDoc([hiddenSheet]))).toBe(false)
  })

  it('blocks on an open dialog', () => {
    const openDialog: FakeEl = { attrs: { role: 'dialog', 'data-state': 'open' } }
    expect(isOverlayBlocking(makeDoc([openDialog]))).toBe(true)
  })

  it('blocks on an open alertdialog', () => {
    const el: FakeEl = { attrs: { role: 'alertdialog', 'data-state': 'open' } }
    expect(isOverlayBlocking(makeDoc([el]))).toBe(true)
  })

  it('blocks on an open radix dropdown menu (no dialog role)', () => {
    const menuContent: FakeEl = {
      attrs: { 'data-radix-menu-content': '', 'data-state': 'open' },
    }
    expect(isOverlayBlocking(makeDoc([menuContent]))).toBe(true)
  })

  it('blocks on open popper content (select/menu inside the popper wrapper)', () => {
    const wrapper: FakeEl = { attrs: { 'data-radix-popper-content-wrapper': '' } }
    const content: FakeEl = { attrs: { 'data-state': 'open' }, parent: wrapper }
    expect(isOverlayBlocking(makeDoc([content]))).toBe(true)
  })

  it('does not block on a closed, force-mounted popper', () => {
    const wrapper: FakeEl = { attrs: { 'data-radix-popper-content-wrapper': '' } }
    const content: FakeEl = { attrs: { 'data-state': 'closed' }, parent: wrapper }
    expect(isOverlayBlocking(makeDoc([content]))).toBe(false)
  })

  it('blocks while focus sits inside a dialog/menu/listbox container', () => {
    for (const role of ['dialog', 'menu', 'listbox']) {
      const container: FakeEl = { attrs: { role } }
      const focused: FakeEl = { attrs: { tabindex: '0' }, parent: container }
      expect(isOverlayBlocking(makeDoc([], focused))).toBe(true)
    }
  })

  it('does not block while focus sits in the plain page', () => {
    const focused: FakeEl = { attrs: { tabindex: '0' } }
    expect(isOverlayBlocking(makeDoc([], focused))).toBe(false)
  })
})

describe('isEditableTarget', () => {
  it('claims text fields, selects and contentEditable', () => {
    expect(isEditableTarget({ tagName: 'INPUT' })).toBe(true)
    expect(isEditableTarget({ tagName: 'TEXTAREA' })).toBe(true)
    expect(isEditableTarget({ tagName: 'SELECT' })).toBe(true)
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true)
  })

  it('passes on everything else', () => {
    expect(isEditableTarget({ tagName: 'BODY' })).toBe(false)
    expect(isEditableTarget({ tagName: 'BUTTON' })).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
    expect(isEditableTarget(undefined)).toBe(false)
  })
})

describe('resolveArrowKeyAction', () => {
  it('maps plain arrows to paging actions', () => {
    expect(resolveArrowKeyAction(arrowEvent({ key: 'ArrowLeft' }), emptyDoc())).toBe('prev')
    expect(resolveArrowKeyAction(arrowEvent({ key: 'ArrowRight' }), emptyDoc())).toBe('next')
  })

  it('ignores other keys', () => {
    expect(resolveArrowKeyAction(arrowEvent({ key: 'ArrowUp' }), emptyDoc())).toBeNull()
    expect(resolveArrowKeyAction(arrowEvent({ key: 'a' }), emptyDoc())).toBeNull()
  })

  it('ignores handled or composing events', () => {
    expect(resolveArrowKeyAction(arrowEvent({ defaultPrevented: true }), emptyDoc())).toBeNull()
    expect(resolveArrowKeyAction(arrowEvent({ isComposing: true }), emptyDoc())).toBeNull()
  })

  it('ignores modified arrows (browser/OS shortcuts)', () => {
    expect(resolveArrowKeyAction(arrowEvent({ metaKey: true }), emptyDoc())).toBeNull()
    expect(resolveArrowKeyAction(arrowEvent({ ctrlKey: true }), emptyDoc())).toBeNull()
    expect(resolveArrowKeyAction(arrowEvent({ altKey: true }), emptyDoc())).toBeNull()
    expect(resolveArrowKeyAction(arrowEvent({ shiftKey: true }), emptyDoc())).toBeNull()
  })

  it('never steals arrows from a focused text field', () => {
    const e = arrowEvent({ target: { tagName: 'TEXTAREA' } })
    expect(resolveArrowKeyAction(e, emptyDoc())).toBeNull()
  })

  it('yields to an open dropdown menu but not to a hidden mounted dialog', () => {
    const openMenu = makeDoc([{ attrs: { 'data-radix-menu-content': '', 'data-state': 'open' } }])
    expect(resolveArrowKeyAction(arrowEvent(), openMenu)).toBeNull()

    const hiddenSheet = makeDoc([{ attrs: { role: 'dialog' } }])
    expect(resolveArrowKeyAction(arrowEvent(), hiddenSheet)).toBe('next')
  })
})
