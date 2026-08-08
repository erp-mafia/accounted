'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import type { ImportPreview } from '@/lib/import/types'
import type { TheaterBucket, TheaterModel } from '@/lib/import/theater-model'

/**
 * The import theater: while the SIE import commits server-side (one opaque
 * call, up to ~5 minutes), the client-parsed file drives a knowledge graph
 * that draws itself: the company as hub, fiscal years as tree rings, account
 * classes as anchors, top accounts and recognized counterparties as an ink
 * constellation. Narration lines pace alongside; the final line holds with
 * the elapsed counter until the server answers, so the animation never
 * pretends to know more than the import does.
 *
 * Ink-on-paper: colors come from the app tokens per frame (theme/palette
 * reactive, same idiom as JourneyOrb). Reduced motion renders the settled
 * graph and all narration instantly.
 */

interface ImportTheaterProps {
  model: TheaterModel
  preview: ImportPreview
  /** Elapsed seconds since execute started (owned by ImportReviewStep). */
  elapsed: number
}

const BUCKET_ANGLE: Record<TheaterBucket, number> = {
  tillgangar: 0.31,   // right, slightly down
  skulder: 1.62,      // bottom
  intakter: -0.92,    // upper right
  kostnader: 2.75,    // left
}
const BUCKET_LABEL: Record<TheaterBucket, string> = {
  tillgangar: 'TILLGÅNGAR',
  skulder: 'SKULDER',
  intakter: 'INTÄKTER',
  kostnader: 'KOSTNADER',
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
  kind: 'hub' | 'ring' | 'bucket' | 'account' | 'counterparty'
  x: number
  y: number
  r: number
  ring?: number
  label?: string
  lab?: boolean
  bucket?: TheaterBucket
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

function buildEngine(model: TheaterModel, reduced: boolean): Engine {
  const nodes: Node[] = []
  const edges: { a: string; b: string }[] = []
  nodes.push({ id: 'hub', kind: 'hub', x: 0, y: 0, r: 7, label: model.companyName, lab: true, wave: 0, born: null })
  model.years.forEach((y, i) => {
    nodes.push({ id: `ring${i}`, kind: 'ring', x: 0, y: 0, r: 0, ring: 58 + i * 24, label: y.start.slice(0, 4), wave: 0, born: null })
  })
  const present = new Set(model.buckets.map((b) => b.id))
  for (const bucket of present) {
    const p = BUCKET_ANGLE[bucket]
    nodes.push({ id: bucket, kind: 'bucket', x: Math.cos(p) * 148, y: Math.sin(p) * 148, r: 2.2, label: BUCKET_LABEL[bucket], lab: true, wave: 0, born: null })
    edges.push({ a: 'hub', b: bucket })
  }
  const maxAccountWeight = Math.max(1, ...model.accounts.map((a) => a.weight))
  model.accounts.forEach((a, i) => {
    const base = BUCKET_ANGLE[a.bucket]
    const spread = (rand01(a.number) - 0.5) * 0.9
    const rad = 192 + rand01(a.number + 'r') * 40
    nodes.push({
      id: a.number,
      kind: 'account',
      x: Math.cos(base + spread) * rad,
      y: Math.sin(base + spread) * rad,
      r: 2.4 + (a.weight / maxAccountWeight) * 3.4,
      label: `${a.number} ${a.name}`.trim(),
      lab: i < 8,
      bucket: a.bucket,
      wave: i % 4,
      born: null,
    })
    edges.push({ a: a.bucket, b: a.number })
  })
  const maxCpWeight = Math.max(1, ...model.counterparties.map((c) => c.weight))
  model.counterparties.forEach((c, i) => {
    const anchor = nodes.find((n) => n.id === c.account)
    const base = anchor ? Math.atan2(anchor.y, anchor.x) : BUCKET_ANGLE.kostnader
    const spread = (rand01(c.name) - 0.5) * 0.5
    const rad = 262 + rand01(c.name + 'r') * 38
    nodes.push({
      id: `cp${i}`,
      kind: 'counterparty',
      x: Math.cos(base + spread) * rad,
      y: Math.sin(base + spread) * rad,
      r: 1.8 + (c.weight / maxCpWeight) * 2.4,
      label: c.name,
      lab: i < 7,
      wave: i % 3,
      born: null,
    })
    if (anchor) edges.push({ a: c.account, b: `cp${i}` })
  })
  const now = typeof performance !== 'undefined' ? performance.now() : 0
  if (reduced) for (const n of nodes) n.born = now - 10_000
  return { nodes, edges, stream: [], feedUntil: 0, pulse: 0, cam: reduced ? 1 : 1.45 }
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

export default function ImportTheater({ model, preview, elapsed }: ImportTheaterProps) {
  const t = useTranslations('import')
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const engineRef = useRef<Engine | null>(null)
  const [lineCount, setLineCount] = useState(0)
  const [voucherTick, setVoucherTick] = useState(0)

  const reduced =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches

  const lines: { title: string; sub: string | null; ok?: boolean; warn?: boolean }[] = [
    {
      title: t('theater_reading', { company: model.companyName || preview.companyName || '' }),
      sub: t('theater_years', { count: Math.max(model.years.length, 1) }),
      ok: true,
    },
    {
      title: t('theater_vouchers'),
      sub: `${voucherTick.toLocaleString('sv-SE')} ${t('theater_vouchers_unit')}`,
    },
    {
      title: t('theater_accounts'),
      sub: t('theater_accounts_sub', {
        mapped: preview.mappingStatus.mapped,
        total: preview.mappingStatus.total,
      }),
    },
    ...(model.totalCounterparties > 0
      ? [{
          title: t('theater_counterparties'),
          sub: t('theater_counterparties_sub', { count: model.totalCounterparties }),
        }]
      : []),
    {
      title: t('theater_balance'),
      sub: preview.trialBalance.isBalanced ? t('theater_balance_ok') : t('theater_balance_warn'),
      ok: preview.trialBalance.isBalanced,
      warn: !preview.trialBalance.isBalanced,
    },
  ]
  const holdingVisible = lineCount > lines.length

  // Narration pacing + graph spawn hooks. Spawn assignments live here so the
  // narration and the constellation always agree on what has "happened".
  useEffect(() => {
    const engine = buildEngine(model, reduced)
    engineRef.current = engine
    const spawn = (f: (n: Node) => boolean) => {
      const now = performance.now()
      for (const n of engine.nodes) if (n.born == null && f(n)) n.born = now
    }
    spawn((n) => n.kind === 'hub')
    if (reduced) {
      setLineCount(lines.length + 1)
      setVoucherTick(preview.voucherCount)
      return
    }
    const timers: number[] = []
    const at = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, ms))
    const counterLine = 1
    const cpLine = model.totalCounterparties > 0 ? 3 : -1
    const balanceLine = model.totalCounterparties > 0 ? 4 : 3
    at(300, () => {
      setLineCount(1)
      spawn((n) => n.kind === 'ring')
    })
    at(1500, () => {
      setLineCount(counterLine + 1)
      spawn((n) => n.kind === 'bucket')
      engine.feedUntil = performance.now() + 2100
      ;[0, 1, 2, 3].forEach((w) =>
        timers.push(window.setTimeout(() => spawn((n) => n.kind === 'account' && n.wave === w), 200 + w * 420))
      )
      const t0 = performance.now()
      const tick = () => {
        const p = Math.min(1, (performance.now() - t0) / 1600)
        setVoucherTick(Math.round(preview.voucherCount * p))
        if (p < 1) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    at(3400, () => setLineCount(3))
    if (cpLine > 0) {
      at(4600, () => {
        setLineCount(cpLine + 1)
        ;[0, 1, 2].forEach((w) =>
          timers.push(window.setTimeout(() => spawn((n) => n.kind === 'counterparty' && n.wave === w), 120 + w * 420))
        )
      })
    }
    at(cpLine > 0 ? 6000 : 4600, () => {
      setLineCount(balanceLine + 1)
      engine.pulse = performance.now()
    })
    at(cpLine > 0 ? 7100 : 5700, () => setLineCount(lines.length + 1))
    return () => timers.forEach((id) => window.clearTimeout(id))
  // The theater runs once per mount for one (model, preview) pair.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Canvas render loop (refs only; React never sees per-frame state).
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let running = true
    const draw = () => {
      const engine = engineRef.current
      if (!canvas.isConnected || !engine) return
      const wrap = canvas.parentElement
      if (!wrap) return
      const W = wrap.clientWidth
      const H = wrap.clientHeight
      if (!W || !H) {
        if (running && !reduced) requestAnimationFrame(draw)
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
      const camTarget = reduced ? 1 : 1.45 - 0.45 * Math.min(1, born / (engine.nodes.length * 0.85))
      engine.cam += (camTarget - engine.cam) * (reduced ? 1 : 0.05)
      const k = (Math.min(W, H) / 640) * engine.cam
      const cx = W / 2
      const cy = H / 2
      const pos = (n: Node) => ({ x: cx + n.x * k, y: cy + n.y * k })
      const age = (n: Node) =>
        n.born == null ? 0 : Math.min(1, (now - n.born) / (reduced ? 1 : n.kind === 'ring' ? 900 : 420))
      const ease = (v: number) => 1 - Math.pow(1 - v, 3)
      const byId = new Map(engine.nodes.map((n) => [n.id, n]))

      for (const n of engine.nodes) {
        if (n.kind !== 'ring' || n.born == null) continue
        const p = ease(age(n))
        const rad = (n.ring ?? 0) * k
        ctx.strokeStyle = colors.hair
        ctx.globalAlpha = 0.75 * p
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
        ctx.strokeStyle = colors.hair
        ctx.lineWidth = 0.8
        ctx.globalAlpha = 0.65
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

      for (const n of engine.nodes) {
        if (n.born == null || n.kind === 'ring') continue
        const p = ease(age(n))
        const q = pos(n)
        const breathe = reduced ? 0 : Math.sin(now / 2600 + n.x + n.y) * 0.06
        const splat = p < 1 ? 1 + 0.3 * Math.sin(p * Math.PI) : 1
        const r = n.r * (1 + breathe) * p * k * 1.55 * splat
        ctx.fillStyle = n.kind === 'bucket' ? colors.mut : colors.ink
        ctx.beginPath()
        ctx.arc(q.x, q.y, r, 0, Math.PI * 2)
        ctx.fill()
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
          ctx.fillText(n.label, lx, q.y + (n.kind === 'hub' ? r + 15 : 3.5))
          ctx.globalAlpha = 1
        }
      }

      if (running && !reduced) requestAnimationFrame(draw)
    }
    requestAnimationFrame(draw)
    if (reduced) {
      // A couple of extra frames so layout settles, then hold the still.
      const id = window.setTimeout(() => draw(), 120)
      return () => {
        running = false
        window.clearTimeout(id)
      }
    }
    return () => {
      running = false
    }
  }, [reduced])

  return (
    <div className="grid gap-6 md:grid-cols-[280px_1fr]">
      <div role="status" aria-live="polite">
        <ol className="space-y-0">
          {lines.map((line, i) => {
            const visible = lineCount > i
            const active = lineCount === i + 1 && !holdingVisible
            return (
              <li
                key={line.title}
                className={`border-b border-border/60 py-2.5 transition-opacity duration-500 last:border-b-0 ${
                  visible ? 'opacity-100' : 'opacity-0'
                }`}
              >
                <p className="text-sm">{line.title}</p>
                <p
                  className={`mt-0.5 min-h-4 text-xs tabular-nums ${
                    visible && line.ok && !active
                      ? 'text-success'
                      : visible && line.warn
                        ? 'text-warning'
                        : 'text-muted-foreground'
                  }`}
                >
                  {visible ? line.sub : null}
                </p>
              </li>
            )
          })}
        </ol>
        {holdingVisible && (
          <p className="mt-4 text-xs text-muted-foreground tabular-nums">
            {t('theater_writing')} {elapsed}s
          </p>
        )}
      </div>
      <div className="relative min-h-[340px] md:min-h-[420px]">
        <canvas ref={canvasRef} className="h-full w-full text-foreground" aria-hidden="true" />
      </div>
    </div>
  )
}
