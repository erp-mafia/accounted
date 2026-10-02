/**
 * The cash line: the balance over the fetched window growing left to right,
 * with in/ut ticks along the baseline, the named moments (biggest outflows
 * in amber, the biggest inflow in sage, each with its date and signed
 * amount) in a lane above, and a head that rings when the line lands. Starts in a hold: baseline and dates only, the origin
 * pulsing, until setPoints() hands it the real series (the bank request is
 * still running). Ported from the founder-approved prototype.
 */

import type { CashPoint } from '@/lib/onboarding-books/cash-series'
import { canvasFont, readPalette, tokenColor } from './theater-engine'

export interface CashLineConfig {
  locale: string
  fromLabel: string
  todayLabel: string
  /** Growth duration once the points arrive. */
  ms?: number
  /** A short hold after the points arrive before the line sets off. */
  holdMs?: number
  ticks?: boolean
  events?: boolean
  onValue?: (value: number, done: boolean, progress: number) => void
}

export interface CashLineApi {
  setPoints(points: CashPoint[], inflow?: { label: string; amount: number } | null): void
  stop(): void
}

function fmtKr(n: number, locale: string): string {
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(n)} kr`
}

function dayLabel(d: Date, locale: string): string {
  return d.toLocaleDateString(locale, { day: 'numeric', month: 'short' }).replace('.', '')
}

/** "+4 749" / "−1 240": every named moment carries its signed amount. */
function fmtSigned(n: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0, signDisplay: 'always' }).format(n)
}

export function createCashLine(canvas: HTMLCanvasElement, cfg: CashLineConfig): CashLineApi {
  const C = readPalette(canvas)
  const FONT = canvasFont(canvas)
  // the area under the line: the warm secondary chip tone, at 45%
  const tint = tokenColor('--secondary', 'rgb(231 226 214)').replace(/\)$/, ' / 0.45)')
  const ms = cfg.ms ?? 2600
  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  let pts: CashPoint[] | null = null
  let inflowMark: { label: string; amount: number } | null = null
  let t0 = 0
  let alive = true
  let lastCb = 0
  let ringAt = 0
  let raf = 0
  let min = 0, max = 1
  let marks: { i: number; label: string; tone: 'in' | 'out'; at?: number }[] = []
  let dots: number[] = []
  const holdStart = performance.now()

  function prepare() {
    if (!pts || pts.length === 0) return
    min = Infinity
    max = -Infinity
    pts.forEach((p) => { if (p.v < min) min = p.v; if (p.v > max) max = p.v })
    if (min === max) { min -= 1; max += 1 }
    const pad = (max - min) * 0.2
    min -= pad
    max += pad
    marks = []
    dots = []
    if (cfg.events) {
      pts.forEach((p, i) => {
        if (!p.ev) return
        dots.push(i)
        const amount = p.evAmount !== null ? ` ${fmtSigned(p.evAmount, cfg.locale)}` : ''
        marks.push({ i, label: `${p.ev} ${dayLabel(p.d, cfg.locale)}${amount}`, tone: 'out' })
      })
      if (inflowMark) {
        let bi = -1, bv = 0
        pts.forEach((p, i) => { if (p.inflow > bv) { bv = p.inflow; bi = i } })
        if (bi >= 0) marks.push({ i: bi, label: `${inflowMark.label} ${dayLabel(pts[bi].d, cfg.locale)} ${fmtSigned(inflowMark.amount, cfg.locale)}`, tone: 'in' })
      }
      marks.sort((a, b) => a.i - b.i)
    }
  }

  function onVisible() {
    if (!document.hidden && alive) raf = requestAnimationFrame(draw)
  }
  document.addEventListener('visibilitychange', onVisible)

  function draw() {
    if (!alive || !canvas.isConnected) return
    if (document.hidden) return
    const wrap = canvas.parentElement
    const W = wrap?.clientWidth ?? 0, H = wrap?.clientHeight ?? 0
    if (!W || !H) { raf = requestAnimationFrame(draw); return }
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr)
      canvas.height = Math.round(H * dpr)
    }
    const c2 = canvas.getContext('2d')
    if (!c2) return
    c2.setTransform(dpr, 0, 0, dpr, 0, 0)
    c2.clearRect(0, 0, W, H)
    const now = performance.now()
    const L = 16, R = 22, T = cfg.events ? 52 : 18, B = 30
    const x0 = L, x1 = W - R, y0 = T, y1 = H - B

    // Baseline and the dates.
    c2.strokeStyle = C.hair
    c2.lineWidth = 0.8
    c2.beginPath()
    c2.moveTo(x0, y1 + 0.5)
    c2.lineTo(x1, y1 + 0.5)
    c2.stroke()
    c2.fillStyle = C.mut
    c2.font = `10.5px ${FONT}`
    c2.textAlign = 'left'
    c2.fillText(cfg.fromLabel, x0, y1 + 18)
    c2.textAlign = 'right'
    c2.fillText(cfg.todayLabel, x1, y1 + 18)

    if (!pts || pts.length < 2) {
      // The hold: the origin takes the accounts in, rings closing on it while the bank answers.
      const oy = y1 - (y1 - y0) * 0.45
      const hq = ((now - holdStart) % 1600) / 1600
      for (let hr = 0; hr < 2; hr++) {
        const hp = hq * 1.6 - hr * 0.35
        if (hp <= 0 || hp >= 1) continue
        c2.strokeStyle = C.ink
        c2.globalAlpha = 0.45 * hp
        c2.lineWidth = 1
        c2.beginPath()
        c2.arc(x0, oy, 3 + (1 - hp) * 26, 0, Math.PI * 2)
        c2.stroke()
      }
      c2.globalAlpha = 1
      c2.fillStyle = C.ink
      c2.beginPath()
      c2.arc(x0, oy, 2.2 + Math.sin(hq * Math.PI) * 1.6, 0, Math.PI * 2)
      c2.fill()
      raf = requestAnimationFrame(draw)
      return
    }

    const p = reduced ? 1 : Math.min(1, Math.max(0, (now - t0) / ms))
    const e = 1 - Math.pow(1 - p, 3)
    const n = pts.length - 1
    const span = x1 - x0
    const X = (i: number) => x0 + (i / n) * span
    const Y = (v: number) => y1 - ((v - min) / (max - min)) * (y1 - y0)

    // In/ut ticks along the baseline.
    if (cfg.ticks) {
      const reachT = e * n
      for (let ti = 0; ti <= Math.floor(reachT); ti++) {
        const q = pts[ti]
        const xx = X(ti)
        if (q.inflow > 0) {
          c2.strokeStyle = C.sage
          c2.lineWidth = 1.2
          c2.beginPath()
          c2.moveTo(xx, y1 - 1)
          c2.lineTo(xx, y1 - 1 - Math.min(14, q.inflow / 7000))
          c2.stroke()
        }
        if (q.outflow > 20000) {
          c2.strokeStyle = C.ochre
          c2.lineWidth = 1.2
          c2.beginPath()
          c2.moveTo(xx, y1 + 2)
          c2.lineTo(xx, y1 + 2 + Math.min(10, q.outflow / 14000))
          c2.stroke()
        }
      }
    }

    const reach = e * n
    const iEnd = Math.floor(reach)
    const frac = reach - iEnd
    let headX: number, headY: number, headV: number
    c2.beginPath()
    c2.moveTo(X(0), Y(pts[0].v))
    for (let i = 1; i <= iEnd; i++) c2.lineTo(X(i), Y(pts[i].v))
    if (iEnd < n) {
      const a = pts[iEnd], b = pts[iEnd + 1]
      headX = X(iEnd) + (X(iEnd + 1) - X(iEnd)) * frac
      headV = a.v + (b.v - a.v) * frac
      headY = Y(headV)
      c2.lineTo(headX, headY)
    } else {
      headX = X(n)
      headV = pts[n].v
      headY = Y(headV)
    }
    c2.save()
    c2.lineTo(headX, y1)
    c2.lineTo(X(0), y1)
    c2.closePath()
    c2.fillStyle = tint
    c2.fill()
    c2.restore()
    c2.beginPath()
    c2.moveTo(X(0), Y(pts[0].v))
    for (let j = 1; j <= iEnd; j++) c2.lineTo(X(j), Y(pts[j].v))
    c2.lineTo(headX, headY)
    c2.strokeStyle = C.ink
    c2.lineWidth = 1.2
    c2.lineJoin = 'round'
    c2.stroke()

    // The head, and a ring when the line lands.
    c2.fillStyle = C.ink
    c2.beginPath()
    c2.arc(headX, headY, p < 1 ? 2.2 : 3.4, 0, Math.PI * 2)
    c2.fill()
    if (now < t0) {
      const hq = 1 - (t0 - now) / Math.max(1, t0 - holdStart)
      c2.strokeStyle = C.ink
      c2.globalAlpha = 0.4 * hq
      c2.lineWidth = 1
      c2.beginPath()
      c2.arc(headX, headY, 3 + (1 - hq) * 22, 0, Math.PI * 2)
      c2.stroke()
      c2.globalAlpha = 1
    }
    if (p >= 1) {
      if (!ringAt) ringAt = now
      const rp = Math.min(1, (now - ringAt) / 900)
      if (rp < 1) {
        c2.strokeStyle = C.ink
        c2.globalAlpha = 0.5 * (1 - rp)
        c2.lineWidth = 1
        c2.beginPath()
        c2.arc(headX, headY, 4 + rp * 22, 0, Math.PI * 2)
        c2.stroke()
        c2.globalAlpha = 1
      }
    }

    // The moments: quiet dots on the line, the named ones in a lane above with a hairline leader.
    if (cfg.events) {
      dots.forEach((i) => {
        if (reach < i) return
        const dx = X(i), dy = Y(pts![i].v)
        const dr = Math.min(1, (reach - i) / 3)
        c2.globalAlpha = 0.55 * dr
        c2.fillStyle = C.ochre
        c2.beginPath()
        c2.arc(dx, dy, 1.8 * (1 + 0.6 * (1 - dr)), 0, Math.PI * 2)
        c2.fill()
      })
      c2.globalAlpha = 1
      c2.font = `500 10.5px ${FONT}`
      const placed: { x: number; w: number; row: number }[] = []
      marks.forEach((mk) => {
        if (reach < mk.i) return
        if (!mk.at) mk.at = now
        const a = Math.min(1, (now - mk.at) / 380)
        const mx = X(mk.i), my = Y(pts![mk.i].v)
        const tw = c2.measureText(mk.label).width
        const lx = Math.min(x1 - tw / 2, Math.max(x0 + tw / 2, mx))
        let row = 0
        placed.forEach((o) => { if (Math.abs(o.x - lx) < (o.w + tw) / 2 + 10 && o.row === row) row = o.row + 1 })
        placed.push({ x: lx, w: tw, row })
        const ly = y0 - 14 - row * 15
        c2.globalAlpha = a
        c2.strokeStyle = C.hair
        c2.lineWidth = 0.8
        c2.setLineDash([1.5, 3])
        c2.beginPath()
        c2.moveTo(mx, my - 5)
        c2.lineTo(mx, ly + 5)
        c2.stroke()
        c2.setLineDash([])
        c2.fillStyle = mk.tone === 'in' ? C.sage : C.ochre
        c2.beginPath()
        c2.arc(mx, my, 2.8, 0, Math.PI * 2)
        c2.fill()
        c2.fillStyle = mk.tone === 'in' ? C.sage : C.attn
        c2.textAlign = 'center'
        c2.fillText(mk.label, lx, ly)
        c2.globalAlpha = 1
      })
    }
    if (cfg.onValue && (now - lastCb > 60 || p >= 1)) {
      lastCb = now
      cfg.onValue(Math.round(headV), p >= 1, p)
    }
    // Idle once the line has landed and the ring faded: no frames burn in the background.
    if (p < 1 || ringAt === 0 || now - ringAt < 1000) raf = requestAnimationFrame(draw)
    else raf = 0
  }
  raf = requestAnimationFrame(draw)

  return {
    setPoints(points, inflow) {
      pts = points
      inflowMark = inflow ?? null
      prepare()
      t0 = performance.now() + (cfg.holdMs ?? 250)
      ringAt = 0
      if (!raf) raf = requestAnimationFrame(draw)
    },
    stop() {
      alive = false
      if (raf) cancelAnimationFrame(raf)
      document.removeEventListener('visibilitychange', onVisible)
    },
  }
}

export { fmtKr }
