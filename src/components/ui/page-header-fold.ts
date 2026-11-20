/** One control in a top bar's action slot, as the fold rule sees it. */
export interface TopBarControl {
  /** The filled button: the page's primary action. */
  filled: boolean
  /** Opens its own menu or list, so it keeps its place in the bar. */
  stays: boolean
}

/**
 * Which top bar actions leave the bar on a phone when the row does not fit.
 * Only the primary (the last filled button) stays as a button. A bar with no
 * primary keeps its action when that is all the bar holds (a "more" menu of
 * one row says less than the button did) and none otherwise. Controls that
 * keep their place (pickers, the page's own "more" menu) stay as well.
 * Everything else folds into "more". Returns the folded controls' indexes,
 * in bar order.
 */
export function pickFolded(controls: TopBarControl[]): number[] {
  const foldable = controls.map((c, i) => ({ c, i })).filter(({ c }) => !c.stays)
  const filled = foldable.filter(({ c }) => c.filled)
  if (filled.length === 0 && controls.length === 1) return []
  const kept = filled.length > 0 ? filled[filled.length - 1].i : -1
  return foldable.filter(({ i }) => i !== kept).map(({ i }) => i)
}
