'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import type { ArkivGraph as GraphData, ClusterKey, GraphNode } from '@/app/api/arkiv/graph/route'

/**
 * The company's document graph on the page, no box (plan decision 7): the
 * blue company hub, four clusters on a ring, documents as points, the faint
 * verifikat band, and the one thing that waits for a person in terracotta.
 * Calm at rest: only cluster names and the waiting item carry a label; a
 * point gets its name and a card on hover. Tilted by default; drag turns
 * it, the wheel zooms, a double click resets. Nothing moves on its own.
 */
const W = 1140
const H = 440
const COLOR = { hub: '#3d6bb3', hubGlow: 'rgba(61,107,179,0.14)', sage: '#4d806a', ochre: '#c69239', terracotta: '#a6574e' }

const CLUSTERS: Record<ClusterKey, { deg: number; r: number; color: string | null }> = {
  avtal: { deg: 200, r: 165, color: COLOR.sage },
  myndighet: { deg: 290, r: 150, color: COLOR.ochre },
  motparter: { deg: 350, r: 190, color: null },
  tillgangar: { deg: 110, r: 150, color: null },
}

const point = (deg: number, r: number, cx: number, cy: number) => ({ x: cx + r * Math.cos((deg * Math.PI) / 180), y: cy + r * Math.sin((deg * Math.PI) / 180) })

interface Placed {
  node: GraphNode
  cluster: ClusterKey
  x: number
  y: number
  color: string
}

export function ArkivGraph({ graph }: { graph: GraphData }) {
  const t = useTranslations('arkiv')
  const [hovered, setHovered] = useState<Placed | null>(null)
  const [tilt, setTilt] = useState({ x: 22, y: 0, zoom: 1 })
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)
  const wrapper = useRef<HTMLDivElement>(null)
  const cx = W * 0.46
  const cy = H / 2

  const placed = useMemo(() => {
    const out: Placed[] = []
    for (const cluster of graph.clusters) {
      const c = CLUSTERS[cluster.key]
      const center = point(c.deg, c.r, cx, cy)
      const n = cluster.nodes.length
      cluster.nodes.forEach((node, i) => {
        const deg = c.deg - 70 + (i * 140) / Math.max(n - 1, 1)
        const p = point(deg, 56 + (i % 2) * 14, center.x, center.y)
        out.push({ node, cluster: cluster.key, x: p.x, y: p.y, color: c.color ?? 'var(--foreground)' })
      })
    }
    return out
  }, [graph, cx, cy])

  // The wheel must be a non-passive listener to zoom instead of scrolling the page.
  useEffect(() => {
    const el = wrapper.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      setTilt((s) => ({ ...s, zoom: Math.min(1.8, Math.max(0.7, s.zoom * (e.deltaY < 0 ? 1.08 : 0.93))) }))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, tx: tilt.x, ty: tilt.y }
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return
    const d = drag.current
    setTilt((s) => ({ ...s, y: Math.max(-40, Math.min(40, d.ty + (e.clientX - d.x) / 6)), x: Math.max(0, Math.min(45, d.tx - (e.clientY - d.y) / 6)) }))
  }
  const onPointerUp = () => {
    drag.current = null
  }

  const hovCluster = hovered ? graph.clusters.find((c) => c.key === hovered.cluster) : null
  const card = hovered
    ? {
        left: hovered.x + 18 + 236 <= W - 4 && hovered.x >= cx ? hovered.x + 18 : hovered.x - 18 - 236,
        top: Math.min(Math.max(8, hovered.y - 22), H - 110),
      }
    : null

  return (
    <div className="relative mb-4 w-full overflow-hidden" style={{ aspectRatio: `${W} / ${H + 28}` }}>
      <div
        ref={wrapper}
        className="absolute inset-x-0 top-0 select-none"
        style={{ aspectRatio: `${W} / ${H}`, perspective: '1400px', touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => setTilt({ x: 22, y: 0, zoom: 1 })}
      >
        <div
          className="h-full w-full motion-safe:transition-transform motion-safe:duration-150"
          style={{ transform: `rotateX(${tilt.x}deg) rotateY(${tilt.y}deg) scale(${tilt.zoom})`, transformOrigin: '46% 50%' }}
        >
          <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full" role="img" aria-label={t('home_title')}>
            {/* Verifikat band */}
            {Array.from({ length: Math.min(40, Math.max(0, Math.round(graph.verifikat_count / 30))) }, (_, i) => {
              const p = point(30 + i * 1.3, 208 + ((i * 37) % 3) * 6, cx, cy)
              return <circle key={`v${i}`} cx={p.x} cy={p.y} r={1.3} className="fill-border" />
            })}
            {graph.verifikat_count > 0 && (
              <text x={point(52, 236, cx, cy).x + 8} y={point(52, 236, cx, cy).y} fontSize={11} className="fill-muted-foreground">
                {t('graph_verifikat', { count: graph.verifikat_count })}
              </text>
            )}
            {/* Cluster spokes and members */}
            {graph.clusters.map((cluster) => {
              const c = CLUSTERS[cluster.key]
              const center = point(c.deg, c.r, cx, cy)
              const dim = hovered ? hovered.cluster !== cluster.key : false
              return (
                <g key={cluster.key} opacity={dim ? 0.45 : 1}>
                  <line x1={cx} y1={cy} x2={center.x} y2={center.y} className="stroke-border" strokeWidth={1.2} />
                  {placed
                    .filter((p) => p.cluster === cluster.key)
                    .map((p) => (
                      <g key={p.node.id}>
                        <line x1={center.x} y1={center.y} x2={p.x} y2={p.y} className={hovered?.node.id === p.node.id ? 'stroke-foreground' : 'stroke-border'} strokeWidth={1} />
                        <circle
                          cx={p.x}
                          cy={p.y}
                          r={hovered?.node.id === p.node.id ? 6 : 3.5}
                          fill={p.color}
                          opacity={0.9}
                          className="cursor-pointer"
                          onPointerEnter={() => setHovered(p)}
                          onPointerLeave={() => setHovered((h) => (h?.node.id === p.node.id ? null : h))}
                        />
                      </g>
                    ))}
                  <circle cx={center.x} cy={center.y} r={10} className="fill-background" stroke={c.color ?? 'var(--foreground)'} strokeWidth={1.4} />
                  <text x={center.x} y={center.y - 16} textAnchor="middle" fontSize={12} fontWeight={500} className="fill-foreground">
                    {t(`cluster_${cluster.key}` as never)}
                  </text>
                  <text x={center.x} y={center.y + 26} textAnchor="middle" fontSize={11} className="fill-muted-foreground">
                    {cluster.count}
                  </text>
                </g>
              )
            })}
            {/* Waiting for a person */}
            {graph.waiting.slice(0, 1).map((w) => {
              const u = { x: cx + 36, y: cy - 178 }
              return (
                <g key={w.id}>
                  <line x1={cx} y1={cy} x2={u.x} y2={u.y} className="stroke-border" strokeWidth={1} />
                  <circle cx={u.x} cy={u.y} r={4} fill={COLOR.terracotta} />
                  <circle cx={u.x} cy={u.y} r={9} fill={COLOR.terracotta} opacity={0.14} />
                  <text x={u.x + 12} y={u.y + 4} fontSize={11.5} fill={COLOR.terracotta}>
                    {w.label} · {w.meta === 'held' ? t('graph_waiting_held') : t('graph_waiting_unclassified')}
                  </text>
                </g>
              )
            })}
            {/* Hub */}
            <circle cx={cx} cy={cy} r={64} fill={COLOR.hubGlow} />
            <circle cx={cx} cy={cy} r={15} fill={COLOR.hub} />
            <text x={cx} y={cy + 34} textAnchor="middle" fontSize={12.5} fontWeight={500} className="fill-foreground">
              {graph.company.name}
            </text>
            <text x={cx} y={cy + 50} textAnchor="middle" fontSize={11} className="fill-muted-foreground">
              {t('graph_documents', { count: graph.company.document_count })}
            </text>
          </svg>
        </div>
        {hovered && card && hovCluster && (
          <div
            className="pointer-events-none absolute z-10 w-[236px] rounded-lg border border-border bg-background p-3 text-[13px] shadow-md"
            style={{ left: `${(card.left / W) * 100}%`, top: `${(card.top / H) * 100}%` }}
          >
            <div className="font-medium leading-tight">{hovered.node.label}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {t(`cluster_${hovered.cluster}` as never)}
              {hovered.node.meta ? ` · ${hovered.node.meta}` : ''}
            </div>
            <Link href={hovered.node.href} className="pointer-events-auto mt-2 inline-block text-xs underline underline-offset-2">
              {t('graph_open')}
            </Link>
          </div>
        )}
      </div>
      <div className="absolute inset-x-0 bottom-0 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-muted-foreground">
        <Legend color={COLOR.hub} label={t('graph_legend_company')} />
        <Legend color={COLOR.sage} label={t('graph_legend_agreements')} />
        <Legend color={COLOR.ochre} label={t('graph_legend_authority')} />
        <Legend color="var(--foreground)" label={t('graph_legend_parties')} />
        <Legend color={COLOR.terracotta} label={t('graph_legend_waiting')} />
        <span className="ml-auto">{t('graph_hint')}</span>
      </div>
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
