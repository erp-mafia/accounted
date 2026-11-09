/** Runs in the browser: include nested scroll regions, not just the outer page. */
export function horizontalOverflow() {
  const root = document.documentElement
  const main = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(element => element.getClientRects().length) ?? document.querySelector('main') ?? document.body
  const regions = [...main.querySelectorAll<HTMLElement>('*')].filter(element => {
    if (!element.getClientRects().length || element.closest('[aria-hidden="true"], .sr-only')) return false
    const head = element.closest('thead')
    if (head && getComputedStyle(head).clipPath !== 'none') return false
    const style = getComputedStyle(element)
    return style.visibility !== 'hidden' && style.opacity !== '0'
      && element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 2
      && ['auto', 'scroll'].includes(style.overflowX)
  }).map(element => ({ tag: element.tagName, className: element.className, width: element.clientWidth, content: element.scrollWidth }))
  return {
    // Mobile innerWidth can grow to the overflowing content's width. The
    // document's clientWidth remains the actual layout viewport.
    page: root.scrollWidth > root.clientWidth + 2,
    main: main.scrollWidth > main.clientWidth + 2,
    regions,
  }
}
