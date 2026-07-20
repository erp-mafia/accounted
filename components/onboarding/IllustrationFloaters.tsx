'use client'

import { useEffect, useRef } from 'react'
import {
  ILLUSTRATIONS,
  illustrationSrc,
  type IllustrationName,
} from './onboarding-illustrations'

export type FloaterDef = {
  name: IllustrationName
  /** Width as a percentage of the container width. */
  size: number
  opacity: number
  /** Initial position as percentages of the container. */
  top: number
  left: number
  /** Drift speed in px/s. Keep single-digit: ambience, not a screensaver. */
  speed: number
  /** Rotation speed in deg/s. */
  vrot: number
}

type Props = {
  items: FloaterDef[]
  /** CSS selector for an element the floaters bounce off (the form card). */
  obstacleSelector?: string
}

type State = {
  x: number
  y: number
  w: number
  h: number
  vx: number
  vy: number
  rot: number
  vrot: number
}

// Ported from the marketing site (gnubok-website BouncingFloaters): slow
// drifting halftone pieces that bounce off the viewport edges and, when
// obstacleSelector is set, off the onboarding card. With reduced motion the
// pieces stay parked at their seeded positions: still decorative, just still.
export default function IllustrationFloaters({ items, obstacleSelector }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLDivElement | null)[]>([])
  const stateRef = useRef<State[]>([])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const aspect = (name: IllustrationName) =>
      ILLUSTRATIONS[name].h / ILLUSTRATIONS[name].w

    const init = () => {
      const cw = container.clientWidth
      const ch = container.clientHeight
      stateRef.current = items.map((it, i) => {
        const w = (it.size / 100) * cw
        const h = w * aspect(it.name)
        // Deterministic launch angle per slot: no Math.random, so SSR and
        // client agree and repeat visits feel familiar.
        const angle = ((i * 137.5 + 40) * Math.PI) / 180
        return {
          x: (it.left / 100) * cw,
          y: (it.top / 100) * ch,
          w,
          h,
          vx: Math.cos(angle) * it.speed,
          vy: Math.sin(angle) * it.speed,
          rot: 0,
          vrot: it.vrot,
        }
      })
      stateRef.current.forEach((s, i) => {
        const el = itemRefs.current[i]
        if (el) el.style.transform = `translate3d(${s.x}px, ${s.y}px, 0)`
      })
    }
    init()

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced) return

    let raf = 0
    let last = performance.now()

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now

      const cw = container.clientWidth
      const ch = container.clientHeight

      let obstacle: { l: number; t: number; r: number; b: number } | null = null
      if (obstacleSelector) {
        const oEl = document.querySelector(obstacleSelector)
        if (oEl) {
          const cRect = container.getBoundingClientRect()
          const oRect = oEl.getBoundingClientRect()
          obstacle = {
            l: oRect.left - cRect.left,
            t: oRect.top - cRect.top,
            r: oRect.right - cRect.left,
            b: oRect.bottom - cRect.top,
          }
        }
      }

      const states = stateRef.current
      for (let i = 0; i < states.length; i++) {
        const s = states[i]
        const it = items[i]
        s.w = (it.size / 100) * cw
        s.h = s.w * aspect(it.name)

        s.x += s.vx * dt
        s.y += s.vy * dt
        s.rot += s.vrot * dt

        if (s.x < 0) {
          s.x = 0
          s.vx = Math.abs(s.vx)
        }
        if (s.x + s.w > cw) {
          s.x = cw - s.w
          s.vx = -Math.abs(s.vx)
        }
        if (s.y < 0) {
          s.y = 0
          s.vy = Math.abs(s.vy)
        }
        if (s.y + s.h > ch) {
          s.y = ch - s.h
          s.vy = -Math.abs(s.vy)
        }

        if (
          obstacle &&
          s.x < obstacle.r &&
          s.x + s.w > obstacle.l &&
          s.y < obstacle.b &&
          s.y + s.h > obstacle.t
        ) {
          const overL = s.x + s.w - obstacle.l
          const overR = obstacle.r - s.x
          const overT = s.y + s.h - obstacle.t
          const overB = obstacle.b - s.y
          const min = Math.min(overL, overR, overT, overB)
          if (min === overL) {
            s.x = obstacle.l - s.w
            s.vx = -Math.abs(s.vx)
          } else if (min === overR) {
            s.x = obstacle.r
            s.vx = Math.abs(s.vx)
          } else if (min === overT) {
            s.y = obstacle.t - s.h
            s.vy = -Math.abs(s.vy)
          } else {
            s.y = obstacle.b
            s.vy = Math.abs(s.vy)
          }
        }

        const el = itemRefs.current[i]
        if (el) {
          el.style.transform = `translate3d(${s.x}px, ${s.y}px, 0) rotate(${s.rot}deg)`
        }
      }
    }
    raf = requestAnimationFrame(tick)

    const onResize = () => {
      const cw = container.clientWidth
      const ch = container.clientHeight
      stateRef.current.forEach((s, i) => {
        const it = items[i]
        s.w = (it.size / 100) * cw
        s.h = s.w * aspect(it.name)
        if (s.x + s.w > cw) s.x = Math.max(0, cw - s.w)
        if (s.x < 0) s.x = 0
        if (s.y + s.h > ch) s.y = Math.max(0, ch - s.h)
        if (s.y < 0) s.y = 0
      })
    }
    window.addEventListener('resize', onResize)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
    }
  }, [items, obstacleSelector])

  return (
    <div ref={containerRef} className="absolute inset-0 overflow-hidden">
      {items.map((item, i) => {
        const dims = ILLUSTRATIONS[item.name]
        return (
          <div
            key={i}
            ref={(el) => {
              itemRefs.current[i] = el
            }}
            aria-hidden
            className="absolute left-0 top-0 will-change-transform"
            style={{ width: `${item.size}%`, opacity: item.opacity }}
          >
            {/* Plain <img>: the physics sizes these by percentage and next/image
                adds nothing for tiny decorative webp files. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={illustrationSrc(item.name)}
              width={dims.w}
              height={dims.h}
              alt=""
              loading="eager"
              decoding="async"
              className="block h-auto w-full dark:[filter:invert(1)_hue-rotate(180deg)]"
            />
          </div>
        )
      })}
    </div>
  )
}
