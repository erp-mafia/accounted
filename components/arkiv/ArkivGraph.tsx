'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import type { ArkivGraph as GraphData, ClusterKey, GraphNode } from '@/app/api/arkiv/graph/route'
import { ARKIV } from './palette'

/**
 * The company's document graph, alive (canvas artboard Arkiv, levande 3D):
 * the blue company hub, four clusters on a ring, documents as small spheres
 * around their cluster, the faint verifikat band, and what waits for a
 * person in terracotta. Drag turns it, the wheel zooms, it drifts on its
 * own once left alone, a point gets its card on hover and opens on click.
 * Still under prefers-reduced-motion. Drawn on a canvas in a 1140 by 440
 * logical frame that scales to the page width.
 */
const W = 1140
const H = 440
const PERSPECTIVE = 760

const CLUSTERS: Record<ClusterKey, { deg: number; r: number; color: string | null }> = {
  avtal: { deg: 200, r: 170, color: ARKIV.sage },
  myndighet: { deg: 290, r: 160, color: ARKIV.ochre },
  motparter: { deg: 350, r: 190, color: null },
  tillgangar: { deg: 110, r: 160, color: null },
}

type NodeKind = 'hub' | 'cluster' | 'doc' | 'band' | 'unknown'
interface Node3 {
  x: number
  y: number
  z: number
  d: number
  kind: NodeKind
  color: string | null
  name: string
  sub: string | null
  count?: number
  cluster?: ClusterKey
  href?: string
}

const rad = (d: number) => (d * Math.PI) / 180

/** Page colours for the canvas, read from the theme tokens so the graph follows light and dark. */
function tokens(): { ink: string; muted: string; hair: string; hairStrong: string; card: string } {
  const style = getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string) => {
    const v = style.getPropertyValue(name).trim()
    if (!v) return fallback
    return /^(#|rgb|hsl|oklch|color)/.test(v) ? v : `hsl(${v})`
  }
  return {
    ink: read('--foreground', '#171717'),
    muted: read('--muted-foreground', '#666666'),
    hair: read('--border', '#dbdad7'),
    hairStrong: read('--border', '#b8b6b1'),
    card: read('--card', '#ffffff'),
  }
}

function build(
  graph: GraphData,
  labels: { documents: string; verifikat: string; held: string; unclassified: string },
): { nodes: Node3[]; edges: Array<[number, number, 'strong' | 'hair']> } {
  const nodes: Node3[] = []
  const edges: Array<[number, number, 'strong' | 'hair']> = []
  const add = (n: Node3) => nodes.push(n) - 1
  const hub = add({ x: 0, y: 0, z: 0, d: 30, kind: 'hub', color: ARKIV.hub, name: graph.company.name, sub: labels.documents })
  for (const cluster of graph.clusters) {
    const c = CLUSTERS[cluster.key]
    const ci = add({
      x: c.r * Math.cos(rad(c.deg)),
      y: 0,
      z: c.r * Math.sin(rad(c.deg)),
      d: 20,
      kind: 'cluster',
      color: c.color,
      name: cluster.key,
      sub: null,
      count: cluster.count,
      cluster: cluster.key,
    })
    edges.push([hub, ci, 'strong'])
    cluster.nodes.forEach((node, i) => {
      const a = rad(c.deg - 70 + (i * 140) / Math.max(cluster.nodes.length - 1, 1))
      const rr = 48 + (i % 2) * 14
      const di = add({
        x: nodes[ci].x + rr * Math.cos(a),
        y: (i % 3) * 14 - 14,
        z: nodes[ci].z + rr * Math.sin(a),
        d: 6,
        kind: 'doc',
        color: c.color,
        name: node.label,
        sub: node.meta,
        cluster: cluster.key,
        href: node.href,
      })
      edges.push([ci, di, 'hair'])
    })
  }
  const band = Math.min(40, Math.max(0, Math.round(graph.verifikat_count / 30)))
  for (let i = 0; i < band; i++) {
    const r = 214 + ((i * 37) % 3) * 6
    add({ x: r * Math.cos(rad(30 + i * 1.3)), y: 22, z: r * Math.sin(rad(30 + i * 1.3)), d: 2.5, kind: 'band', color: null, name: labels.verifikat, sub: null })
  }
  graph.waiting.slice(0, 1).forEach((w) => {
    const u = add({
      x: 180 * Math.cos(rad(262)),
      y: -46,
      z: 180 * Math.sin(rad(262)),
      d: 8,
      kind: 'unknown',
      color: ARKIV.terracotta,
      name: `${w.label} · ${w.meta === 'held' ? labels.held : labels.unclassified}`,
      sub: null,
      href: w.href,
    })
    edges.push([hub, u, 'hair'])
  })
  return { nodes, edges }
}

function lighten(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16)
  const m = (v: number) => Math.round(v + (255 - v) * amount)
  return `rgb(${m(n >> 16)},${m((n >> 8) & 255)},${m(n & 255)})`
}

export function ArkivGraph({ graph }: { graph: GraphData }) {
  const t = useTranslations('arkiv')
  const router = useRouter()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const clusterLabel = (key: ClusterKey) => t(`cluster_${key}` as never)
  const labels = {
    documents: t('graph_documents', { count: graph.company.document_count }),
    verifikat: t('graph_verifikat', { count: graph.verifikat_count }),
    held: t('graph_waiting_held'),
    unclassified: t('graph_waiting_unclassified'),
    open: t('graph_open_hint'),
    items: (n: number) => t('graph_items', { count: n }),
  }

  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const { nodes, edges } = build(graph, labels)
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    let scale = 1
    let phi = -0.3
    let alphaDeg = 32
    let zoom = 1
    let mouse: { x: number; y: number } | null = null
    let hover = -1
    let drag: { x: number; y: number; t: number; moved: number } | null = null
    let vPhi = 0
    let vAlpha = 0
    let idleSince = performance.now()
    let raf = 0
    let dead = false
    let colors = tokens()
    let frame = 0
    const pr: Array<{ x: number; y: number; s: number; z: number }> = new Array(nodes.length)

    const fit = () => {
      const width = wrap.clientWidth
      scale = width / W
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(H * scale * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${H * scale}px`
      ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0)
    }
    fit()
    const observer = new ResizeObserver(() => {
      fit()
      if (reduce) draw()
    })
    observer.observe(wrap)

    const project = (n: Node3, cx: number, cy: number, alpha: number) => {
      const cp = Math.cos(phi),
        sp = Math.sin(phi),
        ca = Math.cos(alpha),
        sa = Math.sin(alpha)
      const x1 = n.x * cp + n.z * sp
      const z1 = -n.x * sp + n.z * cp
      const y2 = n.y * ca - z1 * sa
      const z2 = n.y * sa + z1 * ca
      const s = (zoom * PERSPECTIVE) / (PERSPECTIVE + z2)
      return { x: cx + x1 * s, y: cy - y2 * s, s, z: z2 }
    }
    const depthAlpha = (z: number) => 0.4 + 0.6 * Math.max(0, Math.min(1, (260 - z) / 520))
    const circle = (x: number, y: number, r: number, fill: string | null, alpha: number, stroke: string | null, sphere = false) => {
      ctx.globalAlpha = alpha
      ctx.beginPath()
      ctx.arc(x, y, Math.max(0.5, r), 0, Math.PI * 2)
      if (fill) {
        if (sphere && fill.startsWith('#') && r >= 2.5) {
          const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.15, x, y, r)
          g.addColorStop(0, lighten(fill, 0.55))
          g.addColorStop(1, fill)
          ctx.fillStyle = g
        } else ctx.fillStyle = fill
        ctx.fill()
      }
      if (stroke) {
        ctx.lineWidth = 1.4
        ctx.strokeStyle = stroke
        ctx.stroke()
      }
      ctx.globalAlpha = 1
    }
    const text = (s: string, x: number, y: number, size: number, color: string, align: CanvasTextAlign = 'left', weight = 400) => {
      ctx.font = `${weight} ${size}px ui-sans-serif, system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif`
      ctx.fillStyle = color
      ctx.textAlign = align
      ctx.textBaseline = 'middle'
      ctx.fillText(s, x, y)
    }
    const nodeColor = (n: Node3) => n.color ?? colors.ink

    const draw = () => {
      if (frame++ % 60 === 0) colors = tokens()
      const cx = W * 0.46,
        cy = H * 0.5,
        alpha = rad(alphaDeg)
      ctx.clearRect(0, 0, W, H)
      for (let i = 0; i < nodes.length; i++) pr[i] = project(nodes[i], cx, cy, alpha)
      hover = -1
      if (mouse && !drag) {
        let best = 14
        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i]
          if (n.kind !== 'doc' && n.kind !== 'unknown' && n.kind !== 'cluster') continue
          const d = Math.hypot(pr[i].x - mouse.x, pr[i].y - mouse.y)
          if (d < best) {
            best = d
            hover = i
          }
        }
      }
      canvas.style.cursor = drag ? 'grabbing' : hover >= 0 && nodes[hover].href ? 'pointer' : 'grab'
      const hoverCluster = hover >= 0 ? (nodes[hover].cluster ?? null) : null
      for (const [a, b, kind] of edges) {
        const A = pr[a],
          B = pr[b]
        const lit = hover >= 0 && (b === hover || a === hover)
        ctx.globalAlpha = lit ? 0.9 : Math.min(depthAlpha(A.z), depthAlpha(B.z))
        ctx.strokeStyle = lit ? colors.ink : kind === 'strong' ? colors.hairStrong : colors.hair
        ctx.lineWidth = lit || kind === 'strong' ? 1.2 : 1
        ctx.beginPath()
        ctx.moveTo(A.x, A.y)
        ctx.lineTo(B.x, B.y)
        ctx.stroke()
        ctx.globalAlpha = 1
      }
      const order = nodes.map((_, i) => i).sort((i, j) => pr[j].z - pr[i].z)
      for (const i of order) {
        const n = nodes[i],
          p = pr[i],
          al = depthAlpha(p.z)
        if (n.kind === 'hub') {
          const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 64)
          g.addColorStop(0, ARKIV.hubGlow)
          g.addColorStop(1, 'rgba(0,0,0,0)')
          ctx.fillStyle = g
          ctx.fillRect(p.x - 64, p.y - 64, 128, 128)
          circle(p.x, p.y, (n.d * p.s) / 2, ARKIV.hub, 1, null, true)
          text(n.name, p.x, p.y + 28 * p.s, 12.5, colors.ink, 'center', 500)
          if (n.sub) text(n.sub, p.x, p.y + 44, 11, colors.muted, 'center')
        } else if (n.kind === 'cluster') {
          const dim = hoverCluster != null && hoverCluster !== n.cluster
          circle(p.x, p.y, (n.d * p.s) / 2, colors.card, dim ? 0.55 : al, nodeColor(n), true)
          text(clusterLabel(n.cluster as ClusterKey), p.x, p.y - 20 * p.s, 12, dim ? colors.muted : colors.ink, 'center', 500)
          text(String(n.count ?? 0), p.x, p.y + 20 * p.s, 11, colors.muted, 'center')
        } else if (n.kind === 'doc') {
          const dim = hoverCluster != null && hoverCluster !== n.cluster,
            isH = i === hover
          if (isH) circle(p.x, p.y, 10.5 * p.s, ARKIV.sageGlow, 1, null)
          circle(p.x, p.y, (isH ? 5.5 : n.d / 2) * p.s, nodeColor(n), isH ? 1 : dim ? 0.3 : al * 0.95, null, true)
        } else if (n.kind === 'band') {
          circle(p.x, p.y, (n.d * p.s) / 2, colors.hairStrong, al, null)
        } else if (n.kind === 'unknown') {
          circle(p.x, p.y, 7 * p.s, ARKIV.terracottaGlow, 1, null)
          circle(p.x, p.y, (n.d * p.s) / 2, ARKIV.terracotta, 1, null, true)
          text(n.name, p.x + 12, p.y, 11.5, ARKIV.terracotta, 'left')
        }
      }
      const bandNode = nodes.find((n) => n.kind === 'band')
      if (bandNode) {
        const p = pr[nodes.indexOf(bandNode)]
        text(bandNode.name, p.x + 10, p.y, 11, colors.muted, 'left')
      }
      if (hover >= 0) {
        const n = nodes[hover],
          p = pr[hover]
        const line1 = n.kind === 'cluster' ? labels.items(n.count ?? 0) : n.cluster ? `${clusterLabel(n.cluster)}${n.sub ? ` · ${n.sub}` : ''}` : (n.sub ?? '')
        const line2 = n.href ? labels.open : ''
        const w = 236,
          h = line2 ? 66 : 50
        const left = p.x >= cx && p.x + 18 + w <= W - 4 ? p.x + 18 : p.x - 18 - w
        const top = Math.min(Math.max(8, p.y + 16), H - h - 8)
        ctx.save()
        ctx.shadowColor = 'rgba(0,0,0,0.10)'
        ctx.shadowBlur = 24
        ctx.shadowOffsetY = 8
        ctx.fillStyle = colors.card
        ctx.beginPath()
        ctx.roundRect(left, top, w, h, 8)
        ctx.fill()
        ctx.restore()
        ctx.strokeStyle = colors.hair
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.roundRect(left + 0.5, top + 0.5, w - 1, h - 1, 8)
        ctx.stroke()
        const title = n.kind === 'cluster' ? clusterLabel(n.cluster as ClusterKey) : n.name
        text(title.length > 34 ? `${title.slice(0, 33)}…` : title, left + 14, top + 16, 13, colors.ink, 'left', 500)
        text(line1.length > 40 ? `${line1.slice(0, 39)}…` : line1, left + 14, top + 34, 11.5, colors.muted, 'left')
        if (line2) text(line2, left + 14, top + 50, 11.5, colors.ink, 'left')
      }
    }

    const clampTilt = (v: number) => Math.max(8, Math.min(80, v))
    const step = () => {
      if (dead) return
      if (!drag) {
        if (Math.abs(vPhi) > 0.00005 || Math.abs(vAlpha) > 0.003) {
          phi += vPhi
          alphaDeg = clampTilt(alphaDeg + vAlpha)
          vPhi *= 0.94
          vAlpha *= 0.94
        } else if (!reduce && hover < 0 && performance.now() - idleSince > 3000) phi += 0.0022
      }
      draw()
      raf = requestAnimationFrame(step)
    }
    const toLocal = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect()
      return { x: (e.clientX - r.left) * (W / r.width), y: (e.clientY - r.top) * (H / r.height) }
    }
    const onDown = (e: PointerEvent) => {
      drag = { x: e.clientX, y: e.clientY, t: performance.now(), moved: 0 }
      vPhi = 0
      vAlpha = 0
      canvas.setPointerCapture(e.pointerId)
      idleSince = performance.now()
    }
    const onMove = (e: PointerEvent) => {
      mouse = toLocal(e)
      idleSince = performance.now()
      if (!drag) {
        if (reduce) draw()
        return
      }
      const dx = e.clientX - drag.x,
        dy = e.clientY - drag.y,
        now = performance.now(),
        dt = Math.max(1, now - drag.t)
      phi += dx * 0.006
      alphaDeg = clampTilt(alphaDeg + dy * 0.35)
      vPhi = dx * 0.006 * Math.min(1, 16 / dt)
      vAlpha = dy * 0.35 * Math.min(1, 16 / dt)
      drag = { x: e.clientX, y: e.clientY, t: now, moved: drag.moved + Math.abs(dx) + Math.abs(dy) }
      if (reduce) draw()
    }
    const onUp = (e: PointerEvent) => {
      const moved = drag?.moved ?? 0
      drag = null
      idleSince = performance.now()
      if (reduce) {
        vPhi = 0
        vAlpha = 0
      }
      // A click, not a drag: open what is under the pointer.
      if (moved < 4) {
        mouse = toLocal(e)
        draw()
        const href = hover >= 0 ? nodes[hover].href : undefined
        if (href) router.push(href)
      }
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      zoom = Math.max(0.6, Math.min(1.8, zoom * (e.deltaY < 0 ? 1.08 : 0.92)))
      idleSince = performance.now()
      if (reduce) draw()
    }
    const onLeave = () => {
      mouse = null
      if (!drag) idleSince = performance.now()
      if (reduce) draw()
    }
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onUp)
    canvas.addEventListener('pointerleave', onLeave)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.style.touchAction = 'none'
    canvas.style.userSelect = 'none'
    if (reduce) draw()
    else step()
    return () => {
      dead = true
      cancelAnimationFrame(raf)
      observer.disconnect()
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
      canvas.removeEventListener('pointerleave', onLeave)
      canvas.removeEventListener('wheel', onWheel)
    }
    // Labels are derived from the same graph and translations; the graph is the only input that changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, router])

  return (
    <div className="mb-4 w-full space-y-2">
      <div ref={wrapRef} className="w-full">
        <canvas ref={canvasRef} className="block" role="img" aria-label={t('home_title')} />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-muted-foreground">
        <Legend color={ARKIV.hub} label={t('graph_legend_company')} />
        <Legend color={ARKIV.sage} label={t('graph_legend_agreements')} />
        <Legend color={ARKIV.ochre} label={t('graph_legend_authority')} />
        <Legend color="var(--foreground)" label={t('graph_legend_parties')} />
        <Legend color={ARKIV.terracotta} label={t('graph_legend_waiting')} />
        <span className="ml-auto">{t('graph_hint')}</span>
      </div>
      <ul className="sr-only">{graph.clusters.flatMap((c) => c.nodes.map((n: GraphNode) => <li key={n.id}>{n.label}</li>))}</ul>
    </div>
  )
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span>
      <i className="mr-1.5 inline-block h-[7px] w-[7px] rounded-full align-middle" style={{ background: color }} />
      {label}
    </span>
  )
}
