'use client'

import { useEffect, useRef } from 'react'

/**
 * The journey's particle orb, ported from the founder-approved concept.
 * A 320-particle sphere rides the journey band: it stretches into a comet
 * while traveling, morphs into a checkmark when the company is created,
 * and can re-morph into the company's serif initial (the monogram finale).
 *
 * Deliberately its own canvas component (NOT the thinking-orbs package:
 * that lacks the comet and the shape morphs; decision logged in the plan).
 *
 * - rAF pauses while the tab is hidden.
 * - Reduced motion renders static frames on state changes (jump, no glide).
 */

export type OrbState = 'listening' | 'searching' | 'thinking' | 'working' | 'shaping' | 'check'

interface JourneyOrbProps {
  /** Animation mode; drives speed, wobble and the check morph. */
  state: OrbState
  /** Horizontal target as a fraction (0-1) of the band width. */
  targetX: number
  /** When set during `check`, the particles re-morph into this character. */
  morphChar?: string | null
  /** Band height in px (canvas height). */
  height?: number
}

const N = 320
const SIZE = 56
const TN = 66

function buildSphere() {
  const pts: { x: number; y: number; z: number; ph: number; lag: number }[] = []
  for (let i = 0; i < N; i++) {
    const y = 1 - (i / (N - 1)) * 2
    const r = Math.sqrt(1 - y * y)
    const th = i * 2.39996323
    pts.push({ x: Math.cos(th) * r, y, z: Math.sin(th) * r, ph: Math.random() * 6.283, lag: Math.random() })
  }
  return pts
}

function buildCheck(): [number, number][] {
  const chk: [number, number][] = []
  const A = [-0.75, 0.1]
  const B = [-0.15, 0.65]
  const C = [0.85, -0.6]
  const lenAB = Math.hypot(B[0] - A[0], B[1] - A[1])
  const lenBC = Math.hypot(C[0] - B[0], C[1] - B[1])
  const cut = lenAB / (lenAB + lenBC)
  for (let j = 0; j < TN; j++) {
    const t = j / (TN - 1)
    if (t < cut) {
      const f = t / cut
      chk.push([A[0] + (B[0] - A[0]) * f, A[1] + (B[1] - A[1]) * f])
    } else {
      const f = (t - cut) / (1 - cut)
      chk.push([B[0] + (C[0] - B[0]) * f, B[1] + (C[1] - B[1]) * f])
    }
  }
  return chk
}

/** Sample a serif glyph into particle targets, normalized to roughly [-1, 1]. */
function glyphTargets(ch: string, fontFamily: string): [number, number][] | null {
  const gc = document.createElement('canvas')
  gc.width = gc.height = 120
  const g = gc.getContext('2d')
  if (!g) return null
  g.fillStyle = '#000'
  g.font = `100px ${fontFamily}`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(ch, 60, 68)
  const data = g.getImageData(0, 0, 120, 120).data
  let pts: [number, number][] = []
  for (let y = 2; y < 118; y += 3) {
    for (let x = 2; x < 118; x += 3) {
      if (data[(y * 120 + x) * 4 + 3] > 120) pts.push([(x - 60) / 52, (y - 60) / 52])
    }
  }
  if (pts.length > 150) {
    const step = pts.length / 150
    const out: [number, number][] = []
    for (let k = 0; k < 150; k++) out.push(pts[Math.floor(k * step)])
    pts = out
  }
  return pts.length ? pts : null
}

export default function JourneyOrb({ state, targetX, morphChar, height = 112 }: JourneyOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const stateRef = useRef<OrbState>(state)
  const targetRef = useRef(targetX)
  const morphRef = useRef<string | null>(morphChar ?? null)
  const kickRef = useRef<() => void>(() => {})

  useEffect(() => {
    stateRef.current = state
    targetRef.current = targetX
    morphRef.current = morphChar ?? null
    kickRef.current()
  }, [state, targetX, morphChar])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const CY = height / 4
    let W = 0

    const pts = buildSphere()
    const CHK = buildCheck()
    let shapeTarget: [number, number][] = CHK
    let SN = TN
    const shapeCur: [number, number][] = CHK.map((p) => [p[0], p[1]])
    let appliedMorph: string | null = null

    function setShape(next: [number, number][]) {
      const n = Math.min(next.length, N)
      while (shapeCur.length < n) {
        const base = shapeCur[shapeCur.length % TN]
        shapeCur.push([base[0], base[1]])
      }
      shapeTarget = next
      SN = n
      if (reduced) {
        for (let q = 0; q < SN; q++) {
          shapeCur[q][0] = next[q][0]
          shapeCur[q][1] = next[q][1]
        }
      }
    }

    function resize() {
      const parent = canvas!.parentElement
      W = parent ? parent.clientWidth : 0
      canvas!.width = W * dpr
      canvas!.height = height * dpr
      canvas!.style.width = `${W}px`
      canvas!.style.height = `${height}px`
    }
    resize()

    let t = 0
    let last = 0
    let shapeMix = 0
    let cx = targetRef.current
    let vel = 0
    let raf = 0
    let running = false

    function speed(s: OrbState) {
      return s === 'working' ? 2.6 : s === 'searching' ? 1.4 : s === 'thinking' ? 0.9 : s === 'check' ? 0.2 : 0.35
    }

    function frame(now: number) {
      const s = stateRef.current
      const dt = Math.min((now - last) / 1000, 0.05)
      last = now
      t += dt * speed(s)

      // Shape bookkeeping: default check; monogram only while checked.
      const wantMorph = s === 'check' ? morphRef.current : null
      if (wantMorph !== appliedMorph) {
        appliedMorph = wantMorph
        if (wantMorph) {
          const fontFamily =
            getComputedStyle(document.documentElement).getPropertyValue('--font-display') ||
            'Georgia, serif'
          const glyph = glyphTargets(wantMorph, fontFamily)
          if (glyph) setShape(glyph)
        } else {
          setShape(CHK)
        }
      }

      const prev = cx
      cx += (targetRef.current - cx) * Math.min(dt * 4.2, 1)
      if (reduced) cx = targetRef.current
      vel = ((cx - prev) * W) / Math.max(dt, 0.001)

      const wantShape = s === 'shaping' || s === 'check' ? 1 : 0
      shapeMix += (wantShape - shapeMix) * Math.min(dt * 4, 1)
      if (reduced) shapeMix = wantShape
      if (shapeMix > 0.01) {
        const sk = Math.min(dt * 5, 1)
        for (let q = 0; q < SN; q++) {
          shapeCur[q][0] += (shapeTarget[q][0] - shapeCur[q][0]) * sk
          shapeCur[q][1] += (shapeTarget[q][1] - shapeCur[q][1]) * sk
        }
      }

      const col = getComputedStyle(canvas!).color
      ctx!.clearRect(0, 0, canvas!.width, canvas!.height)
      ctx!.fillStyle = col
      const R = (SIZE / 2 - 3) * dpr
      const cxp = cx * W * dpr
      const cyp = CY * dpr
      const cosT = Math.cos(t)
      const sinT = Math.sin(t)
      const stretch = reduced ? 0 : Math.min(Math.abs(vel) / 900, 1.6)
      const dir = vel >= 0 ? 1 : -1

      for (let i = 0; i < N; i++) {
        const p = pts[i]
        let px = p.x
        let py = p.y
        let pz = p.z
        if (s === 'thinking') {
          const band = Math.sin(py * 6.5 + t * 2.4) * 0.45
          const c2 = Math.cos(band)
          const s2 = Math.sin(band)
          const nx = px * c2 - pz * s2
          pz = px * s2 + pz * c2
          px = nx
        }
        if (s === 'working') {
          px += Math.sin(t * 3.1 + p.ph) * 0.34
          py += Math.cos(t * 2.7 + p.ph * 1.7) * 0.34
          pz += Math.sin(t * 2.2 + p.ph * 2.3) * 0.3
        }
        const rx = px * cosT + pz * sinT
        const rz = -px * sinT + pz * cosT
        const depth = (rz + 1) / 2
        const lagPx = stretch * R * (0.35 + p.lag * 1.5) * (0.4 + 0.6 * depth) * dir
        const squash = 1 / (1 + stretch * 0.25)
        let sx = cxp + rx * R * 0.92 * (1 + stretch * 0.08) - lagPx
        let sy = cyp + py * R * 0.92 * squash
        if (shapeMix > 0.01 && i < SN) {
          const tp = shapeCur[i]
          sx = sx + (cxp + tp[0] * R * 1.05 - sx) * shapeMix
          sy = sy + (cyp + tp[1] * R * 1.05 - sy) * shapeMix
        }
        const a = shapeMix > 0.5 && i >= SN ? 1 - shapeMix : 0.2 + 0.75 * depth
        if (a <= 0.02) continue
        ctx!.globalAlpha = a
        const rad = (0.55 + 0.75 * depth) * dpr
        ctx!.beginPath()
        ctx!.arc(sx, sy, rad, 0, 6.2832)
        ctx!.fill()
      }
      ctx!.globalAlpha = 1

      if (!reduced && running && !document.hidden) {
        raf = requestAnimationFrame(frame)
      } else {
        running = false
      }
    }

    function start() {
      if (reduced) {
        frame(last + 16)
        return
      }
      if (running || document.hidden) return
      running = true
      raf = requestAnimationFrame((now) => {
        last = now
        raf = requestAnimationFrame(frame)
      })
    }
    kickRef.current = start

    function onVisibility() {
      if (!document.hidden) start()
    }
    function onResize() {
      resize()
      if (reduced) frame(last + 16)
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('resize', onResize)
    start()

    return () => {
      running = false
      cancelAnimationFrame(raf)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('resize', onResize)
      kickRef.current = () => {}
    }
    // The loop reads live values via refs; height is the only real dependency.
  }, [height])

  return <canvas ref={canvasRef} className="jny-canvas" aria-hidden="true" />
}
