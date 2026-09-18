'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import type { ForceGraph3DInstance } from '3d-force-graph'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn, formatCurrency } from '@/lib/utils'
import type { ClusterId, CompanyGraph, GraphLink, GraphNode, LinkKind } from '@/lib/arkiv/graph/types'

/**
 * Företagshjärnan (canvas artboard Arkiv, the home): the company graph as
 * eight neighbourhoods on a ring, drawn in three dimensions. Every node is a
 * record the app already has a page for; every link is a foreign key, a
 * match the pipeline made, or a sum with its evidence. Click a cluster to
 * see only it, click a node to see what it hangs together with across the
 * clusters, open the record from the card. The data is the same snapshot an
 * agent reads through Accounted://arkiv/graph.
 */
const CLUSTERS: ClusterId[] = ['ledger', 'party', 'agreement', 'document', 'fact', 'person', 'authority', 'upcoming']
const COLORS: Record<ClusterId, string> = {
  ledger: '#3d6bb3',
  party: '#5f6c7b',
  agreement: '#4d806a',
  document: '#8a7f6a',
  fact: '#c69239',
  person: '#8a5a9a',
  authority: '#a6574e',
  upcoming: '#2e6a4e',
}
const HUB = 'hub:'
const RING = 190
const CAMERA = { x: 0, y: 90, z: 640 }

type Node3 = { id: string; cluster: ClusterId; name: string; w: number; node: GraphNode | null; dim: boolean; x?: number; y?: number; z?: number; vx?: number; vy?: number; vz?: number }
type Link3 = { source: string | Node3; target: string | Node3; kind: LinkKind | 'hub'; evidence?: Record<string, unknown> }

const idOf = (end: string | Node3) => (typeof end === 'object' ? end.id : end)

/** Where a node's record lives in the app; null when the node is a fold or has no page of its own. */
export function hrefFor(node: GraphNode, graph: CompanyGraph): string | null {
  const id = node.ref.slice(node.ref.indexOf(':') + 1)
  switch (node.kind) {
    case 'agreement':
      return `/arkiv/avtal/${id}`
    case 'document':
      return `/arkiv/dokument/${id}`
    case 'party':
      return `/parties/${id}`
    case 'person':
      return `/salary/employees/${id}`
    case 'fact':
    case 'authority':
      return '/arkiv/myndighet'
    case 'account':
      return `/reports/general-ledger?account=${encodeURIComponent(String(node.meta.account ?? id))}`
    case 'deadline':
      return '/deadlines'
    case 'expected':
      return '/arkiv/granska#fynd'
    case 'obligation': {
      const l = graph.links.find((x) => x.kind === 'upcoming' && x.target === node.ref)
      return l ? `/arkiv/avtal/${l.source.slice(l.source.indexOf(':') + 1)}` : null
    }
    case 'parties_folded':
      return '/parties'
    default:
      return null
  }
}

/** A weight becomes a sphere size: logarithmic, so a 500 000 kr loan and a 349 kr receipt both fit the same picture. */
const sizeOf = (weight: number) => Math.max(1.6, Math.min(9, 1.6 + Math.log10(1 + Math.max(0, weight)) * 1.3))

const isInactive = (n: GraphNode) => n.kind === 'party' && n.meta.active === false

function supportsWebGL(): boolean {
  try {
    const c = document.createElement('canvas')
    return !!(window.WebGLRenderingContext && (c.getContext('webgl') || c.getContext('experimental-webgl')))
  } catch {
    return false
  }
}

export default function Brain() {
  const t = useTranslations('arkiv')
  const [graph, setGraph] = useState<CompanyGraph | null>(null)
  const [failed, setFailed] = useState(false)
  const [drawError, setDrawError] = useState<string | null>(null)
  const [focus, setFocus] = useState<ClusterId | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [layout, setLayout] = useState<'cluster' | 'free'>('cluster')
  const [labels, setLabels] = useState<'hub' | 'all'>('hub')
  const wrapRef = useRef<HTMLDivElement>(null)
  const graphRef = useRef<ForceGraph3DInstance | null>(null)
  const labelLayerRef = useRef<HTMLDivElement | null>(null)
  const labelElsRef = useRef<Map<string, HTMLDivElement>>(new Map())
  const stateRef = useRef({ focus, selected, layout, labels, ready: false })
  stateRef.current = { ...stateRef.current, focus, selected, layout, labels }

  useEffect(() => {
    let cancelled = false
    fetch('/api/arkiv/brain')
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status))
        const { data } = (await res.json()) as { data: CompanyGraph }
        if (!cancelled) setGraph(data)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const clusterLabel = useCallback((c: ClusterId) => t(`brain_cluster_${c}` as never), [t])
  const byRef = useMemo(() => new Map((graph?.nodes ?? []).map((n) => [n.ref, n])), [graph])
  const centers = useMemo(() => {
    const out = {} as Record<ClusterId, { x: number; y: number; z: number }>
    CLUSTERS.forEach((c, i) => {
      const a = (i / CLUSTERS.length) * Math.PI * 2
      out[c] = { x: Math.cos(a) * RING, y: Math.sin(a) * (RING * 0.63), z: Math.sin(a * 2) * 60 }
    })
    return out
  }, [])

  // The picture: one hub per cluster, every record hanging off its hub, and the graph's own links across.
  const data = useMemo(() => {
    if (!graph) return null
    const nodes: Node3[] = CLUSTERS.map((c) => ({ id: `${HUB}${c}`, cluster: c, name: clusterLabel(c), w: 12, node: null, dim: false }))
    for (const n of graph.nodes) nodes.push({ id: n.ref, cluster: n.cluster, name: isInactive(n) ? `${n.label} (${t('brain_former')})` : n.label, w: sizeOf(n.weight), node: n, dim: isInactive(n) })
    const links: Link3[] = graph.nodes.map((n) => ({ source: `${HUB}${n.cluster}`, target: n.ref, kind: 'hub' as const }))
    for (const l of graph.links) links.push({ source: l.source, target: l.target, kind: l.kind, evidence: l.evidence })
    return { nodes, links }
  }, [graph, clusterLabel, t])

  const neighbours = useCallback(
    (ref: string): Map<string, GraphLink> => {
      const out = new Map<string, GraphLink>()
      for (const l of graph?.links ?? []) {
        if (l.source === ref) out.set(l.target, l)
        else if (l.target === ref) out.set(l.source, l)
      }
      return out
    },
    [graph],
  )

  // Draw once the data is there; everything after that is restyling.
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap || !data) return
    let disposed = false
    let raf = 0
    const probe = (cls: string, prop: 'color' | 'backgroundColor' | 'borderColor') => {
      const el = document.createElement('span')
      el.className = cls
      el.style.display = 'none'
      wrap.appendChild(el)
      const v = getComputedStyle(el)[prop]
      el.remove()
      return v
    }
    const theme = () => ({
      bg: probe('bg-background', 'backgroundColor'),
      ink: probe('text-foreground', 'color'),
      muted: probe('text-muted-foreground', 'color'),
      dim: probe('text-muted-foreground/40', 'color'),
      link: probe('border-border', 'borderColor'),
    })
    let colors = theme()
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const st = stateRef

    const visible = (n: Node3) => !st.current.focus || n.cluster === st.current.focus || (!!st.current.selected && (n.id === st.current.selected || neighbours(st.current.selected).has(n.id)))
    const colorOf = (n: Node3) => {
      const own = n.dim ? colors.dim : COLORS[n.cluster]
      if (st.current.selected) return n.id === st.current.selected || neighbours(st.current.selected).has(n.id) ? own : colors.dim
      return visible(n) ? own : colors.dim
    }
    const linkColor = (l: Link3) => {
      const s = idOf(l.source)
      const tg = idOf(l.target)
      if (st.current.selected) return s === st.current.selected || tg === st.current.selected ? colors.muted : 'rgba(0,0,0,0)'
      if (st.current.focus) {
        const a = (byRef.get(s)?.cluster ?? (s.startsWith(HUB) ? (s.slice(HUB.length) as ClusterId) : null)) === st.current.focus
        const b = (byRef.get(tg)?.cluster ?? (tg.startsWith(HUB) ? (tg.slice(HUB.length) as ClusterId) : null)) === st.current.focus
        return a && b ? colors.muted : a || b ? colors.link : 'rgba(0,0,0,0)'
      }
      return l.kind === 'hub' ? colors.link : colors.muted
    }
    const linkWidth = (l: Link3) => (l.kind === 'hub' ? 0.3 : l.kind === 'posting' || l.kind === 'matched' ? 1.2 : 0.8)

    const clusterForce = () => {
      let nodes: Node3[] = []
      const f = (alpha: number) => {
        const k = st.current.layout === 'cluster' ? 0.09 : 0.015
        for (const n of nodes) {
          const c = centers[n.cluster]
          if (!c || n.x == null || n.y == null || n.z == null) continue
          n.vx = (n.vx ?? 0) + (c.x - n.x) * k * alpha
          n.vy = (n.vy ?? 0) + (c.y - n.y) * k * alpha
          n.vz = (n.vz ?? 0) + (c.z - n.z) * k * alpha
        }
      }
      f.initialize = (ns: Node3[]) => {
        nodes = ns
      }
      return f
    }

    const restyle = () => {
      const g = graphRef.current
      if (!g) return
      g.nodeColor(g.nodeColor()).nodeVal(g.nodeVal()).linkColor(g.linkColor()).linkWidth(g.linkWidth()).linkDirectionalParticles(g.linkDirectionalParticles())
    }
    ;(wrap as HTMLDivElement & { __restyle?: () => void }).__restyle = restyle

    const wantLabel = (n: Node3) => {
      if (n.id.startsWith(HUB)) return !st.current.focus || n.cluster === st.current.focus
      if (st.current.selected) return n.id === st.current.selected || neighbours(st.current.selected).has(n.id)
      if (st.current.labels === 'all') return !st.current.focus || n.cluster === st.current.focus
      return !!st.current.focus && n.cluster === st.current.focus
    }
    const labelLoop = () => {
      const g = graphRef.current
      const layer = labelLayerRef.current
      if (!g || !layer || disposed) return
      for (const n of g.graphData().nodes as Node3[]) {
        let el = labelElsRef.current.get(n.id)
        if (!wantLabel(n) || n.x == null || n.y == null || n.z == null) {
          if (el) el.style.display = 'none'
          continue
        }
        if (!el) {
          el = document.createElement('div')
          el.className = cn('pointer-events-none absolute -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-sm px-1.5 py-0.5 text-[11px] leading-tight', n.id.startsWith(HUB) ? 'font-medium uppercase tracking-[0.08em]' : '')
          el.style.background = colors.bg
          el.style.color = n.id.startsWith(HUB) ? colors.ink : colors.muted
          el.textContent = n.name
          layer.appendChild(el)
          labelElsRef.current.set(n.id, el)
        }
        const p = g.graph2ScreenCoords(n.x, n.y, n.z)
        if (!p || p.z > 1 || p.x < -40 || p.y < -20 || p.x > wrap.clientWidth + 40 || p.y > wrap.clientHeight + 20) {
          el.style.display = 'none'
          continue
        }
        el.style.display = 'block'
        el.style.left = `${p.x}px`
        el.style.top = `${p.y - 6 - Math.cbrt(n.w) * 4}px`
      }
      raf = requestAnimationFrame(labelLoop)
    }

    const draw = async () => {
      if (!supportsWebGL()) {
        setDrawError(t('brain_no_webgl'))
        return
      }
      const { default: ForceGraph3D } = await import('3d-force-graph')
      if (disposed) return
      const seeded = {
        nodes: data.nodes.map((n) => {
          const c = centers[n.cluster]
          return { ...n, x: c.x + (Math.random() - 0.5) * 40, y: c.y + (Math.random() - 0.5) * 40, z: c.z + (Math.random() - 0.5) * 40 }
        }),
        links: data.links.map((l) => ({ ...l })),
      }
      const g = new ForceGraph3D(wrap)
        .width(wrap.clientWidth)
        .height(wrap.clientHeight)
        .backgroundColor(colors.bg)
        .showNavInfo(false)
        .graphData(seeded)
        .nodeVal((n) => ((n as Node3).dim || colorOf(n as Node3) === colors.dim ? (n as Node3).w * 0.45 : (n as Node3).w))
        .nodeColor((n) => colorOf(n as Node3))
        .nodeOpacity(0.95)
        .nodeResolution(18)
        .nodeLabel(() => '')
        .linkColor((l) => linkColor(l as Link3))
        .linkWidth((l) => linkWidth(l as Link3))
        .linkOpacity(0.9)
        .linkDirectionalParticles((l) => {
          const link = l as Link3
          if (reduce || (link.kind !== 'posting' && link.kind !== 'matched')) return 0
          if (!st.current.focus || st.current.selected) return 2
          const s = byRef.get(idOf(link.source))?.cluster
          const tg = byRef.get(idOf(link.target))?.cluster
          return s === st.current.focus || tg === st.current.focus ? 2 : 0
        })
        .linkDirectionalParticleWidth(1.3)
        .linkDirectionalParticleSpeed(0.005)
        .linkDirectionalParticleColor((l) => COLORS[byRef.get(idOf((l as Link3).source))?.cluster ?? 'ledger'])
        .onNodeHover((n) => {
          wrap.style.cursor = n ? 'pointer' : ''
        })
        .onNodeClick((n) => {
          const node = n as Node3
          if (node.id.startsWith(HUB)) setFocus((cur) => (cur === node.cluster ? null : node.cluster))
          else setSelected(node.id)
          if (!node.id.startsWith(HUB)) setFocus(null)
        })
        .onBackgroundClick(() => {
          setSelected(null)
          setFocus(null)
        })
        .onEngineTick(() => {
          st.current.ready = true
        })
      g.d3Force('charge')?.strength(-70)
      g.d3Force('link')?.distance((l: Link3) => (l.kind === 'hub' ? 26 : byRef.get(idOf(l.source))?.cluster === byRef.get(idOf(l.target))?.cluster ? 30 : 110))
      g.d3Force('cluster', clusterForce() as never)
      g.cameraPosition(CAMERA, { x: 0, y: 0, z: 0 }, 0)
      graphRef.current = g
      // The renderer wipes its container on start, so the label layer is added afterwards.
      const layer = document.createElement('div')
      layer.className = 'pointer-events-none absolute inset-0 overflow-hidden'
      wrap.appendChild(layer)
      labelLayerRef.current = layer
      labelElsRef.current = new Map()
      raf = requestAnimationFrame(labelLoop)
    }
    draw().catch(() => {
      if (!disposed) setDrawError(t('brain_failed'))
    })

    const ro = new ResizeObserver(() => {
      const g = graphRef.current
      if (g && wrap.clientWidth > 0 && wrap.clientHeight > 0) g.width(wrap.clientWidth).height(wrap.clientHeight)
    })
    ro.observe(wrap)
    const retheme = () => {
      colors = theme()
      graphRef.current?.backgroundColor(colors.bg)
      for (const el of labelElsRef.current.values()) el.style.background = colors.bg
      restyle()
    }
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', retheme)
    const mo = new MutationObserver(retheme)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] })

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      ro.disconnect()
      mq.removeEventListener('change', retheme)
      mo.disconnect()
      graphRef.current?._destructor?.()
      graphRef.current = null
      labelLayerRef.current = null
      labelElsRef.current = new Map()
      wrap.replaceChildren()
    }
    // The graph is drawn once per dataset; focus, selection, layout and labels restyle it below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  // Focus, selection and layout changes restyle the drawing and move the camera; no redraw.
  useEffect(() => {
    const g = graphRef.current
    const wrap = wrapRef.current as (HTMLDivElement & { __restyle?: () => void }) | null
    if (!g || !wrap) return
    wrap.__restyle?.()
    if (layout && stateRef.current.ready) g.d3ReheatSimulation()
    if (selected) {
      const n = (g.graphData().nodes as Node3[]).find((x) => x.id === selected)
      if (n && n.x != null && n.y != null && n.z != null) {
        const r = Math.hypot(n.x, n.y, n.z) || 1
        const k = 1 + 170 / r
        g.cameraPosition({ x: n.x * k, y: n.y * k + 20, z: n.z * k + 120 }, { x: n.x, y: n.y, z: n.z }, 900)
      }
    } else if (focus) {
      const c = centers[focus]
      const r = Math.hypot(c.x, c.y, c.z) || 1
      const k = 1 + 260 / r
      g.cameraPosition({ x: c.x * k, y: c.y * k + 40, z: c.z * k + 200 }, c, 900)
    } else {
      g.cameraPosition(CAMERA, { x: 0, y: 0, z: 0 }, 900)
    }
  }, [focus, selected, layout, labels, centers])

  const counts = useMemo(() => {
    const out = {} as Record<ClusterId, number>
    for (const c of CLUSTERS) out[c] = 0
    for (const n of graph?.nodes ?? []) out[n.cluster]++
    return out
  }, [graph])

  if (failed) return <p className="text-[13px] text-muted-foreground">{t('load_failed')}</p>
  if (!graph) return <Skeleton className="h-[520px] w-full" />

  const selectedNode = selected ? byRef.get(selected) ?? null : null

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
      <div className="min-w-0">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-full border border-border p-0.5 text-[12.5px]">
            <button type="button" className={cn('rounded-full px-3 py-1', layout === 'cluster' ? 'bg-foreground text-background' : 'text-muted-foreground')} aria-pressed={layout === 'cluster'} onClick={() => setLayout('cluster')}>
              {t('brain_layout_cluster')}
            </button>
            <button type="button" className={cn('rounded-full px-3 py-1', layout === 'free' ? 'bg-foreground text-background' : 'text-muted-foreground')} aria-pressed={layout === 'free'} onClick={() => setLayout('free')}>
              {t('brain_layout_free')}
            </button>
          </div>
          <div className="flex items-center gap-1 rounded-full border border-border p-0.5 text-[12.5px]">
            <button type="button" className={cn('rounded-full px-3 py-1', labels === 'hub' ? 'bg-foreground text-background' : 'text-muted-foreground')} aria-pressed={labels === 'hub'} onClick={() => setLabels('hub')}>
              {t('brain_labels_hub')}
            </button>
            <button type="button" className={cn('rounded-full px-3 py-1', labels === 'all' ? 'bg-foreground text-background' : 'text-muted-foreground')} aria-pressed={labels === 'all'} onClick={() => setLabels('all')}>
              {t('brain_labels_all')}
            </button>
          </div>
          {(focus || selected) && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setFocus(null)
                setSelected(null)
              }}
            >
              {t('brain_reset')}
            </Button>
          )}
          <span className="ml-auto text-[12px] text-muted-foreground">{t('brain_hint_short')}</span>
        </div>
        <div className="relative h-[520px] w-full overflow-hidden rounded-lg border border-border bg-background" aria-label={t('brain_title')}>
          <div ref={wrapRef} className="absolute inset-0" />
          {drawError ? <p className="absolute inset-x-0 top-1/2 -translate-y-1/2 px-6 text-center text-[13px] text-muted-foreground">{drawError}</p> : null}
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
          {CLUSTERS.map((c) => (
            <button key={c} type="button" className="flex items-center gap-1.5 hover:text-foreground" onClick={() => setFocus((cur) => (cur === c ? null : c))} aria-pressed={focus === c}>
              <i className="inline-block h-2 w-2 rounded-full" style={{ background: COLORS[c] }} />
              {clusterLabel(c)} <span className="tabular-nums">{counts[c]}</span>
            </button>
          ))}
          {graph.truncated ? <span>{t('brain_truncated')}</span> : null}
        </div>
      </div>

      <aside className="min-w-0 border-t border-border pt-3 xl:border-l xl:border-t-0 xl:pl-4 xl:pt-0">
        {selectedNode ? (
          <NodeCard node={selectedNode} graph={graph} neighbours={neighbours(selectedNode.ref)} onPick={setSelected} clusterLabel={clusterLabel} />
        ) : focus ? (
          <ClusterCard cluster={focus} graph={graph} onPick={setSelected} clusterLabel={clusterLabel} />
        ) : (
          <p className="text-[13px] text-muted-foreground">{t('brain_hint')}</p>
        )}
      </aside>
    </div>
  )
}

function metaLines(node: GraphNode, t: ReturnType<typeof useTranslations<'arkiv'>>): string[] {
  const m = node.meta
  const out: string[] = []
  if (typeof m.amount === 'number') out.push(formatCurrency(m.amount as number, 'SEK'))
  if (typeof m.principal === 'number') out.push(formatCurrency(m.principal as number, 'SEK'))
  if (typeof m.movement === 'number') out.push(t('brain_movement', { amount: formatCurrency(m.movement as number, 'SEK') }))
  if (typeof m.flow === 'number' && (m.flow as number) > 0) out.push(t('brain_flow', { amount: formatCurrency(m.flow as number, 'SEK') }))
  if (typeof m.last_seen === 'string') out.push(t('brain_last_seen', { date: m.last_seen as string }))
  if (m.active === false) out.push(t('brain_former_line'))
  if (typeof m.ends_on === 'string') out.push(t('brain_ends_on', { date: m.ends_on as string }))
  if (typeof m.due_on === 'string') out.push(t('brain_due', { date: m.due_on as string }))
  if (typeof m.due_date === 'string') out.push(t('brain_due', { date: m.due_date as string }))
  if (typeof m.count === 'number') out.push(t('brain_count', { count: m.count as number }))
  if (typeof m.doc_type === 'string') out.push(String(m.doc_type))
  if (m.documented === true) out.push(t('brain_documented'))
  return out
}

function NodeCard({ node, graph, neighbours, onPick, clusterLabel }: { node: GraphNode; graph: CompanyGraph; neighbours: Map<string, GraphLink>; onPick: (ref: string) => void; clusterLabel: (c: ClusterId) => string }) {
  const t = useTranslations('arkiv')
  const href = hrefFor(node, graph)
  const byRef = new Map(graph.nodes.map((n) => [n.ref, n]))
  const groups = new Map<ClusterId, Array<{ node: GraphNode; link: GraphLink }>>()
  for (const [ref, link] of neighbours) {
    const other = byRef.get(ref)
    if (!other) continue
    if (!groups.has(other.cluster)) groups.set(other.cluster, [])
    ;(groups.get(other.cluster) as Array<{ node: GraphNode; link: GraphLink }>).push({ node: other, link })
  }
  const evidence = (e: Record<string, unknown>) => {
    const parts: string[] = []
    if (typeof e.amount === 'number') parts.push(formatCurrency(e.amount as number, 'SEK'))
    if (typeof e.payments === 'number') parts.push(t('brain_payments', { count: e.payments as number }))
    if (typeof e.entries === 'number') parts.push(t('brain_entries', { count: e.entries as number }))
    return parts.join(', ')
  }
  return (
    <div className="space-y-3">
      <div>
        <div className="font-display text-lg leading-tight">{node.label}</div>
        <div className="text-[12px] uppercase tracking-[0.08em] text-muted-foreground">{clusterLabel(node.cluster)}</div>
      </div>
      {metaLines(node, t).length ? (
        <ul className="space-y-0.5 text-[13px] text-muted-foreground">
          {metaLines(node, t).map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      ) : null}
      {href ? (
        <Button size="sm" asChild>
          <Link href={href}>{t('brain_open')}</Link>
        </Button>
      ) : null}
      {CLUSTERS.filter((c) => groups.has(c)).map((c) => (
        <div key={c}>
          <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{clusterLabel(c)}</div>
          <ul className="divide-y divide-border">
            {(groups.get(c) as Array<{ node: GraphNode; link: GraphLink }>).map(({ node: other, link }) => (
              <li key={other.ref} className="py-1.5 text-[13px]">
                <button type="button" className="text-left underline decoration-border underline-offset-2 hover:decoration-foreground" onClick={() => onPick(other.ref)}>
                  {other.label}
                </button>
                <div className="text-[12px] text-muted-foreground">
                  {t(`brain_kind_${link.kind}` as never)}
                  {evidence(link.evidence) ? ` · ${evidence(link.evidence)}` : ''}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {groups.size === 0 ? <p className="text-[13px] text-muted-foreground">{t('brain_no_links')}</p> : null}
    </div>
  )
}

function ClusterCard({ cluster, graph, onPick, clusterLabel }: { cluster: ClusterId; graph: CompanyGraph; onPick: (ref: string) => void; clusterLabel: (c: ClusterId) => string }) {
  const t = useTranslations('arkiv')
  const members = graph.nodes.filter((n) => n.cluster === cluster).sort((a, b) => b.weight - a.weight)
  return (
    <div className="space-y-3">
      <div>
        <div className="font-display text-lg leading-tight">{clusterLabel(cluster)}</div>
        <div className="text-[12px] text-muted-foreground">{t('brain_nodes', { count: members.length })}</div>
      </div>
      <p className="text-[13px] text-muted-foreground">{t(`brain_cluster_${cluster}_help` as never)}</p>
      <ul className="max-h-[420px] divide-y divide-border overflow-y-auto">
        {members.map((n) => (
          <li key={n.ref} className="py-1.5 text-[13px]">
            <button type="button" className={cn('text-left underline decoration-border underline-offset-2 hover:decoration-foreground', isInactive(n) && 'text-muted-foreground')} onClick={() => onPick(n.ref)}>
              {n.label}
              {isInactive(n) ? ` (${t('brain_former')})` : ''}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
