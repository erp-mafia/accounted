'use client'

import * as React from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { EllipsisHorizontalIcon } from '@/components/icons'
import { pickFolded } from '@/components/ui/page-header-fold'

/** The same edge as the phone rules for .page-header in globals.css. */
const PHONE_QUERY = '(max-width: 767.98px)'
const CONTROL_SELECTOR = 'button, a[href], [role="button"]'
const FOLDED_ATTR = 'data-topbar-folded'
const COMPACT_ATTR = 'data-topbar-compact'
/** On what sits beside the title (a status, a facts line) once it has no room. */
const GONE_ATTR = 'data-topbar-gone'
/** On the slot once it has measured itself; until then CSS keeps a phone's bar to the primary. */
const READY_ATTR = 'data-topbar-ready'
/** Below this the title says nothing, and the primary gives up its label. */
const MIN_TITLE_WIDTH = 40

interface FoldedAction {
  key: string
  label: string
  title?: string
  disabled: boolean
  destructive: boolean
  /** The control's own symbol, shown again on its row in the menu. */
  icon: Element | null
  el: HTMLElement
}

const FoldedActionsContext = React.createContext<FoldedAction[]>([])

function labelOf(el: HTMLElement): string {
  return (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim()
}

function isDisabled(el: HTMLElement): boolean {
  return (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true'
}

/** A control with its own floating layer (a menu, a popover). */
function opensLayer(el: HTMLElement): boolean {
  return el.hasAttribute('aria-haspopup')
}

/**
 * Controls that keep their place in the bar: a picker shows its value there,
 * a "more" menu of the page's own (icon only) is already what folding makes,
 * and a split button's caret belongs to its primary (data-topbar-keep).
 */
function staysInBar(el: HTMLElement): boolean {
  if (el.hasAttribute('data-topbar-keep') || el.hasAttribute('data-topbar-overflow-host')) return true
  if (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-haspopup') === 'listbox') return true
  return opensLayer(el) && !(el.textContent ?? '').trim()
}

/** Presses the real control. A Radix menu trigger opens on pointer down, not
 *  on click. */
function press(el: HTMLElement) {
  if (el.getAttribute('aria-haspopup') === 'menu' && el.hasAttribute('data-state')) {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }))
  } else {
    el.click()
  }
}

/**
 * The symbol a control shows. A Button always carries its spinner, hidden
 * until it loads, and an icon is a sized box around its svg: so the first svg
 * that is on screen, with the box that sizes it.
 */
function iconOf(el: HTMLElement): Element | null {
  const svg = Array.from(el.querySelectorAll('svg')).find((node) => node.getClientRects().length > 0)
  if (!svg) return null
  const box = svg.parentElement
  return box && box !== el && box.childElementCount === 1 && !(box.textContent ?? '').trim() ? box : svg
}

function clearMarks(scope: HTMLElement, attr: string) {
  scope.querySelectorAll(`[${attr}]`).forEach((el) => el.removeAttribute(attr))
}

function isCut(el: Element): boolean {
  return el.scrollWidth > el.clientWidth + 1
}

/** The filled button look of components/ui/button.tsx (variant default). */
function isFilled(el: HTMLElement): boolean {
  return el.className.includes('bg-primary')
}

function sameActions(a: FoldedAction[], b: FoldedAction[]): boolean {
  return (
    a.length === b.length &&
    a.every((x, i) => x.el === b[i].el && x.label === b[i].label && x.disabled === b[i].disabled && x.title === b[i].title)
  )
}

/**
 * Decides, from the rendered bar, which actions leave it on a phone. Runs
 * before paint: the marks are cleared, the bar is measured as it would be
 * with every action in it, and only a bar that does not fit folds.
 */
function foldBar(root: HTMLElement): { folded: FoldedAction[]; hosted: boolean } {
  const header = root.closest<HTMLElement>('.page-header')
  clearMarks(root, FOLDED_ATTR)
  clearMarks(root, COMPACT_ATTR)
  if (header) clearMarks(header, GONE_ATTR)
  // From here the slot answers for the bar; the CSS that held a phone's bar
  // to its primary before this first measure lets go.
  root.setAttribute(READY_ATTR, '')
  const none = { folded: [], hosted: false }
  if (!header || !window.matchMedia(PHONE_QUERY).matches) return none
  const controls = Array.from(root.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)).filter(
    (el) => !el.hasAttribute('data-topbar-more') && el.getClientRects().length > 0,
  )
  // Measured without the bar's own "more" button. A bar fits when nothing
  // spills and neither the title nor what sits beside it (a status) is cut;
  // the facts line may truncate without folding anything.
  root.setAttribute('data-topbar-measuring', '')
  const title = header.querySelector<HTMLElement>('.page-header-title')
  const beside = Array.from(title?.parentElement?.children ?? []).filter(
    (el) => !el.classList.contains('page-header-meta') && !el.classList.contains('page-header-desc'),
  )
  const fits = header.scrollWidth <= header.clientWidth + 1 && !beside.some(isCut)
  root.removeAttribute('data-topbar-measuring')

  const foldedIndexes = fits
    ? []
    : pickFolded(controls.map((el) => ({ filled: isFilled(el), stays: staysInBar(el) })))
  const foldedSet = new Set(foldedIndexes.map((i) => controls[i]))

  const folded: FoldedAction[] = foldedIndexes.map((i) => {
    const el = controls[i]
    return {
      key: `${i}:${labelOf(el)}`,
      label: labelOf(el),
      title: el.getAttribute('title') ?? undefined,
      disabled: isDisabled(el),
      destructive: el.className.includes('text-destructive'),
      icon: iconOf(el),
      el,
    }
  })

  for (const el of foldedSet) {
    // A folded menu button stays laid out, unseen, at the bar's end: its
    // menu opens from where the "more" button is.
    if (opensLayer(el)) {
      el.setAttribute(FOLDED_ATTR, 'anchor')
      continue
    }
    // A wrapper left with nothing to show (a pager's two arrows) leaves with
    // its controls, so it takes no gap in the bar.
    let node = el
    while (node.parentElement && node.parentElement !== root) {
      const parent = node.parentElement
      const inside = controls.filter((c) => parent.contains(c))
      if (!inside.every((c) => foldedSet.has(c) && !opensLayer(c))) break
      node = parent
    }
    node.setAttribute(FOLDED_ATTR, '')
  }

  // A status or a facts line is never shown cut: what still has no room
  // after the fold leaves the bar whole, the facts line first, then what
  // follows the title from the end. The page shows it under the bar.
  const givesWay = [
    ...Array.from(header.querySelectorAll('.page-header-meta')),
    ...beside
      .filter(
        (el) =>
          title &&
          el !== title &&
          !!(title.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) &&
          // Text and badges only: never the help button, never the actions.
          !el.matches(CONTROL_SELECTOR) &&
          !el.querySelector(CONTROL_SELECTOR) &&
          !el.contains(root),
      )
      .reverse(),
  ]
  for (const el of givesWay) {
    const cut = givesWay.some((other) => !other.hasAttribute(GONE_ATTR) && other.getClientRects().length > 0 && isCut(other))
    if (!cut && !(title && isCut(title))) break
    if (el.getClientRects().length > 0) el.setAttribute(GONE_ATTR, '')
  }

  // Still no room for the title beside a long primary: a primary with a
  // symbol shows only that. Its label stays in the markup as its name. The
  // symbol must be on screen: every Button carries a hidden spinner, and a
  // primary compacted on that showed an empty box.
  if (title && title.clientWidth < Math.min(MIN_TITLE_WIDTH, title.scrollWidth)) {
    const primary = controls.find((el) => !foldedSet.has(el) && !staysInBar(el) && isFilled(el))
    if (primary && iconOf(primary)) primary.setAttribute(COMPACT_ATTR, '')
  }

  const host = root.querySelector<HTMLElement>('[data-topbar-overflow-host]')
  return { folded, hosted: !!host && host.getClientRects().length > 0 }
}

function FoldedItems({ items }: { items: FoldedAction[] }) {
  return (
    <>
      {items.map((item) => (
        <DropdownMenuItem
          key={item.key}
          disabled={item.disabled}
          title={item.title}
          className={item.destructive ? 'text-destructive' : undefined}
          // After the menu has closed and handed focus back, so a dialog the
          // action opens takes focus last.
          onSelect={() => window.setTimeout(() => press(item.el), 0)}
        >
          {item.icon && (
            // The menu's one symbol size, whatever size the button drew it at.
            <span
              aria-hidden="true"
              className="flex h-4 w-4 shrink-0 items-center justify-center [&_svg]:h-4 [&_svg]:w-4 [&>*]:h-4 [&>*]:w-4"
              ref={(node) => {
                if (node && item.icon) node.replaceChildren(item.icon.cloneNode(true))
              }}
            />
          )}
          <span className="whitespace-nowrap">{item.label}</span>
        </DropdownMenuItem>
      ))}
    </>
  )
}

/**
 * The folded top bar actions as rows of a page's own "more" menu. A page
 * whose top bar already has such a menu renders this first inside its
 * DropdownMenuContent and marks the menu's trigger with
 * `data-topbar-overflow-host`, so a phone gets one "more" button, not two.
 * Renders nothing on a wide screen or while every action fits.
 */
export function PageHeaderOverflowItems() {
  const items = React.useContext(FoldedActionsContext)
  if (items.length === 0) return null
  return (
    <>
      <FoldedItems items={items} />
      <DropdownMenuSeparator />
    </>
  )
}

/**
 * The top bar's action slot. On a phone the bar is one row: the title, the
 * page's one primary action and a "more" button. When the actions do not fit
 * beside the title, every action but the primary (the filled button) leaves
 * the bar and is listed under "more"; choosing a row there presses the real
 * button, so a page keeps its actions, dialogs and file pickers exactly as
 * written. Pickers and a page's own "more" menu stay in the bar. From md up
 * nothing here applies.
 *
 * PageHeader uses it for its `action`; a hand-rolled header (the page-header*
 * class hooks) uses it in place of its action div, with that div's classes.
 */
export function PageHeaderActions({ className, children }: { className?: string; children: React.ReactNode }) {
  const t = useTranslations('common')
  const rootRef = React.useRef<HTMLDivElement>(null)
  const [state, setState] = React.useState<{ folded: FoldedAction[]; hosted: boolean }>({ folded: [], hosted: false })

  React.useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const run = () => {
      const next = foldBar(root)
      setState((prev) => (prev.hosted === next.hosted && sameActions(prev.folded, next.folded) ? prev : next))
    }
    run()

    // Our own fold mark is not in the filter, so marking never re-triggers.
    const mutations = new MutationObserver(run)
    mutations.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'disabled', 'aria-disabled', 'hidden', 'title', 'aria-label'],
    })
    const header = root.closest<HTMLElement>('.page-header')
    const sizes = new ResizeObserver(run)
    if (header) {
      sizes.observe(header)
      // The title side changing (a status badge, a loaded name) moves the fit.
      const lead = header.firstElementChild
      if (lead && lead !== root) mutations.observe(lead, { childList: true, subtree: true, characterData: true })
    }
    const media = window.matchMedia(PHONE_QUERY)
    media.addEventListener('change', run)
    // The text face arriving changes every width without a mutation.
    let mounted = true
    void document.fonts?.ready.then(() => {
      if (mounted) run()
    })
    return () => {
      mounted = false
      mutations.disconnect()
      sizes.disconnect()
      media.removeEventListener('change', run)
      clearMarks(root, FOLDED_ATTR)
      clearMarks(root, COMPACT_ATTR)
      if (header) clearMarks(header, GONE_ATTR)
    }
  }, [])

  const showMore = state.folded.length > 0 && !state.hosted

  return (
    <FoldedActionsContext.Provider value={state.folded}>
      <div ref={rootRef} data-topbar-actions="" className={className}>
        {children}
        {showMore && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button data-topbar-more="" variant="ghost" size="icon-toolbar" aria-label={t('more_options')}>
                <EllipsisHorizontalIcon className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <FoldedItems items={state.folded} />
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </FoldedActionsContext.Provider>
  )
}
