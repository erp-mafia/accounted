'use client'

import { useEffect, useMemo, useState } from 'react'
import { motion, AnimatePresence, useReducedMotion, animate } from 'framer-motion'
import { RotateCw } from 'lucide-react'
import { getAccountDescription } from '@/lib/bookkeeping/account-descriptions'
import { useTranslations } from 'next-intl'
import { formatCurrency } from '@/lib/utils'
import type { DeepEntity, DeepLedgerContext } from '@/lib/agent-context/ledger-deep'
import { entityMagnitude, selectAccountRing, type RingBasis } from './ledger-graph-magnitude'

/**
 * "Reconciliation Aurora" - the cinematic hero of the "Vad din agent vet" page.
 *
 * A self-contained dark SVG panel. The company is a luminous hub; the BAS
 * accounts it books to form an inner ring of wedges (each wedge sized by the
 * money that flows through it); the counterparties/suppliers live in the outer
 * band, each constrained to its dominant account's angular slice so threads can
 * never cross between accounts (the anti-hairball guarantee).
 *
 * Four orthogonal channels, so no two compete:
 *   - node AREA   = magnitude (radius = k·√x), see ledger-graph-magnitude.ts
 *   - node COLOUR = booking cadence (weekly / monthly / irregular) - the one
 *                   semantic axis; everything else stays achromatic
 *   - node SHAPE  = kind (supplier = filled, counterparty = open ring)
 *   - node FOCUS  = the agent's confidence in the account mapping, rendered as
 *                   optical depth of field (sure = crisp/forward, unsure = soft)
 *
 * On mount it performs the signature act: for the most-merged payees, the raw
 * bank descriptors ("CLAUDE.AI", "Anthropic PBC", "claude.ai*sub") fly in as
 * ghost chips and magnetically collapse into one named node with a "×N" badge -
 * the agent resolving chaos into knowledge, live, in front of the customer.
 *
 * Deterministic (seeded jitter, fixed input order) so the demo looks identical
 * on every load. Motion is CSS-driven (single-clock idle, GPU dash pulses) with
 * framer only orchestrating the entrance, the merge and the hover card. Fully
 * keyboard-navigable; a visually-hidden table carries the payload for readers;
 * honours prefers-reduced-motion (jumps straight to the settled state).
 */

const W = 1000
const H = 1000
const CX = W / 2
const CY = H / 2
const R_HUB = 34
const R_ACCOUNT = 178
const R_PAYEE_MIN = 258
const R_PAYEE_MAX = 432
const WEDGE_GAP = 0.07 // radians of padding between account wedges

// This panel is its own dark world regardless of the app theme, so the depth of
// field, the glow and the cadence hues all read. Achromatic chrome; colour only
// ever means cadence.
const INK = '#0a0a0c'
const PAPER = '#ecebe6'
const HAIR = 'rgba(236,235,230,0.13)'
const HAIR_STRONG = 'rgba(236,235,230,0.30)'
const MUTED = 'rgba(236,235,230,0.52)'
const CAD: Record<Cadence, string> = {
  weekly: '#e0895f', // terracotta - fast, recurring
  monthly: '#d7a648', // ochre - monthly
  irregular: '#83a98d', // sage - one-off / irregular
}
// Depth-of-field buckets: stdDeviation in viewBox units (~0.64× on screen).
const DOF = [0, 1.7, 3.4, 5.2]

type Cadence = 'weekly' | 'monthly' | 'irregular'

interface Payee {
  id: string
  entity: DeepEntity
  accountNumber: string
  x: number
  y: number
  r: number
  cadence: Cadence
  bucket: number // depth-of-field bucket index into DOF
  thread: string // svg path from hub to node, bowed through the account anchor
  labelRight: boolean
  revealDelay: number
  merge: boolean // show the ghost-descriptor collapse on mount
  chips: string[]
}
interface Account {
  number: string
  name: string | null
  x: number
  y: number
  midAngle: number
  arc: string
  revealDelay: number
}
interface Model {
  accounts: Account[]
  payees: Payee[]
  truncated: boolean
  /** What the wedge widths and node areas actually measure. See the legend. */
  basis: RingBasis
  totals: { tx: number; payees: number; accounts: number }
}

function polar(cx: number, cy: number, r: number, a: number) {
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }
}
function arcPath(cx: number, cy: number, r: number, a0: number, a1: number) {
  const s = polar(cx, cy, r, a0)
  const e = polar(cx, cy, r, a1)
  const large = a1 - a0 > Math.PI ? 1 : 0
  return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`
}
function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t
}
// Deterministic [0,1) hash of a string (xmur3 → mulberry32), so seeded jitter is
// byte-identical on every render: the live demo never reshuffles.
function rand01(seed: string): number {
  let h = 1779033703 ^ seed.length
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507)
  h = Math.imul(h ^ (h >>> 13), 3266489909)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

function cadenceOf(e: DeepEntity): Cadence {
  const cd = e.cadence_days
  if (cd === null || e.occurrences < 3) return 'irregular'
  if (cd >= 4 && cd <= 10) return 'weekly'
  if (cd > 10 && cd <= 45) return 'monthly'
  return 'irregular'
}
function bucketOf(share: number | null): number {
  if (share === null) return 3
  if (share >= 0.85) return 0
  if (share >= 0.7) return 1
  if (share >= 0.5) return 2
  return 3
}
// Center-out slot order: biggest spender sits at the wedge's angular centre.
function centerOut(n: number): number[] {
  const mid = (n - 1) / 2
  return Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => Math.abs(a - mid) - Math.abs(b - mid),
  )
}

function buildModel(deep: DeepLedgerContext): Model {
  const all: DeepEntity[] = [
    ...(deep?.counterparty_entities ?? []),
    ...(deep?.supplier_entities ?? []),
  ].filter((e) => e.dominant_account_number)

  const totalTx = all.reduce((s, e) => s + e.occurrences, 0)

  // Grouping, weighting, ranking and truncation of the account ring live in
  // ledger-graph-magnitude.ts so they can be unit tested. The one rule that
  // matters here: every wedge weight below is expressed in the SAME unit
  // (`ring.basis`), so the shared denominator never adds kronor to booking
  // counts and no account is squeezed to an invisible sliver, or truncated
  // away entirely, just for being measured differently.
  const ring = selectAccountRing(all)
  const { basis, groups, truncated } = ring

  // The most name-merged payees earn the on-mount "descriptors collapse" moment.
  const mergeIds = new Set(
    all
      .filter((e) => e.variant_count >= 3)
      .sort((a, b) => b.variant_count - a.variant_count)
      .slice(0, 5)
      .map((e) => `${e.dominant_account_number}:${e.key}`),
  )

  const accounts: Account[] = []
  const payees: Payee[] = []

  const spans = 2 * Math.PI - WEDGE_GAP * groups.length
  let angle = -Math.PI / 2 + WEDGE_GAP / 2
  groups.forEach((g, gi) => {
    const width = spans * (g.weight / ring.totalWeight)
    const mid = angle + width / 2
    const anchor = polar(CX, CY, R_ACCOUNT, mid)

    accounts.push({
      number: g.number,
      name: getAccountDescription(g.number)?.name ?? null,
      x: anchor.x,
      y: anchor.y,
      midAngle: mid,
      arc: arcPath(CX, CY, R_ACCOUNT, angle + width * 0.04, angle + width * 0.96),
      revealDelay: 0.2 + gi * 0.06,
    })

    const n = g.items.length
    const inner = width * 0.16
    const order = centerOut(n) // order[rank] = slot for that rank (rank 0 = biggest → centre)
    g.items.forEach((e, rank) => {
      const slot = order[rank]
      const t = n === 1 ? 0.5 : slot / (n - 1)
      const pa = angle + inner + t * (width - 2 * inner)
      // Same unit as the wedge it sits in, so a node is never sized against a
      // maximum measured in something else.
      const sizeFrac = Math.sqrt(entityMagnitude(e, basis) / ring.maxMagnitude)
      const radius = lerp(R_PAYEE_MIN, R_PAYEE_MAX, rand01(e.key)) + sizeFrac * 14
      const pos = polar(CX, CY, Math.min(radius, R_PAYEE_MAX + 10), pa)
      const id = `${g.number}:${e.key}`
      payees.push({
        id,
        entity: e,
        accountNumber: g.number,
        x: pos.x,
        y: pos.y,
        r: 7 + 19 * sizeFrac,
        cadence: cadenceOf(e),
        bucket: bucketOf(e.dominant_account_share),
        thread: `M ${CX} ${CY} Q ${anchor.x.toFixed(2)} ${anchor.y.toFixed(2)} ${pos.x.toFixed(2)} ${pos.y.toFixed(2)}`,
        labelRight: Math.cos(pa) >= 0,
        revealDelay: 0.55 + gi * 0.05 + rank * 0.045,
        merge: mergeIds.has(id),
        chips: e.variants.slice(0, 6),
      })
      angle += 0
    })
    angle += width + WEDGE_GAP
  })

  return {
    accounts,
    payees,
    truncated,
    basis,
    totals: { tx: totalTx, payees: payees.length, accounts: accounts.length },
  }
}

// Weekly beats faster than monthly; irregular drifts slow. Seconds per pulse.
const PULSE_DUR: Record<Cadence, number> = { weekly: 1.15, monthly: 2.7, irregular: 4.3 }

export function LedgerGraph({ deep, companyName }: { deep: DeepLedgerContext; companyName: string }) {
  const t = useTranslations('agentKnowledge')
  const reduce = useReducedMotion() ?? false
  const model = useMemo(() => buildModel(deep), [deep])

  const [hover, setHover] = useState<string | null>(null)
  const [runKey, setRunKey] = useState(0)
  // Track which run has finished its intro rather than a bare boolean, so a
  // replay (runKey++) resets to "unresolved" by derivation, without a
  // setState-in-effect. Chips fly in, then collapse into their node.
  const [resolvedRun, setResolvedRun] = useState(-1)
  useEffect(() => {
    const id = setTimeout(() => setResolvedRun(runKey), reduce ? 0 : 1300)
    return () => clearTimeout(id)
  }, [runKey, reduce])
  const resolved = reduce || resolvedRun === runKey

  const payeeById = useMemo(() => new Map(model.payees.map((p) => [p.id, p])), [model])

  function payeeCaption(p: Payee): string {
    const e = p.entity
    const nm = getAccountDescription(e.dominant_account_number ?? '')?.name
    return [
      e.name,
      t('cap_bookings', { n: e.occurrences }),
      e.variant_count > 1 ? t('cap_variants', { n: e.variant_count }) : null,
      t(`cadence_${p.cadence}`),
      formatCurrency(e.total_amount),
      `${e.dominant_account_number}${nm ? ` ${nm}` : ''}${
        e.dominant_account_share !== null ? ` · ${Math.round(e.dominant_account_share * 100)}%` : ''
      }`,
    ]
      .filter(Boolean)
      .join(' · ')
  }

  if (model.payees.length === 0) {
    return (
      <div
        className="rounded-lg border border-border p-16 text-center text-sm"
        style={{ background: INK, borderColor: HAIR, color: MUTED }}
      >
        {t('none_cp')}
      </div>
    )
  }

  // Which ids are "lit" given the current hover (a payee lights its account and
  // the reverse); everything else recedes into the depth of field.
  const active = new Set<string>()
  if (hover) {
    active.add(hover)
    if (hover.startsWith('acc:')) {
      const num = hover.slice(4)
      model.payees.forEach((p) => p.accountNumber === num && active.add(p.id))
    } else {
      const p = payeeById.get(hover)
      if (p) active.add(`acc:${p.accountNumber}`)
    }
  }
  const lit = (id: string) => !hover || active.has(id)

  const hoveredPayee = hover && !hover.startsWith('acc:') ? payeeById.get(hover) ?? null : null

  return (
    <div
      className="relative overflow-hidden rounded-lg border border-border"
      style={{
        borderColor: HAIR_STRONG,
        background: `radial-gradient(120% 120% at 50% 42%, #17171b 0%, ${INK} 62%)`,
      }}
    >
      <style>{keyframes}</style>

      {/* header */}
      <div className="flex items-start justify-between gap-4 px-5 pt-5 md:px-7 md:pt-6">
        <div>
          <h2
            className="font-display text-lg tracking-tight md:text-xl"
            style={{ color: PAPER }}
          >
            {t('graph_title')}
          </h2>
          <p className="mt-1 max-w-md text-sm leading-relaxed" style={{ color: MUTED }}>
            {t('graph_description')}
          </p>
        </div>
        {!reduce && (
          <button
            type="button"
            onClick={() => setRunKey((k) => k + 1)}
            className="inline-flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors"
            style={{ borderColor: HAIR_STRONG, color: MUTED }}
          >
            <RotateCw className="h-3.5 w-3.5" />
            {t('graph_replay')}
          </button>
        )}
      </div>

      {/* stage */}
      <div className="relative mx-auto aspect-square w-full max-w-[680px]">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="block h-full w-full"
          role="img"
          aria-label={t('graph_aria', { payees: model.payees.length, accounts: model.accounts.length })}
        >
          <defs>
            {DOF.map((sd, i) => (
              <filter key={i} id={`dof-${i}`} x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation={sd} />
              </filter>
            ))}
            <radialGradient id="aurora-hub" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor={PAPER} stopOpacity="0.22" />
              <stop offset="100%" stopColor={PAPER} stopOpacity="0" />
            </radialGradient>
          </defs>

          <g key={runKey}>
            {/* account wedge arcs (the spine) */}
            {model.accounts.map((a) => (
              <g key={`acc:${a.number}`} opacity={lit(`acc:${a.number}`) ? 1 : 0.14}>
                <motion.path
                  d={a.arc}
                  fill="none"
                  stroke={HAIR_STRONG}
                  strokeWidth={1.4}
                  strokeLinecap="round"
                  initial={reduce ? false : { pathLength: 0, opacity: 0 }}
                  animate={{ pathLength: 1, opacity: 1 }}
                  transition={{ duration: 0.7, delay: a.revealDelay, ease: 'easeInOut' }}
                />
                <AccountHit account={a} caption={accountCaption(a)} onHover={setHover} lit={lit(`acc:${a.number}`)} />
              </g>
            ))}

            {/* threads: base vein + travelling cadence pulse */}
            {model.payees.map((p) => (
              <g key={`thread:${p.id}`} opacity={lit(p.id) ? 1 : 0.08}>
                <motion.path
                  d={p.thread}
                  fill="none"
                  stroke={PAPER}
                  strokeOpacity={0.16}
                  strokeWidth={0.9 + 1.1 * (p.entity.dominant_account_share ?? 0.6)}
                  initial={reduce ? false : { pathLength: 0 }}
                  animate={{ pathLength: 1 }}
                  transition={{ duration: 0.6, delay: p.revealDelay, ease: 'easeOut' }}
                />
                <path
                  d={p.thread}
                  fill="none"
                  stroke={CAD[p.cadence]}
                  strokeWidth={2.4}
                  strokeLinecap="round"
                  pathLength={1}
                  className={reduce ? undefined : 'aurora-pulse'}
                  style={{
                    strokeDasharray: '0.035 1',
                    opacity: resolved && lit(p.id) ? 0.9 : 0,
                    transition: 'opacity .6s ease',
                    animationDuration: `${PULSE_DUR[p.cadence]}s`,
                    animationDelay: `${rand01(p.id + 'd') * -PULSE_DUR[p.cadence]}s`,
                  }}
                />
              </g>
            ))}

            {/* payee nodes, blurry buckets first so the confident ones sit on top */}
            {[...model.payees]
              .sort((a, b) => b.bucket - a.bucket)
              .map((p) => (
                <PayeeGlyph
                  key={p.id}
                  p={p}
                  reduce={reduce}
                  resolved={resolved}
                  lit={lit(p.id)}
                  focused={hover === p.id}
                  caption={payeeCaption(p)}
                  onHover={setHover}
                />
              ))}

            {/* company hub */}
            <g>
              <circle cx={CX} cy={CY} r={R_HUB * 2.6} fill="url(#aurora-hub)" />
              <circle
                cx={CX}
                cy={CY}
                r={R_HUB}
                fill={PAPER}
                className={reduce ? undefined : 'aurora-breathe'}
                style={{ transformOrigin: `${CX}px ${CY}px` }}
              />
              <text
                x={CX}
                y={CY}
                fill={INK}
                fontSize={20}
                fontWeight={600}
                textAnchor="middle"
                dominantBaseline="central"
              >
                {initialsOf(companyName)}
              </text>
            </g>
          </g>
        </svg>

        {/* tally: the "understood" count-up */}
        <div
          className="pointer-events-none absolute bottom-3 left-4 text-xs tabular-nums md:bottom-4 md:left-6"
          style={{ color: MUTED }}
        >
          <span style={{ color: PAPER }}>
            <CountUp target={model.totals.tx} run={runKey} reduce={reduce} />
          </span>{' '}
          {t('graph_tally', {
            payees: model.totals.payees,
            accounts: model.totals.accounts,
          })}
        </div>

        {/* hover detail card, anchored to the node */}
        <AnimatePresence>
          {hoveredPayee && (
            <DetailCard key={hoveredPayee.id} p={hoveredPayee} t={t} />
          )}
        </AnimatePresence>
      </div>

      {/* legend */}
      <div
        className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t px-5 py-3 text-xs md:px-7"
        style={{ borderColor: HAIR, color: MUTED }}
      >
        <span className="inline-flex items-center gap-2">
          <Dot fill={CAD.weekly} /> {t('cadence_weekly')}
        </span>
        <span className="inline-flex items-center gap-2">
          <Dot fill={CAD.monthly} /> {t('cadence_monthly')}
        </span>
        <span className="inline-flex items-center gap-2">
          <Dot fill={CAD.irregular} /> {t('cadence_irregular')}
        </span>
        {/* Says what the sizes actually measure. The ring drops to booking
            volume whenever any account lacks a usable amount, and claiming
            "Storlek = belopp" there would describe a unit nothing is drawn in. */}
        <span className="opacity-70">
          {model.basis === 'amount' ? t('legend_size') : t('legend_size_volume')}
        </span>
        <span className="opacity-70">{t('legend_focus')}</span>
        {model.truncated && <span className="italic opacity-70">{t('graph_truncated')}</span>}
      </div>

      {/* screen-reader alternative: the full payload as a plain list */}
      <ul className="sr-only">
        {model.payees.map((p) => (
          <li key={`sr:${p.id}`}>{payeeCaption(p)}</li>
        ))}
      </ul>
    </div>
  )
}

function accountCaption(a: Account): string {
  return `${a.number}${a.name ? ` · ${a.name}` : ''}`
}

// Enlarged invisible hit target + keyboard focus for an account arc.
function AccountHit({
  account,
  caption,
  onHover,
  lit,
}: {
  account: Account
  caption: string
  onHover: (id: string | null) => void
  lit: boolean
}) {
  const id = `acc:${account.number}`
  const inside = polar(CX, CY, R_ACCOUNT - 20, account.midAngle)
  return (
    <g
      tabIndex={0}
      role="button"
      aria-label={caption}
      onMouseEnter={() => onHover(id)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(id)}
      onBlur={() => onHover(null)}
      className="cursor-pointer outline-none [&:focus-visible>circle]:opacity-100"
    >
      <title>{caption}</title>
      <circle cx={account.x} cy={account.y} r={22} fill="transparent" />
      <circle cx={account.x} cy={account.y} r={26} fill="none" stroke={PAPER} strokeWidth={1.25} opacity={0} />
      <text
        x={inside.x}
        y={inside.y}
        fill={lit ? PAPER : MUTED}
        fontSize={13}
        fontWeight={500}
        textAnchor="middle"
        dominantBaseline="central"
        style={{ fontFamily: 'var(--font-geist-mono, ui-monospace, monospace)' }}
      >
        {account.number}
      </text>
    </g>
  )
}

function PayeeGlyph({
  p,
  reduce,
  resolved,
  lit,
  focused,
  caption,
  onHover,
}: {
  p: Payee
  reduce: boolean
  resolved: boolean
  lit: boolean
  focused: boolean
  caption: string
  onHover: (id: string | null) => void
}) {
  const colour = CAD[p.cadence]
  const showChips = !reduce && p.merge && !resolved
  // The depth-of-field blur only attaches once the entrance spring settles, so
  // feGaussianBlur never re-rasterizes per frame while the node is moving (and
  // the blur "racking in" as the node comes to rest is the intended focus pull).
  const [settled, setSettled] = useState(reduce)
  // Only the biggest spenders keep a resting label; the rest reveal on focus.
  const bigLabel = p.r >= 14
  const label = p.entity.name.length > 16 ? p.entity.name.slice(0, 15) + '…' : p.entity.name
  const lx = p.labelRight ? p.r + 8 : -(p.r + 8)

  return (
    // Positioning lives on a plain <g> (SVG transform attribute) so it can never
    // be clobbered by framer's CSS transform on the scaling child below. Hover
    // "racks focus" onto a node by dropping it to the crisp filter bucket.
    <g
      transform={`translate(${p.x} ${p.y})`}
      filter={`url(#dof-${focused || !settled ? 0 : p.bucket})`}
      tabIndex={0}
      role="button"
      aria-label={caption}
      onMouseEnter={() => onHover(p.id)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(p.id)}
      onBlur={() => onHover(null)}
      className="cursor-pointer outline-none"
    >
      <title>{caption}</title>
      {/* always-full-size transparent hit target */}
      <circle cx={0} cy={0} r={Math.max(p.r + 8, 16)} fill="transparent" />

      {/* opacity layer: entrance fade + hover dimming. Animates opacity only, so
          framer never sets a CSS transform that would fight the attribute. */}
      <motion.g
        initial={reduce ? false : { opacity: 0 }}
        animate={{ opacity: lit ? 1 : 0.12 }}
        transition={{ duration: reduce ? 0.2 : 0.4, delay: reduce ? 0 : p.merge ? 0.1 : p.revealDelay }}
      >
        {/* the money shot: raw bank descriptors that collapse inward. Kept OUT
            of the scaling group so they show at full size during the scatter. */}
        <AnimatePresence>
          {showChips &&
            p.chips.map((chip, i) => {
              const ang = rand01(p.id + chip) * Math.PI * 2
              const rad = 34 + rand01(chip + String(i)) * 52
              const ox = Math.cos(ang) * rad
              const oy = Math.sin(ang) * rad
              return (
                <motion.text
                  key={chip + i}
                  fontSize={12}
                  fill={MUTED}
                  textAnchor="middle"
                  dominantBaseline="central"
                  initial={{ opacity: 0, x: ox * 1.55, y: oy * 1.55 }}
                  animate={{ opacity: 0.7, x: ox, y: oy }}
                  exit={{ opacity: 0, x: 0, y: 0, scale: 0.4 }}
                  transition={{ duration: 0.5, delay: 0.1 + i * 0.05, ease: 'easeOut' }}
                >
                  {chip.length > 18 ? chip.slice(0, 17) + '…' : chip}
                </motion.text>
              )
            })}
        </AnimatePresence>

        {/* scale layer: the node grows in around its centre (fill-box) */}
        <motion.g
          initial={reduce ? false : { scale: 0 }}
          animate={{ scale: 1 }}
          onAnimationComplete={() => setSettled(true)}
          transition={
            reduce
              ? { duration: 0 }
              : { type: 'spring', stiffness: 150, damping: 17, delay: p.merge ? 1.32 : p.revealDelay }
          }
          style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
        >
          {/* variant echo ring: faint concentric hint that this node is a merge */}
          {p.entity.variant_count > 2 && (
            <circle cx={0} cy={0} r={p.r + 5} fill="none" stroke={colour} strokeWidth={0.75} strokeOpacity={0.35} />
          )}
          {focused && <circle cx={0} cy={0} r={p.r + 6} fill="none" stroke={PAPER} strokeWidth={1.5} />}

          {/* the glyph: supplier = filled, counterparty = open */}
          <circle
            cx={0}
            cy={0}
            r={p.r}
            fill={p.entity.kind === 'supplier' ? colour : INK}
            fillOpacity={p.entity.kind === 'supplier' ? 0.85 : 1}
            stroke={colour}
            strokeWidth={2}
          />

          {/* "×N" merge badge */}
          {p.entity.variant_count > 1 && (resolved || reduce) && (
            <g transform={`translate(${p.r * 0.72} ${-p.r * 0.72})`}>
              <circle r={8.5} fill={INK} stroke={colour} strokeWidth={1} />
              <text fill={PAPER} fontSize={9} fontWeight={600} textAnchor="middle" dominantBaseline="central">
                {p.merge ? (
                  <CountUp target={p.entity.variant_count} run={resolved ? 1 : 0} reduce={reduce} prefix="×" duration={0.5} />
                ) : (
                  `×${p.entity.variant_count}`
                )}
              </text>
            </g>
          )}
        </motion.g>

        {bigLabel && (
          <text
            x={lx}
            y={0}
            fill={lit ? PAPER : MUTED}
            fontSize={12}
            dominantBaseline="central"
            textAnchor={p.labelRight ? 'start' : 'end'}
          >
            {label}
          </text>
        )}
      </motion.g>
    </g>
  )
}

function DetailCard({ p, t }: { p: Payee; t: ReturnType<typeof useTranslations> }) {
  const e = p.entity
  const nm = getAccountDescription(e.dominant_account_number ?? '')?.name
  const share = e.dominant_account_share !== null ? Math.round(e.dominant_account_share * 100) : null
  // Anchor to the node: viewBox coords → % of the square stage. Flip sides so it
  // never spills off the edge.
  const left = (p.x / W) * 100
  const top = (p.y / H) * 100
  const right = p.x < CX
  return (
    <motion.div
      className="pointer-events-none absolute z-10 w-60 rounded-lg border p-3 backdrop-blur-sm"
      style={{
        left: `${left}%`,
        top: `${top}%`,
        transform: `translate(${right ? '14px' : 'calc(-100% - 14px)'}, -50%)`,
        background: 'rgba(14,14,17,0.92)',
        borderColor: HAIR_STRONG,
        color: PAPER,
      }}
      initial={{ opacity: 0, scale: 0.94 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ type: 'spring', stiffness: 320, damping: 26 }}
    >
      <div className="flex items-center gap-2">
        <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: CAD[p.cadence] }} />
        <span className="truncate font-medium">{e.name}</span>
      </div>
      <div className="mt-2 space-y-1.5 text-xs" style={{ color: MUTED }}>
        <div className="flex justify-between gap-3">
          <span>{t('cap_bookings', { n: e.occurrences })}</span>
          <span style={{ color: PAPER }}>{t(`cadence_${p.cadence}`)}</span>
        </div>
        {e.variant_count > 1 && (
          <div className="flex justify-between gap-3">
            <span>{t('card_variants')}</span>
            <span style={{ color: PAPER }}>×{e.variant_count}</span>
          </div>
        )}
        {/* Its own label: `legend_size` now describes whichever unit the ring
            settled on, which is not always the amount. Rendered as a plain
            number with NO currency suffix: total_amount is the RAW FOREIGN
            amount when no SEK equivalent exists (ledger-graph-magnitude.ts),
            so labelling it "kr" would show a 500 EUR supplier as "500 kr".
            Proper per-currency display is deferred to the RPC fix documented
            in that module. */}
        <div className="flex justify-between gap-3">
          <span>{t('card_amount')}</span>
          <span className="tabular-nums" style={{ color: PAPER }}>
            {e.total_amount.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
        </div>
        <div className="mt-2 border-t pt-2" style={{ borderColor: HAIR }}>
          <div className="flex items-center justify-between gap-3">
            <span className="font-mono" style={{ color: PAPER }}>
              {e.dominant_account_number}
              {nm ? ` ${nm}` : ''}
            </span>
            {share !== null && <span className="tabular-nums">{t('card_confidence', { share })}</span>}
          </div>
          {share !== null && (
            <div className="mt-1.5 h-1 overflow-hidden rounded-full" style={{ background: HAIR }}>
              <div className="h-full rounded-full" style={{ width: `${share}%`, background: CAD[p.cadence] }} />
            </div>
          )}
          {e.dominant_account_count != null && e.dominant_account_total != null && (
            <div className="mt-1 tabular-nums opacity-80">
              {t('card_evidence', { k: e.dominant_account_count, n: e.dominant_account_total })}
            </div>
          )}
        </div>
        {e.variants.length > 1 && (
          <div className="pt-1 leading-relaxed opacity-80">
            {e.variants.slice(0, 4).join(' · ')}
            {e.variant_count > 4 ? ' …' : ''}
          </div>
        )}
      </div>
    </motion.div>
  )
}

function CountUp({
  target,
  run,
  reduce,
  prefix = '',
  duration = 1,
}: {
  target: number
  run: number
  reduce: boolean
  prefix?: string
  duration?: number
}) {
  const [v, setV] = useState(0)
  // Re-run whenever `run` bumps (mount / replay / resolve). No ref-guard: it
  // would early-return on React StrictMode's second effect setup in dev and
  // freeze the number at 0 (the cleanup already stops any prior animation).
  useEffect(() => {
    if (reduce) return
    const controls = animate(0, target, {
      duration,
      ease: 'easeOut',
      onUpdate: (x) => setV(Math.round(x)),
    })
    return () => controls.stop()
  }, [target, run, reduce, duration])
  const shown = reduce ? target : v
  return <>{prefix}{shown.toLocaleString('sv-SE')}</>
}

function Dot({ fill }: { fill: string }) {
  return <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: fill }} />
}

function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? '')
      .join('') || '•'
  )
}

// One clock for all continuous life: GPU-friendly CSS keyframes, frozen for
// prefers-reduced-motion users.
const keyframes = `
@keyframes aurora-pulse { to { stroke-dashoffset: -1; } }
@keyframes aurora-breathe { 0%,100% { transform: scale(1); } 50% { transform: scale(1.03); } }
.aurora-pulse { animation-name: aurora-pulse; animation-timing-function: linear; animation-iteration-count: infinite; }
.aurora-breathe { animation: aurora-breathe 5.5s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) {
  .aurora-pulse, .aurora-breathe { animation: none !important; }
}
`
