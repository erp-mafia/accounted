'use client'

import { useEffect, useRef } from 'react'
import styles from './skills.module.css'

/**
 * A faint strata ground: rows of horizontal bars in the linen tone at a few
 * percent opacity over one plain colour, the start cards' strata with the
 * picture taken out. Bar lengths follow a smooth field seeded by the agent,
 * so each stage has its own quiet grain. Drawn once, redrawn on resize.
 */
function hash(x: number, y: number, seed: number) {
  const s = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453
  return s - Math.floor(s)
}
function noise(x: number, y: number, seed: number) {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const xf = x - xi
  const yf = y - yi
  const u = xf * xf * (3 - 2 * xf)
  const v = yf * yf * (3 - 2 * yf)
  const a = hash(xi, yi, seed)
  const b = hash(xi + 1, yi, seed)
  const c = hash(xi, yi + 1, seed)
  const d = hash(xi + 1, yi + 1, seed)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}

export function StrataField({ seed, ground, bar = '#EBE5D3', strength = 1 }: { seed: number; ground: string; bar?: string; strength?: number }) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!wrap || !canvas || !ctx) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)

    function draw() {
      const W = wrap!.clientWidth
      const H = wrap!.clientHeight
      canvas!.width = W * dpr
      canvas!.height = H * dpr
      ctx!.clearRect(0, 0, canvas!.width, canvas!.height)
      ctx!.fillStyle = bar
      const rowGap = 6
      const step = 4
      for (let y = 0; y < H; y += rowGap) {
        let x = 0
        while (x < W) {
          // bands of lighter and darker rows drift across the stage
          const field = noise(x / 160, y / 90, seed) * 0.7 + noise(x / 40, y / 24, seed + 3) * 0.3
          if (field > 0.48) {
            const start = x
            while (x < W && noise(x / 160, y / 90, seed) * 0.7 + noise(x / 40, y / 24, seed + 3) * 0.3 > 0.48) x += step
            ctx!.globalAlpha = (0.035 + (field - 0.48) * 0.12) * strength
            ctx!.fillRect(start * dpr, y * dpr, (x - start) * dpr, 2 * dpr)
          }
          x += step
        }
      }
      ctx!.globalAlpha = 1
    }

    draw()
    let timer = 0
    let last = `${wrap.clientWidth}x${wrap.clientHeight}`
    const observer = new ResizeObserver(() => {
      const size = `${wrap.clientWidth}x${wrap.clientHeight}`
      if (size === last) return
      last = size
      window.clearTimeout(timer)
      timer = window.setTimeout(draw, 120)
    })
    observer.observe(wrap)
    return () => { observer.disconnect(); window.clearTimeout(timer) }
  }, [seed, bar, strength])

  return (
    <div ref={wrapRef} className={styles.strata} style={{ background: ground }} aria-hidden>
      <canvas ref={canvasRef} />
    </div>
  )
}
