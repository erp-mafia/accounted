'use client'

import { useEffect, useRef } from 'react'
import { readPalette } from '../engines/theater-engine'

/**
 * A handful of paper flecks let go from the top in the app's own colours,
 * once, then gone. Minor on purpose. Respects reduced motion (draws nothing).
 */
export function Confetti({ count = 70, ms = 1900 }: { count?: number; ms?: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const C = readPalette(canvas)
    const colors = [C.ink, C.sage, C.ochre, C.mut, C.hair]
    const wrap = canvas.parentElement
    const W = wrap?.clientWidth ?? 600, H = wrap?.clientHeight ?? 400
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.round(W * dpr)
    canvas.height = Math.round(H * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const flecks = Array.from({ length: count }, (_, i) => ({
      x: W * 0.2 + Math.random() * W * 0.6,
      y: -10 - Math.random() * 60,
      vx: (Math.random() - 0.5) * 40,
      vy: 60 + Math.random() * 90,
      w: 3 + Math.random() * 3,
      h: 5 + Math.random() * 6,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 6,
      color: colors[i % colors.length],
      delay: Math.random() * 400,
    }))
    const t0 = performance.now()
    let last = t0
    let raf = 0
    let alive = true
    function draw(now: number) {
      if (!alive) return
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const t = now - t0
      ctx!.clearRect(0, 0, W, H)
      const fade = t > ms - 500 ? Math.max(0, (ms - t) / 500) : 1
      for (const f of flecks) {
        if (t < f.delay) continue
        f.vy += 140 * dt
        f.x += (f.vx + Math.sin(now / 300 + f.rot) * 14) * dt
        f.y += f.vy * dt
        f.rot += f.vr * dt
        ctx!.save()
        ctx!.globalAlpha = 0.85 * fade
        ctx!.translate(f.x, f.y)
        ctx!.rotate(f.rot)
        ctx!.fillStyle = f.color
        ctx!.fillRect(-f.w / 2, -f.h / 2, f.w, f.h * (0.4 + 0.6 * Math.abs(Math.cos(f.rot * 1.3))))
        ctx!.restore()
      }
      if (t < ms) raf = requestAnimationFrame(draw)
      else ctx!.clearRect(0, 0, W, H)
    }
    raf = requestAnimationFrame(draw)
    return () => {
      alive = false
      cancelAnimationFrame(raf)
    }
  }, [count, ms])
  return <canvas ref={ref} className="confetti" aria-hidden="true" />
}
