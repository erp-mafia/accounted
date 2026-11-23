/**
 * Favoriter: the menu rows a person pins, shown as a group at the top of
 * every area's sidebar so the page is one click away from anywhere.
 *
 * Stored per person in user_preferences.ui_state.nav_favorites as the rows'
 * hrefs, in the order they were added. The stored list is never the menu: a
 * favourite is drawn only when its href is a row the menu shows right now
 * (the row passed the same gates as everywhere else, lib/navigation/
 * nav-gates.ts), with that row's own icon and label. A favourite the open
 * company's menu does not show, or whose page no longer exists, is left out
 * and stays stored, so it is back in a company that has the page.
 */

/** How many favourites a person can store. The ui-state route refuses a longer list. */
export const NAV_FAVORITES_CAP = 12

/**
 * The stored list as it was saved, read defensively out of the jsonb bag:
 * anything that is not a route path is dropped, and so is a repeat.
 */
export function storedFavorites(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const hrefs: string[] = []
  for (const entry of value) {
    if (typeof entry === 'string' && entry.startsWith('/') && !hrefs.includes(entry)) hrefs.push(entry)
  }
  return hrefs
}

/**
 * The favourites to draw: the stored hrefs that are rows of the menu as it is
 * shown right now, in the order they were added, each as its own menu row. A
 * gated or unknown href is skipped and a repeated one is drawn once.
 */
export function resolveFavorites<Row extends { href: string }>(
  stored: readonly string[],
  visibleRows: readonly Row[],
): Row[] {
  const byHref = new Map<string, Row>()
  for (const row of visibleRows) {
    if (!byHref.has(row.href)) byHref.set(row.href, row)
  }
  const rows: Row[] = []
  for (const href of new Set(stored)) {
    const row = byHref.get(href)
    if (row) rows.push(row)
  }
  return rows
}

/**
 * The list to store after a row's star is pressed: without the href when it
 * was a favourite, with it added last when it was not. Every other entry is
 * kept, also the ones the open company's menu does not show. Null when the
 * list is full: nothing is added and nothing is stored.
 */
export function toggleFavorite(
  stored: readonly string[],
  href: string,
  cap: number = NAV_FAVORITES_CAP,
): string[] | null {
  const kept = [...new Set(stored)]
  if (kept.includes(href)) return kept.filter((entry) => entry !== href)
  return kept.length >= cap ? null : [...kept, href]
}
