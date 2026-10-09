import type { MouseEvent, MouseEventHandler } from 'react'

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

/**
 * Click handler for every account drill-down in the report components: opens
 * the account, unless the click ends a text selection inside the clicked row
 * or cell (crm#1123: the Balansrapport drilled in anyway). A test pins that
 * every onClick under src/components/reports whose handler names
 * onNavigateToAccount goes through here.
 */
export function accountDrilldownClick(
  onNavigateToAccount: (account: string) => void,
  account: string,
): MouseEventHandler {
  return (e) => {
    if (endsTextSelection(e)) return
    onNavigateToAccount(account)
  }
}
