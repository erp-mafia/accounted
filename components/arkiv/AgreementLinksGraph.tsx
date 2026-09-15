'use client'

import Link from 'next/link'
import { ARKIV } from './palette'

/**
 * The "Kopplingar" figure of the agreement page (canvas artboard Avtal): the
 * agreement in the middle, and around it what it is tied to: the
 * counterparty, its documents (the source one lit), the stream of expected
 * payments, a deposit, the asset, the notice date. Only what exists is drawn.
 */
export interface LinkNode {
  key: string
  label: string
  sub?: string
  href?: string | null
  /** Opens the file rather than a page in the app. */
  external?: boolean
  color: 'sage' | 'ochre' | 'dark' | 'grey'
  lit?: boolean
  /** A stream of small dots along the spoke: many of the same thing. */
  stream?: boolean
}

const W = 460
const H = 290
const CX = 230
const CY = 149

/** Spoke angles by role, degrees clockwise from 3 o'clock, as on the artboard. */
const ANGLES: Record<string, { deg: number; r: number }> = {
  counterparty: { deg: 200, r: 84 },
  document_1: { deg: 250, r: 96 },
  source: { deg: 288, r: 90 },
  document_2: { deg: 268, r: 100 },
  payments: { deg: 355, r: 92 },
  deposit: { deg: 50, r: 92 },
  asset: { deg: 110, r: 90 },
  notice: { deg: 150, r: 92 },
}

const COLOR = { sage: ARKIV.sage, ochre: ARKIV.ochre, dark: 'var(--foreground)', grey: 'var(--border)' }

const point = (deg: number, r: number) => ({ x: CX + r * Math.cos((deg * Math.PI) / 180), y: CY + r * Math.sin((deg * Math.PI) / 180) })

export function AgreementLinksGraph({ title, nodes }: { title: string; nodes: Array<LinkNode & { role: keyof typeof ANGLES }> }) {
  return (
    <div className="w-full max-w-[460px]">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={title}>
        {nodes.map((n) => {
          const a = ANGLES[n.role]
          const p = point(a.deg, a.r)
          const left = p.x < CX
          const labelX = left ? p.x - 12 : p.x + 12
          const anchor = left ? 'end' : 'start'
          return (
            <g key={n.key}>
              <line x1={CX} y1={CY} x2={p.x} y2={p.y} stroke={n.lit ? 'var(--foreground)' : 'var(--border)'} strokeWidth={1.2} />
              {n.stream &&
                Array.from({ length: 12 }, (_, i) => {
                  const q = point(a.deg + (i % 2 ? 4 : -4), a.r + 8 + i * 9)
                  return <circle key={i} cx={q.x} cy={q.y} r={1.25} fill="var(--border)" />
                })}
              {n.lit && <circle cx={p.x} cy={p.y} r={10} fill={ARKIV.sageGlow} />}
              <circle cx={p.x} cy={p.y} r={n.lit ? 5.5 : 4} fill={COLOR[n.color]} />
              <text x={labelX} y={p.y - (n.sub ? 6 : -4)} fontSize={11.5} fontWeight={n.lit ? 500 : 400} textAnchor={anchor} className="fill-foreground">
                {n.label}
              </text>
              {n.sub && (
                <text x={labelX} y={p.y + 8} fontSize={11} textAnchor={anchor} className="fill-muted-foreground">
                  {n.sub}
                </text>
              )}
              {n.href && n.lit && (
                <a href={n.href} target={n.external ? '_blank' : undefined} rel={n.external ? 'noreferrer' : undefined}>
                  <text
                    x={labelX}
                    y={p.y + 22}
                    fontSize={11}
                    textAnchor={anchor}
                    className="fill-foreground underline"
                    style={{ textDecoration: 'underline', textUnderlineOffset: 2 }}
                  >
                    {n.sub ? 'Öppna dokumentet' : ''}
                  </text>
                </a>
              )}
            </g>
          )
        })}
        <circle cx={CX} cy={CY} r={20} fill={ARKIV.sageGlow} opacity={0.7} />
        <circle cx={CX} cy={CY} r={12} fill={ARKIV.sage} />
        <text x={CX} y={CY + 30} fontSize={11.5} fontWeight={500} textAnchor="middle" className="fill-foreground">
          {title.length > 32 ? `${title.slice(0, 31)}…` : title}
        </text>
      </svg>
      <ul className="sr-only">
        {nodes.map((n) => (
          <li key={n.key}>{n.href && !n.external ? <Link href={n.href}>{n.label}</Link> : n.label}</li>
        ))}
      </ul>
    </div>
  )
}
