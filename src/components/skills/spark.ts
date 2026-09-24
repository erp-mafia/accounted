/**
 * The Gnista: a small light that hops between elements. Positions are in
 * the coordinate space of `box` (position: relative), so the spark scrolls
 * with the page. Every run takes an `alive` check and stops quietly when it
 * turns false (unmount, a newer run, a state change).
 */
export interface Point { x: number; y: number }

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const tr = (p: Point) => `translate(${Math.round(p.x * 10) / 10}px,${Math.round(p.y * 10) / 10}px)`

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

export function centerIn(box: Element, el: Element): Point {
  const r = el.getBoundingClientRect()
  const b = box.getBoundingClientRect()
  return { x: r.left + r.width / 2 - b.left, y: r.top + r.height / 2 - b.top }
}

export class Spark {
  private el: HTMLSpanElement
  private pos: Point

  constructor(private box: HTMLElement, start: Point, className: string) {
    this.el = document.createElement('span')
    this.el.className = className
    this.el.setAttribute('aria-hidden', 'true')
    this.pos = start
    this.el.style.transform = tr(start)
    box.appendChild(this.el)
  }

  /** Arc to the centre of `target`, `lift` px above the straight line. */
  async hop(target: Element, duration: number, lift: number): Promise<void> {
    const to = centerIn(this.box, target)
    const mid = { x: (this.pos.x + to.x) / 2, y: Math.min(this.pos.y, to.y) - lift }
    const animation = this.el.animate(
      [{ transform: tr(this.pos), easing: 'ease-out' }, { transform: tr(mid), offset: 0.5, easing: 'ease-in' }, { transform: tr(to) }],
      { duration, fill: 'forwards' },
    )
    this.pos = to
    await animation.finished.catch(() => undefined)
  }

  async fade(): Promise<void> {
    this.el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, fill: 'forwards' })
    await wait(320)
    this.remove()
  }

  remove(): void {
    this.el.remove()
  }
}

export { wait }
