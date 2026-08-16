'use client'

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import type { TheaterBucket, TheaterModel } from '@/lib/import/theater-model'

/**
 * The constellation canvas shared by the import theater (build mode: nodes
 * spawn under the narration's control) and the result reveal (settled mode:
 * everything born, camera home, gentle breathing only). Deterministic radial
 * layout, no physics; colors and fonts read from the app tokens per frame
 * (theme/palette reactive, same idiom as JourneyOrb).
 */

export interface TheaterCanvasHandle {
  spawn: (kind: NodeKind, wave?: number) => void
  pulse: () => void
  feed: (ms: number) => void
}

type NodeKind = 'hub' | 'ring' | 'bucket' | 'account' | 'counterparty'

const BUCKET_ANGLE: Record<TheaterBucket, number> = {
  tillgangar: 0.31,
  skulder: 1.62,
  intakter: -0.92,
  kostnader: 2.75,
}
const BUCKET_LABEL: Record<TheaterBucket, string> = {
  tillgangar: 'TILLGÅNGAR',
  skulder: 'SKULDER',
  intakter: 'INTÄKTER',
  kostnader: 'KOSTNADER',
}

/** Real BAS names run long ("4531 Inköp av tjänster från ett land utanför
 *  EU, 25 % moms"); labels truncate hard so the constellation stays a
 *  constellation. */
function truncateLabel(label: string, max: number): string {
  return label.length <= max ? label : label.slice(0, max - 1).trimEnd() + '…'
}

/** Deterministic [0,1) hash so the constellation is stable per file. */
function rand01(seed: string): number {
  let h = 1779033703 ^ seed.length
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507)
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296
}

interface Node {
  id: string
  kind: NodeKind
  x: number
  y: number
  r: number
  ring?: number
  label?: string
  lab?: boolean
  wave: number
  born: number | null
}

interface Engine {
  nodes: Node[]
  edges: { a: string; b: string }[]
  stream: { x: number; y: number; target: Node }[]
  feedUntil: number
  pulse: number
  cam: number
}

function buildEngine(model: TheaterModel, allBorn: boolean): Engine {
  const nodes: Node[] = []
  const edges: { a: string; b: string }[] = []
  nodes.push({ id: 'hub', kind: 'hub', x: 0, y: 0, r: 7, label: model.companyName, lab: true, wave: 0, born: null })
  model.years.forEach((y, i) => {
    nodes.push({ id: `ring${i}`, kind: 'ring', x: 0, y: 0, r: 0, ring: 58 + i * 24, label: y.start.slice(0, 4), wave: 0, born: null })
  })
  for (const bucket of model.buckets) {
    const p = BUCKET_ANGLE[bucket.id]
    nodes.push({ id: bucket.id, kind: 'bucket', x: Math.cos(p) * 148, y: Math.sin(p) * 148, r: 2.2, label: BUCKET_LABEL[bucket.id], lab: true, wave: 0, born: null })
    edges.push({ a: 'hub', b: bucket.id })
  }
  const maxAccountWeight = Math.max(1, ...model.accounts.map((a) => a.weight))
  model.accounts.forEach((a, i) => {
    const base = BUCKET_ANGLE[a.bucket]
    const spread = (rand01(a.number) - 0.5) * 1.2
    const rad = 185 + rand01(a.number + 'r') * 70
    nodes.push({
      id: a.number,
      kind: 'account',
      x: Math.cos(base + spread) * rad,
      y: Math.sin(base + spread) * rad,
      r: 2.4 + (a.weight / maxAccountWeight) * 3.4,
      label: truncateLabel(`${a.number} ${a.name}`.trim(), 24),
      lab: i < 5,
      wave: i % 4,
      born: null,
    })
    edges.push({ a: a.bucket, b: a.number })
  })
  const maxCpWeight = Math.max(1, ...model.counterparties.map((c) => c.weight))
  model.counterparties.forEach((c, i) => {
    const anchor = nodes.find((n) => n.id === c.account)
    const base = anchor ? Math.atan2(anchor.y, anchor.x) : BUCKET_ANGLE.kostnader
    const spread = (rand01(c.name) - 0.5) * 0.7
    const rad = 258 + rand01(c.name + 'r') * 52
    nodes.push({
      id: `cp${i}`,
      kind: 'counterparty',
      x: Math.cos(base + spread) * rad,
      y: Math.sin(base + spread) * rad,
      r: 1.8 + (c.weight / maxCpWeight) * 2.4,
      label: truncateLabel(c.name, 16),
      lab: i < 5,
      wave: i % 3,
      born: null,
    })
    if (anchor) edges.push({ a: c.account, b: `cp${i}` })
  })
  const now = typeof performance !== 'undefined' ? performance.now() : 0
  if (allBorn) for (const n of nodes) n.born = now - 10_000
  return { nodes, edges, stream: [], feedUntil: 0, pulse: 0, cam: allBorn ? 1 : 1.45 }
}

function tokenColors(canvas: HTMLCanvasElement) {
  const root = getComputedStyle(document.documentElement)
  const hsl = (name: string, fallback: string) => {
    const v = root.getPropertyValue(name).trim()
    return v ? `hsl(${v})` : fallback
  }
  return {
    ink: getComputedStyle(canvas).color,
    mut: hsl('--muted-foreground', '#8a8378'),
    hair: hsl('--border', '#e5e2da'),
    sage: hsl('--success', '#5d8a6f'),
    paper: hsl('--background', '#ffffff'),
  }
}

const TheaterCanvas = forwardRef<TheaterCanvasHandle, {
  model: TheaterModel
  /** Settled: everything born at mount, camera home, breathing only. */
  settled?: boolean
  className?: string
}>(function TheaterCanvas({ model, settled = false, className }, ref) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const engineRef = useRef<Engine | null>(null)
  const reduced =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches

  useImperativeHandle(ref, () => ({
    spawn: (kind, wave) => {
      const engine = engineRef.current
      if (!engine) return
      const now = performance.now()
      for (const n of engine.nodes) {
        if (n.born == null && n.kind === kind && (wave === undefined || n.wave === wave)) n.born = now
      }
    },
    pulse: () => {
      if (engineRef.current) engineRef.current.pulse = performance.now()
    },
    feed: (ms) => {
      if (engineRef.current) engineRef.current.feedUntil = performance.now() + ms
    },
  }))

  useEffect(() => {
    const engine = buildEngine(model, settled || reduced)
    engineRef.current = engine
    if (!settled && !reduced) {
      const now = performance.now()
      for (const n of engine.nodes) if (n.kind === 'hub') n.born = now
    }
    const canvas = canvasRef.current
    if (!canvas) return
    let running = true
    // Settled mode still breathes; only reduced motion freezes the frame.
    const still = reduced
    const draw = () => {
      if (!canvas.isConnected || !engineRef.current) return
      const wrap = canvas.parentElement
      if (!wrap) return
      const W = wrap.clientWidth
      const H = wrap.clientHeight
      if (!W || !H) {
        if (running && !still) requestAnimationFrame(draw)
        return
      }
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
        canvas.width = W * dpr
        canvas.height = H * dpr
      }
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, W, H)
      const colors = tokenColors(canvas)
      const now = performance.now()
      const born = engine.nodes.filter((n) => n.born != null).length
      const camTarget = settled || reduced ? 1 : 1.45 - 0.45 * Math.min(1, born / (engine.nodes.length * 0.85))
      engine.cam += (camTarget - engine.cam) * (reduced ? 1 : 0.05)
      const k = (Math.min(W, H) / 640) * engine.cam
      const cx = W / 2
      const cy = H / 2
      const pos = (n: Node) => ({ x: cx + n.x * k, y: cy + n.y * k })
      const age = (n: Node) =>
        n.born == null ? 0 : Math.min(1, (now - n.born) / (reduced ? 1 : n.kind === 'ring' ? 900 : 420))
      const ease = (v: number) => 1 - Math.pow(1 - v, 3)
      const byId = new Map(engine.nodes.map((n) => [n.id, n]))

      // Ambient life (Living Paper): the constellation moves because it is
      // alive right now, never to fake progress. Build mode gets full
      // amplitude, settled reveals rest at half (the reveal is a verdict),
      // reduced motion gets none (the loop is frozen anyway). Everything is
      // derived from the clock inside this one rAF loop; no extra timers.
      const ambient = reduced ? 0 : settled ? 0.5 : 1
      // Every 7s a quiet luminance wave travels hub -> rim over 2.6s,
      // brightening the hairline rings and edges it passes (alpha only, no
      // color, no geometry). Build mode only; -1 means resting.
      const ripple =
        ambient === 1 && now % 7000 < 2600 ? ((now % 7000) / 2600) * 340 : -1
      const rippleGlow = (radius: number, width: number) =>
        ripple < 0 ? 0 : Math.max(0, 1 - Math.abs(radius - ripple) / width)

      for (const n of engine.nodes) {
        if (n.kind !== 'ring' || n.born == null) continue
        const p = ease(age(n))
        const rad = (n.ring ?? 0) * k
        ctx.strokeStyle = colors.hair
        ctx.globalAlpha = (0.75 + 0.18 * rippleGlow(n.ring ?? 0, 30)) * p
        ctx.lineWidth = 0.8
        ctx.beginPath()
        ctx.arc(cx, cy, rad, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p)
        ctx.stroke()
        ctx.globalAlpha = Math.max(0, p * 1.3 - 0.3)
        const lx = cx + Math.cos(-1.15) * rad
        const ly = cy + Math.sin(-1.15) * rad
        ctx.fillStyle = colors.paper
        ctx.fillRect(lx - 15, ly - 6, 30, 12)
        ctx.fillStyle = colors.mut
        ctx.font = '10px system-ui, sans-serif'
        ctx.textAlign = 'center'
        if (n.label) ctx.fillText(n.label, lx, ly + 3.5)
        ctx.globalAlpha = 1
      }

      for (const e of engine.edges) {
        const A = byId.get(e.a)
        const B = byId.get(e.b)
        if (!A || !B || A.born == null || B.born == null) continue
        const p = ease(Math.min(age(A), age(B)))
        const pa = pos(A)
        const pb = pos(B)
        const glow =
          ripple < 0 ? 0 : rippleGlow(Math.hypot((A.x + B.x) / 2, (A.y + B.y) / 2), 40)
        ctx.strokeStyle = colors.hair
        ctx.lineWidth = 0.8
        ctx.globalAlpha = 0.65 + 0.12 * glow
        ctx.beginPath()
        ctx.moveTo(pa.x, pa.y)
        ctx.lineTo(pa.x + (pb.x - pa.x) * p, pa.y + (pb.y - pa.y) * p)
        ctx.stroke()
        ctx.globalAlpha = 1
      }

      if (now < engine.feedUntil && !reduced && engine.stream.length < 60) {
        const targets = engine.nodes.filter((n) => n.kind === 'account' && n.born != null)
        if (targets.length) {
          for (let i = 0; i < 2; i++) {
            engine.stream.push({
              x: 8,
              y: cy + (Math.random() - 0.5) * 170,
              target: targets[(Math.random() * targets.length) | 0],
            })
          }
        }
      }
      if (engine.stream.length) {
        ctx.fillStyle = colors.mut
        engine.stream = engine.stream.filter((p) => {
          const tp = pos(p.target)
          p.x += (tp.x - p.x) * 0.085
          p.y += (tp.y - p.y) * 0.085
          if (Math.abs(tp.x - p.x) + Math.abs(tp.y - p.y) < 7) return false
          ctx.globalAlpha = 0.5
          ctx.fillRect(p.x, p.y, 1.6, 1.6)
          return true
        })
        ctx.globalAlpha = 1
      }

      if (engine.pulse > 0) {
        const p = Math.min(1, (now - engine.pulse) / 900)
        if (p < 1) {
          ctx.strokeStyle = colors.sage
          ctx.globalAlpha = (1 - p) * 0.5
          ctx.lineWidth = 1.2
          ctx.beginPath()
          ctx.arc(cx, cy, 18 + p * 290 * (Math.min(W, H) / 640), 0, Math.PI * 2)
          ctx.stroke()
          ctx.globalAlpha = 1
        }
      }

      // Greedy label collision culling: node order is hub → buckets →
      // heaviest accounts → heaviest counterparties, so when labels would
      // overlap (real files cluster hard in one region), the least important
      // one silently keeps only its dot.
      const drawnLabels: { x0: number; y0: number; x1: number; y1: number }[] = []
      const overlaps = (x0: number, y0: number, x1: number, y1: number) =>
        drawnLabels.some((b) => x0 < b.x1 && x1 > b.x0 && y0 < b.y1 && y1 > b.y0)
      for (const n of engine.nodes) {
        if (n.born == null || n.kind === 'ring') continue
        const p = ease(age(n))
        const q = pos(n)
        // Per-node breathing on two slow, incommensurate clocks, offset by
        // the node's own position/wave so the field shimmers organically
        // instead of in sync. Radius +-10% (roughly 1px on the hub, less on
        // small dots) and a few percent of alpha; half of both when settled.
        const breathe = ambient * 0.1 * Math.sin(now / 2600 + n.x + n.y)
        const twinkle = ambient * 0.04 * (0.5 + 0.5 * Math.sin(now / 3400 + n.x + n.wave * 1.7))
        const splat = p < 1 ? 1 + 0.3 * Math.sin(p * Math.PI) : 1
        const r = n.r * (1 + breathe) * p * k * 1.55 * splat
        ctx.fillStyle = n.kind === 'bucket' ? colors.mut : colors.ink
        ctx.globalAlpha = 1 - twinkle
        ctx.beginPath()
        ctx.arc(q.x, q.y, r, 0, Math.PI * 2)
        ctx.fill()
        ctx.globalAlpha = 1
        if (n.label && n.lab) {
          ctx.globalAlpha = Math.max(0, p * 1.2 - 0.2)
          ctx.fillStyle = n.kind === 'hub' ? colors.ink : colors.mut
          ctx.font =
            n.kind === 'hub'
              ? '500 13px system-ui, sans-serif'
              : n.kind === 'bucket'
                ? '600 9px system-ui, sans-serif'
                : '10.5px system-ui, sans-serif'
          const align = q.x > cx + 8 ? 'left' : q.x < cx - 8 ? 'right' : 'center'
          ctx.textAlign = align
          const dx = align === 'left' ? r + 5 : align === 'right' ? -r - 5 : 0
          const tw = ctx.measureText(n.label).width
          let lx = q.x + dx
          if (align === 'left') lx = Math.min(lx, W - 6 - tw)
          else if (align === 'right') lx = Math.max(lx, 6 + tw)
          else lx = Math.min(Math.max(lx, 6 + tw / 2), W - 6 - tw / 2)
          const ly = q.y + (n.kind === 'hub' ? r + 15 : 3.5)
          const x0 = align === 'left' ? lx : align === 'right' ? lx - tw : lx - tw / 2
          const rect = { x0: x0 - 3, y0: ly - 11, x1: x0 + tw + 3, y1: ly + 4 }
          if (n.kind === 'hub' || n.kind === 'bucket' || !overlaps(rect.x0, rect.y0, rect.x1, rect.y1)) {
            drawnLabels.push(rect)
            ctx.fillText(n.label, lx, ly)
          }
          ctx.globalAlpha = 1
        }
      }

      if (running && !still) requestAnimationFrame(draw)
    }
    requestAnimationFrame(draw)
    if (still) {
      const id = window.setTimeout(() => draw(), 120)
      return () => {
        running = false
        window.clearTimeout(id)
      }
    }
    return () => {
      running = false
    }
  // One engine per (model, settled) pair for this mount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled, reduced])

  return <canvas ref={canvasRef} className={className ?? 'h-full w-full text-foreground'} aria-hidden="true" />
})

export default TheaterCanvas
