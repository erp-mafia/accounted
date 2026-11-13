/**
 * How the floating assistant button (AgentTrigger) and the page share the
 * bottom right corner on desktop. Two markers, both read by CSS alone
 * (`body:has(...)`), so nothing is set or cleaned up from an effect and the
 * state can never go stale:
 *
 *   data-agent-fab         on the button itself, while it is rendered.
 *   data-page-bottom-bar   on a bar pinned to the bottom of the page whose
 *                          right end carries an action.
 *
 * The button is 3rem tall and sits 1rem above the viewport bottom, so it
 * occupies the lowest 4rem of the corner. A scroll container that reaches the
 * corner adds AGENT_FAB_CLEARANCE_CLASS: its last row then scrolls clear of
 * the button instead of ending underneath it (crm#1841: a right-aligned
 * footer link under a list was not clickable). A page bottom bar spreads
 * PAGE_BOTTOM_BAR_PROPS: the button lifts above the bar (bottom-20 in
 * AgentTrigger) and the clearance grows by the same step, so the end of the
 * page still clears the lifted button.
 *
 * Desktop only: on a phone a fresh button is not shown at all.
 */
export const AGENT_FAB_PROPS = { 'data-agent-fab': '' } as const

export const PAGE_BOTTOM_BAR_PROPS = { 'data-page-bottom-bar': '' } as const

export const AGENT_FAB_CLEARANCE_CLASS =
  'md:[body:has([data-agent-fab])_&]:pb-20 md:[body:has([data-agent-fab]):has([data-page-bottom-bar])_&]:pb-36'
