'use client'

import { useState, type RefObject } from 'react'

/**
 * Pill-chip answers. On pick, a ghost of the chip flies into the orb
 * (the active station's spot on the band) before the flow moves on.
 * Skipped under prefers-reduced-motion.
 */
export interface ChipOption<K extends string = string> {
  key: K
  label: string
  /** Small secondary line inside the chip (e.g. "12 månader"). */
  rec?: string
}

interface ChipRowProps<K extends string> {
  options: ChipOption<K>[]
  onPick: (key: K) => void
  /** The band element the ghost flies toward. */
  flyTargetRef?: RefObject<HTMLElement | null>
  /** Horizontal fraction (0-1) of the band where the orb currently sits. */
  flyTargetFrac?: number
  disabled?: boolean
}

export function flyToBand(el: HTMLElement, band: HTMLElement | null, frac: number) {
  if (!band) return
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const r = el.getBoundingClientRect()
  const c = band.getBoundingClientRect()
  const tx = c.left + frac * c.width - (r.left + r.width / 2)
  const ty = c.top + 28 - (r.top + r.height / 2)
  const ghost = el.cloneNode(true) as HTMLElement
  ghost.style.cssText = `position:fixed; left:${r.left}px; top:${r.top}px; width:${r.width}px; margin:0; z-index:99; pointer-events:none; border:1px solid hsl(var(--border)); border-radius:99px; padding:10px 18px; background:hsl(var(--background)); font-size:13.5px; transition: transform 520ms cubic-bezier(0.5, 0, 0.2, 1), opacity 520ms var(--ease-out);`
  document.body.appendChild(ghost)
  requestAnimationFrame(() => {
    ghost.style.transform = `translate(${tx}px,${ty}px) scale(0.12)`
    ghost.style.opacity = '0'
  })
  setTimeout(() => ghost.remove(), 560)
}

export default function ChipRow<K extends string>({
  options,
  onPick,
  flyTargetRef,
  flyTargetFrac = 0,
  disabled,
}: ChipRowProps<K>) {
  const [picked, setPicked] = useState<K | null>(null)

  return (
    <div className="jny-chips">
      {options.map((opt) => (
        <button
          key={opt.key}
          type="button"
          className={`jny-pick${picked === opt.key ? ' is-sel' : ''}`}
          disabled={disabled}
          onClick={(e) => {
            if (disabled) return
            setPicked(opt.key)
            flyToBand(e.currentTarget, flyTargetRef?.current ?? null, flyTargetFrac)
            onPick(opt.key)
          }}
        >
          {opt.label}
          {opt.rec ? <span className="jny-rec">{opt.rec}</span> : null}
        </button>
      ))}
    </div>
  )
}
