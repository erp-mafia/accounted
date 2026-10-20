/**
 * Column templates for KonteringLinesEditor.
 *
 * The column heads, every line, the sum and the rows a line generates are
 * separate CSS grids that share one template string. They line up only while
 * every track resolves without looking at a row's content: fixed widths and
 * `minmax(0,1fr)`. A content-sized (`auto`) track is resolved per grid, so a
 * line showing more icon buttons than the heads (which show none) gets a
 * wider last column, and the two flexible columns and the amounts shift away
 * from their heads (crm#1309).
 *
 * The last column is counted in icon-sm buttons, `--kontering-icon` wide
 * (32px, 40px on a touch screen, as `components/ui/button.tsx` sizes them;
 * KONTERING_ICON_WIDTH_CLASS sets it on the editor): remove alone, or the
 * caller's row actions, at most two, plus remove.
 */

/** The most row actions a caller may render before the remove button. */
export const KONTERING_MAX_ROW_ACTIONS = 2

/** Sets the icon-sm button width the last column is counted in. */
export const KONTERING_ICON_WIDTH_CLASS = '[--kontering-icon:32px] pointer-coarse:[--kontering-icon:40px]'

// Literal class names: Tailwind only generates the classes it finds in source.
// The `*3` is KONTERING_MAX_ROW_ACTIONS plus the remove button.
export const KONTERING_GRID_COLUMNS = {
  plain: 'sm:grid-cols-[minmax(0,1fr)_120px_120px_var(--kontering-icon)]',
  plainActions: 'sm:grid-cols-[minmax(0,1fr)_120px_120px_calc(var(--kontering-icon)*3)]',
  plainExtra: 'sm:grid-cols-[minmax(0,1fr)_120px_120px_112px_var(--kontering-icon)]',
  plainExtraActions: 'sm:grid-cols-[minmax(0,1fr)_120px_120px_112px_calc(var(--kontering-icon)*3)]',
  described: 'sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_120px_120px_var(--kontering-icon)]',
  describedActions: 'sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_120px_120px_calc(var(--kontering-icon)*3)]',
  describedExtra: 'sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_120px_120px_112px_var(--kontering-icon)]',
  describedExtraActions:
    'sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_120px_120px_112px_calc(var(--kontering-icon)*3)]',
} as const

export type KonteringGridVariant = keyof typeof KONTERING_GRID_COLUMNS

/** The `sm:` column template for an editor with these columns. */
export function konteringGridColumns(described: boolean, extra: boolean, actions: boolean): string {
  const key = `${described ? 'described' : 'plain'}${extra ? 'Extra' : ''}${actions ? 'Actions' : ''}`
  return KONTERING_GRID_COLUMNS[key as KonteringGridVariant]
}
