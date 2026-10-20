import type { MouseEvent, MouseEventHandler } from 'react'

/**
 * How a report opens the huvudbok for one of its accounts. `href` is the URL
 * (lib/reports/report-drilldown.ts), so every drill-down row can carry a real
 * link; `navigate` is the client-side route change for a plain row click.
 */
export interface AccountDrilldown {
  href: (account: string) => string
  navigate: (href: string) => void
}

/**
 * True when `e` is the click that ends a text selection where it landed.
 * Dragging across an amount to copy it fires a click on mouseup; that click
 * must leave the user on the report with the text selected instead of
 * drilling into the account. A plain click collapses any earlier selection on
 * mousedown, so it still navigates.
 *
 * The selection is checked against the clicked row or cell and against the
 * click's target: React hands the row clicks from portalled children, such as
 * the AccountNumber tooltip in every drill-down row, whose text sits outside
 * the row in the DOM.
 */
function endsTextSelection(e: MouseEvent): boolean {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.toString().trim() === '') return false
  return selection.containsNode(e.currentTarget, true) || selection.containsNode(e.target as Node, true)
}

/** True when the click landed on a link, which handles it the browser's way. */
function landsOnLink(e: MouseEvent): boolean {
  const target = e.target as Partial<Element> | null
  return typeof target?.closest === 'function' && target.closest('a[href]') !== null
}

/**
 * Click handler for every account drill-down in the report components: opens
 * the account, unless the click ends a text selection inside the clicked row
 * or cell (crm#1123: the Balansrapport drilled in anyway). A click on the
 * row's own link is left to the link, and a ctrl-, cmd- or shift-click
 * elsewhere on the row opens the account in a new tab, as it would on the
 * link (crm#1279: a report beside its huvudbok while reconciling). A test
 * pins that every onClick under src/components/reports that drills into an
 * account goes through here.
 */
export function accountDrilldownClick(drilldown: AccountDrilldown, account: string): MouseEventHandler {
  return (e) => {
    if (landsOnLink(e) || endsTextSelection(e)) return
    const href = drilldown.href(account)
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      window.open(href, '_blank', 'noopener')
      return
    }
    drilldown.navigate(href)
  }
}
