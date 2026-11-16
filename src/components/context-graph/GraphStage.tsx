'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { ArrowsPointingOutIcon, MinusIcon, PlusIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { GraphLayout } from '@/lib/context-graph/layout'
import type { GraphEdge, GraphFamily } from '@/lib/context-graph/types'

/**
 * The stage of the context graph: the dots, the lines between them and the
 * hands-on part (founder brief 2026-11-14: "like Obsidian's clean graph",
 * "more living", "add dragging and zooming").
 *
 * - It unfolds from the middle when it opens, then every dot sways a few
 *   pixels on its own slow rhythm and the lines follow.
 * - Drag a dot: it follows the pointer, its neighbours come part of the way,
 *   and it stays where it is dropped. Drag the ground to move the whole web.
 * - Pinch, or ctrl/cmd + wheel, zooms toward the pointer. A plain wheel and
 *   a vertical swipe on the ground are left to the page, so the graph never
 *   traps someone scrolling past it. Three buttons zoom out, in and reset.
 * - Zoomed in, every dot shows its name.
 *
 * Dots are real buttons (one tab stop, arrow keys move to the nearest dot in
 * that direction, Enter selects, Esc clears); lines are one SVG behind them.
 * Positions are written straight to the elements on each frame, outside
 * React, so a frame costs no render. The loop runs only while there is
 * something to move: it stops when the tab is hidden, when the stage is off
 * screen, and under prefers-reduced-motion (then the picture is still, and
 * dragging and zooming still work).
 *
 * The sway is the one decorative motion on the page, asked for by the
 * founder for this picture; it is not a pattern for other surfaces.
 */

export interface StageNode {
  id: string
  family: GraphFamily
  /** The name under the dot. */
  label: string
  /** The accessible name: what kind of thing it is and what it says. */
  name: string
}

export interface GraphStageLabels {
  stage: string
  zoomGroup: string
  zoomOut: string
  zoomIn: string
  zoomReset: string
}

interface GraphStageProps {
  nodes: StageNode[]
  edges: readonly GraphEdge[]
  layout: GraphLayout
  /** The stage's size in pixels. */
  width: number
  height: number
  selected: string | null
  onSelect: (id: string | null) => void
  /** Dots outside this set are dimmed (a chip's family); null for none. */
  lit: ReadonlySet<string> | null
  labels: GraphStageLabels
  /** Drawn over the stage (the selected dot's panel). */
  children?: ReactNode
}

/** The dot colours: the v3 chart pair (blue, ochre) and a neutral grey, the strong ink for the agent. */
export const FAMILY_DOT: Record<GraphFamily, string> = {
  agent: 'hsl(var(--strong))',
  taught: 'hsl(var(--chart-1))',
  read: 'hsl(var(--chart-2))',
  wait: 'hsl(var(--chart-2))',
  instructions: 'hsl(var(--chart-4) / 0.75)',
  ref: 'hsl(var(--chart-4) / 0.75)',
}

const MIN_ZOOM = 0.6
const MAX_ZOOM = 3.2
/** From this zoom every dot shows its name. */
const NAMES_FROM_ZOOM = 1.45
/** How far a neighbour follows a dragged dot. */
const FOLLOW = 0.32
const UNFOLD_MS = 1600
/** A picked dot with at most this many neighbours shows their names. */
const NAMED_NEIGHBOURS = 8
const CLICK_SLOP = 5

type Pair = [number, number]

interface Engine {
  z: number
  px: number
  py: number
  /** Where a dragged dot was dropped, as an offset from its laid-out place. */
  off: Map<string, Pair>
  /** The offset each dot is drawn with right now (eases toward its target). */
  cur: Map<string, Pair>
  /** Each dot's place in stage units this frame, sway and drag included. */
  pos: Map<string, Pair>
  drag: { id: string; dx: number; dy: number } | null
  pan: { x: number; y: number; px: number; py: number } | null
  pinch: { dist: number; mx: number; my: number } | null
  pointers: Map<number, Pair>
  down: Pair
  moved: boolean
  openedAt: number | null
  swayClock: number
  lastFrame: number
  frame: number
  drawnZoom: number
  visible: boolean
  reduced: boolean
}

function newEngine(): Engine {
  return {
    z: 1,
    px: 0,
    py: 0,
    off: new Map(),
    cur: new Map(),
    pos: new Map(),
    drag: null,
    pan: null,
    pinch: null,
    pointers: new Map(),
    down: [0, 0],
    moved: false,
    openedAt: null,
    swayClock: 0,
    lastFrame: 0,
    frame: 0,
    drawnZoom: 0,
    visible: true,
    reduced: false,
  }
}

export function GraphStage({ nodes, edges, layout, width, height, selected, onSelect, lit, labels, children }: GraphStageProps) {
  const stageRef = useRef<HTMLDivElement>(null)
  const fadeRef = useRef<HTMLDivElement>(null)
  const dotRefs = useRef(new Map<string, HTMLButtonElement>())
  const lineRefs = useRef<(SVGLineElement | null)[]>([])
  const engine = useRef<Engine | null>(null)
  if (engine.current === null) engine.current = newEngine()

  const [zoomedIn, setZoomedIn] = useState(false)
  const [grab, setGrab] = useState<'no' | 'pan' | 'dot'>('no')
  /** The one dot in the tab order (roving tabindex): the last one focused, the agent to begin with. */
  const [tabStop, setTabStop] = useState<string | null>(null)
  const firstId = nodes[0]?.id ?? null
  const tabId = tabStop && layout.pos[tabStop] ? tabStop : firstId

  const W = layout.stage.width
  const H = layout.stage.height

  /** Write every dot and line to its place for this frame. Returns whether another frame is needed. */
  const draw = useCallback(
    (now: number): boolean => {
      const g = engine.current!
      const cx = W / 2
      const cy = H / 2
      const sx = width / W
      const sy = height / H
      if (g.openedAt === null) g.openedAt = now
      const dt = g.lastFrame ? Math.min(100, now - g.lastFrame) : 0
      g.lastFrame = now
      const swaying = !g.reduced && g.visible && !document.hidden
      if (swaying) g.swayClock += dt
      const t = g.swayClock / 1000
      const sinceOpen = now - g.openedAt
      const open = g.reduced ? 1 : 1 - Math.pow(1 - Math.min(1, sinceOpen / UNFOLD_MS), 3)
      const spread = 0.5 + 0.5 * open
      // Dots grow with the square root of the zoom, and are a little smaller where the stage is (a phone).
      const zs = Math.sqrt(g.z) * Math.min(1, Math.max(0.75, sx * 0.85))
      const resize = g.drawnZoom !== g.z
      let easing = false

      nodes.forEach((node, i) => {
        const base = layout.pos[node.id]
        if (!base) return
        let target = g.off.get(node.id)
        if (!target) {
          // Not dropped anywhere itself: follow the dropped neighbours part of the way.
          let ax = 0
          let ay = 0
          let m = 0
          for (const o of layout.neighbours[node.id] ?? []) {
            const off = g.off.get(o)
            if (off) {
              ax += off[0]
              ay += off[1]
              m++
            }
          }
          target = m ? [(FOLLOW * ax) / m, (FOLLOW * ay) / m] : [0, 0]
        }
        const had = g.cur.get(node.id) ?? [0, 0]
        const snap = g.reduced || g.drag?.id === node.id
        const cur: Pair = snap ? [target[0], target[1]] : [had[0] + (target[0] - had[0]) * 0.22, had[1] + (target[1] - had[1]) * 0.22]
        if (Math.abs(target[0] - cur[0]) + Math.abs(target[1] - cur[1]) > 0.3) easing = true
        g.cur.set(node.id, cur)

        const phase = i * 2.399
        const amp = g.reduced ? 0 : i === 0 ? 2.5 : 6
        const swayX = amp * Math.sin(t / (2.9 + (i % 5) * 0.6) + phase)
        const swayY = amp * 0.8 * Math.cos(t / (3.4 + (i % 4) * 0.8) + phase * 1.7)
        const gx = cx + (base.x - cx) * spread + cur[0] + swayX
        const gy = cy + (base.y - cy) * spread + cur[1] + swayY
        g.pos.set(node.id, [gx, gy])

        const el = dotRefs.current.get(node.id)
        if (!el) return
        const x = ((gx - cx) * g.z + cx + g.px) * sx
        const y = ((gy - cy) * g.z + cy + g.py) * sy
        el.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0) translate(-50%, -50%)`
        if (resize) {
          const d = Math.round((layout.size[node.id] ?? 8) * zs)
          el.style.width = `${d}px`
          el.style.height = `${d}px`
        }
      })
      g.drawnZoom = g.z

      edges.forEach(([a, b], j) => {
        const line = lineRefs.current[j]
        const pa = g.pos.get(a)
        const pb = g.pos.get(b)
        if (!line || !pa || !pb) return
        line.setAttribute('x1', (((pa[0] - cx) * g.z + cx + g.px) * sx).toFixed(2))
        line.setAttribute('y1', (((pa[1] - cy) * g.z + cy + g.py) * sy).toFixed(2))
        line.setAttribute('x2', (((pb[0] - cx) * g.z + cx + g.px) * sx).toFixed(2))
        line.setAttribute('y2', (((pb[1] - cy) * g.z + cy + g.py) * sy).toFixed(2))
      })
      if (fadeRef.current) fadeRef.current.style.opacity = open.toFixed(2)

      const busy = g.drag !== null || g.pan !== null || g.pinch !== null
      return swaying || busy || easing || open < 1
    },
    [W, H, width, height, nodes, edges, layout],
  )

  /** Ask for a frame; the loop keeps itself going only while draw says there is more to move. */
  const kick = useCallback(() => {
    const g = engine.current!
    if (g.frame) return
    const step = (now: number) => {
      g.frame = 0
      if (draw(now)) g.frame = requestAnimationFrame(step)
      else g.lastFrame = 0
    }
    g.frame = requestAnimationFrame(step)
  }, [draw])

  // Place everything before the first paint, and again whenever the picture or its size changes.
  useLayoutEffect(() => {
    const g = engine.current!
    g.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    g.drawnZoom = 0
    draw(performance.now())
    kick()
    return () => {
      cancelAnimationFrame(g.frame)
      g.frame = 0
    }
  }, [draw, kick])

  // The sway rests when nobody can see it: a hidden tab, the stage scrolled away, reduced motion.
  useEffect(() => {
    const g = engine.current!
    const stage = stageRef.current
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onMotion = () => {
      g.reduced = media.matches
      kick()
    }
    const onVisibility = () => kick()
    media.addEventListener('change', onMotion)
    document.addEventListener('visibilitychange', onVisibility)
    const seen =
      typeof IntersectionObserver === 'undefined' || !stage
        ? null
        : new IntersectionObserver((entries) => {
            g.visible = entries.some((e) => e.isIntersecting)
            kick()
          })
    if (seen && stage) seen.observe(stage)
    return () => {
      media.removeEventListener('change', onMotion)
      document.removeEventListener('visibilitychange', onVisibility)
      seen?.disconnect()
    }
  }, [kick])

  /** A pointer's place in stage units, under the current zoom and pan. */
  const toStage = useCallback(
    (clientX: number, clientY: number): Pair => {
      const g = engine.current!
      const box = stageRef.current!.getBoundingClientRect()
      return [(((clientX - box.left) / box.width) * W - g.px - W / 2) / g.z + W / 2, (((clientY - box.top) / box.height) * H - g.py - H / 2) / g.z + H / 2]
    },
    [W, H],
  )

  /** Zoom so the stage point (gx, gy) stays under the pointer. */
  const zoomAt = useCallback(
    (next: number, gx: number, gy: number) => {
      const g = engine.current!
      const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next))
      g.px += (gx - W / 2) * (g.z - z)
      g.py += (gy - H / 2) * (g.z - z)
      g.z = z
      setZoomedIn(z >= NAMES_FROM_ZOOM)
      kick()
    },
    [W, H, kick],
  )

  const zoomButton = (factor: number) => {
    const g = engine.current!
    zoomAt(g.z * factor, W / 2 - g.px / g.z, H / 2 - g.py / g.z)
  }
  const reset = () => {
    const g = engine.current!
    g.z = 1
    g.px = 0
    g.py = 0
    g.off.clear()
    setZoomedIn(false)
    kick()
  }

  // Ctrl/cmd + wheel (and a trackpad pinch, which arrives as that) zooms; a plain wheel is the page's.
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const p = toStage(e.clientX, e.clientY)
      zoomAt(engine.current!.z * Math.exp(-e.deltaY * 0.012), p[0], p[1])
    }
    // Safari sends a trackpad pinch as gesture events with a running scale.
    let startZoom = 1
    const onGestureStart = (e: Event) => {
      e.preventDefault()
      startZoom = engine.current!.z
    }
    const onGestureChange = (e: Event) => {
      e.preventDefault()
      const ge = e as Event & { scale?: number; clientX?: number; clientY?: number }
      const box = stage.getBoundingClientRect()
      const p = toStage(ge.clientX ?? box.left + box.width / 2, ge.clientY ?? box.top + box.height / 2)
      zoomAt(startZoom * (ge.scale ?? 1), p[0], p[1])
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    stage.addEventListener('gesturestart', onGestureStart)
    stage.addEventListener('gesturechange', onGestureChange)
    return () => {
      stage.removeEventListener('wheel', onWheel)
      stage.removeEventListener('gesturestart', onGestureStart)
      stage.removeEventListener('gesturechange', onGestureChange)
    }
  }, [toStage, zoomAt])

  // One gesture at a time: a dot drag, a ground pan, or a two-finger pinch. The listeners live on the window while it lasts.
  const gesture = useRef<{ move: (e: PointerEvent) => void; end: (e: PointerEvent) => void } | null>(null)
  const stopGesture = useCallback(() => {
    if (!gesture.current) return
    window.removeEventListener('pointermove', gesture.current.move)
    window.removeEventListener('pointerup', gesture.current.end)
    window.removeEventListener('pointercancel', gesture.current.end)
    gesture.current = null
  }, [])
  useEffect(() => stopGesture, [stopGesture])

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button > 0) return
    const target = e.target as Element
    if (target.closest('[data-graph-ui]')) return
    const g = engine.current!
    g.pointers.set(e.pointerId, [e.clientX, e.clientY])
    if (g.pointers.size === 2) {
      const [a, b] = [...g.pointers.values()]
      g.drag = null
      g.pan = null
      g.pinch = { dist: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, mx: (a[0] + b[0]) / 2, my: (a[1] + b[1]) / 2 }
      g.moved = true
    } else if (g.pointers.size === 1) {
      const p = toStage(e.clientX, e.clientY)
      g.moved = false
      g.down = [e.clientX, e.clientY]
      const id = target.closest<HTMLElement>('[data-node]')?.dataset.node
      if (id) {
        const at = g.pos.get(id) ?? p
        g.drag = { id, dx: p[0] - at[0], dy: p[1] - at[1] }
      } else {
        g.pan = { x: e.clientX, y: e.clientY, px: g.px, py: g.py }
      }
    }
    if (gesture.current) return
    const move = (ev: PointerEvent) => {
      if (!g.pointers.has(ev.pointerId)) return
      g.pointers.set(ev.pointerId, [ev.clientX, ev.clientY])
      const box = stageRef.current?.getBoundingClientRect()
      if (!box) return
      if (g.pinch && g.pointers.size >= 2) {
        const [a, b] = [...g.pointers.values()]
        const dist = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1
        const mx = (a[0] + b[0]) / 2
        const my = (a[1] + b[1]) / 2
        g.px += ((mx - g.pinch.mx) / box.width) * W
        g.py += ((my - g.pinch.my) / box.height) * H
        const p = toStage(mx, my)
        zoomAt((g.z * dist) / g.pinch.dist, p[0], p[1])
        g.pinch = { dist, mx, my }
        return
      }
      if (!g.drag && !g.pan) return
      if (!g.moved && Math.abs(ev.clientX - g.down[0]) + Math.abs(ev.clientY - g.down[1]) < CLICK_SLOP) return
      if (!g.moved) setGrab(g.drag ? 'dot' : 'pan')
      g.moved = true
      if (g.drag) {
        const p = toStage(ev.clientX, ev.clientY)
        const base = layout.pos[g.drag.id]
        if (base) g.off.set(g.drag.id, [p[0] - g.drag.dx - base.x, p[1] - g.drag.dy - base.y])
      } else if (g.pan) {
        g.px = g.pan.px + ((ev.clientX - g.pan.x) / box.width) * W
        g.py = g.pan.py + ((ev.clientY - g.pan.y) / box.height) * H
      }
      kick()
    }
    const end = (ev: PointerEvent) => {
      g.pointers.delete(ev.pointerId)
      if (g.pointers.size < 2) g.pinch = null
      if (g.pointers.size > 0) return
      g.drag = null
      g.pan = null
      stopGesture()
      setGrab('no')
      // The click that follows a drag is not a pick.
      window.setTimeout(() => {
        g.moved = false
      }, 80)
      kick()
    }
    gesture.current = { move, end }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }

  /** Keep a focused dot inside the stage: the web moves, the page does not jump. */
  const reveal = (id: string) => {
    const g = engine.current!
    const at = g.pos.get(id)
    if (!at) return
    const x = (at[0] - W / 2) * g.z + W / 2 + g.px
    const y = (at[1] - H / 2) * g.z + H / 2 + g.py
    const padX = W * 0.06
    const padY = H * 0.1
    if (x < padX) g.px += padX - x
    else if (x > W - padX) g.px -= x - (W - padX)
    if (y < padY) g.py += padY - y
    else if (y > H - padY) g.py -= y - (H - padY)
    kick()
  }

  const focusDot = (id: string) => {
    setTabStop(id)
    reveal(id)
    dotRefs.current.get(id)?.focus({ preventScroll: true })
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      if (selected !== null) {
        e.stopPropagation()
        onSelect(null)
      }
      return
    }
    const from = (e.target as Element).closest<HTMLElement>('[data-node]')?.dataset.node
    if (!from) return
    if (e.key === 'Home' && firstId) {
      e.preventDefault()
      focusDot(firstId)
      return
    }
    const dir: Pair | null = e.key === 'ArrowRight' ? [1, 0] : e.key === 'ArrowLeft' ? [-1, 0] : e.key === 'ArrowDown' ? [0, 1] : e.key === 'ArrowUp' ? [0, -1] : null
    if (!dir) return
    e.preventDefault()
    const g = engine.current!
    const here = g.pos.get(from)
    if (!here) return
    // The nearest dot in that direction: distance along the arrow, with sideways distance counted double.
    let best: string | null = null
    let bestCost = Infinity
    for (const [id, at] of g.pos) {
      if (id === from) continue
      const along = (at[0] - here[0]) * dir[0] + (at[1] - here[1]) * dir[1]
      const aside = Math.abs((at[0] - here[0]) * dir[1]) + Math.abs((at[1] - here[1]) * dir[0])
      if (along <= 1 || aside > along * 2.5) continue
      const cost = along + aside * 2
      if (cost < bestCost) {
        bestCost = cost
        best = id
      }
    }
    if (best) focusDot(best)
  }

  const near = selected ? new Set([selected, ...(layout.neighbours[selected] ?? [])]) : null
  // A picked dot names its neighbours too, unless it has so many that the names would pile up.
  const namesNear = near !== null && near.size <= NAMED_NEIGHBOURS + 1
  const dimmed = (id: string) => (near ? !near.has(id) : lit ? !lit.has(id) : false)

  return (
    <div
      ref={stageRef}
      role="group"
      aria-label={labels.stage}
      data-grab={grab}
      className={cn('relative touch-pan-y select-none overflow-clip', grab === 'no' ? 'cursor-grab' : 'cursor-grabbing')}
      style={{ height }}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onClick={(e) => {
        // A click on the bare ground lets go of the selection.
        if (engine.current!.moved || selected === null) return
        if ((e.target as Element).closest('[data-node], [data-graph-ui]')) return
        onSelect(null)
      }}
    >
      <div ref={fadeRef} className="absolute inset-0" data-ph-mask="">
        <svg aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" width={width} height={height}>
          {edges.map(([a, b], j) => {
            const on = selected !== null && (a === selected || b === selected)
            const faded = selected !== null ? !on : lit ? !(lit.has(a) && lit.has(b)) : false
            return (
              <line
                key={`${a}|${b}`}
                ref={(el) => {
                  lineRefs.current[j] = el
                }}
                stroke={on ? 'hsl(var(--strong))' : 'hsl(var(--line-strong))'}
                strokeWidth={on ? 1.1 : 0.8}
                className={cn('transition-opacity duration-150', faded && 'opacity-25')}
              />
            )
          })}
        </svg>
        {nodes.map((node) => {
          const isSelected = node.id === selected
          const dim = dimmed(node.id)
          const named = layout.labelShown[node.id] || zoomedIn || isSelected || (namesNear && !dim)
          const hollow = node.family === 'wait'
          const color = FAMILY_DOT[node.family]
          return (
            <button
              key={node.id}
              ref={(el) => {
                if (el) dotRefs.current.set(node.id, el)
                else dotRefs.current.delete(node.id)
              }}
              type="button"
              data-node={node.id}
              aria-label={node.name}
              aria-pressed={isSelected}
              tabIndex={node.id === tabId ? 0 : -1}
              onFocus={() => setTabStop(node.id)}
              onClick={() => {
                if (engine.current!.moved) return
                onSelect(isSelected ? null : node.id)
              }}
              className={cn(
                'group/dot absolute left-0 top-0 touch-none rounded-full p-0 outline-offset-2 transition-opacity duration-150',
                "after:absolute after:-inset-2 after:rounded-full after:content-['']",
                'hover:z-10 hover:ring-[3px] focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-ring/70',
                grab === 'no' ? 'cursor-pointer' : 'cursor-grabbing',
                hollow ? 'border-[1.5px] bg-background' : 'border-0',
                isSelected && 'z-10 outline-2 outline-strong',
                dim && 'opacity-20',
              )}
              style={{
                ...(hollow ? { borderColor: color } : { backgroundColor: color }),
                ['--tw-ring-color' as string]: `color-mix(in srgb, ${color} 30%, transparent)`,
              }}
            >
              {node.label ? (
                <span
                  className={cn(
                    'pointer-events-none absolute left-1/2 top-full mt-1 -translate-x-1/2 whitespace-nowrap text-xs transition-opacity duration-150',
                    node.family === 'agent' || isSelected ? 'font-medium text-strong' : 'text-muted-foreground group-hover/dot:text-strong group-focus-visible/dot:text-strong',
                    // A named group: the app's touch rule that reveals every plain group-hover control must not show all names at once.
                    named ? 'opacity-100' : 'opacity-0 group-hover/dot:opacity-100 group-focus-visible/dot:opacity-100',
                  )}
                >
                  {node.label}
                </span>
              ) : null}
            </button>
          )
        })}
      </div>
      {children}
      <div data-graph-ui="" role="group" aria-label={labels.zoomGroup} className="absolute bottom-4 right-4 flex cursor-default gap-1.5 md:right-6">
        <Button variant="outline" size="icon" aria-label={labels.zoomOut} title={labels.zoomOut} onClick={() => zoomButton(1 / 1.35)}>
          <MinusIcon className="h-3.5 w-3.5" />
        </Button>
        <Button variant="outline" size="icon" aria-label={labels.zoomIn} title={labels.zoomIn} onClick={() => zoomButton(1.35)}>
          <PlusIcon className="h-3.5 w-3.5" />
        </Button>
        <Button variant="outline" size="icon" aria-label={labels.zoomReset} title={labels.zoomReset} onClick={reset}>
          <ArrowsPointingOutIcon className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
}
