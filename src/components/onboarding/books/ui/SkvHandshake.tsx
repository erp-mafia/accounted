'use client'

import { Landmark } from 'lucide-react'
import type { SkvPhase } from '@/lib/onboarding-books/reducer'

/**
 * Stämpeln: a neutral authority mark on its white chip, alone, with air
 * around it (never Skatteverket's logo: its API terms forbid using it in
 * information or marketing). While the user is at Skatteverket a faint
 * dashed ring turns slowly outside the chip. On return the chip's own border
 * turns sage as one
 * stroke travels around it, then a small check badge appears at its lower
 * right. Nothing else moves. Every phase is a class on the svg.
 */
export function SkvHandshake({ phase, holdText }: { phase: SkvPhase; holdText: string; leftLabel?: string; rightLabel?: string }) {
  const cls = phase === 'away' ? 'is-away' : phase === 'back' ? 'is-back' : phase === 'done' ? 'is-back is-done' : ''
  return (
    <div className="skv-stage">
      <svg className={`stamp ${cls}`} viewBox="0 0 240 200" width="240" height="200" aria-hidden="true">
        <circle className="wait" cx="120" cy="88" r="56" />
        <circle className="chip" cx="120" cy="88" r="44" />
        <g className="mark">
          <Landmark x="100" y="68" size={40} strokeWidth={1.5} />
        </g>
        <circle className="ring" cx="120" cy="88" r="44" pathLength="1" transform="rotate(-90 120 88)" />
        <g transform="translate(152 120)">
          <g className="badge">
            <circle r="13" />
            <path d="M-5 0.5 L-1.5 4 L5.5 -4" pathLength="1" />
          </g>
        </g>
        <text className="hold" x="120" y="180">{holdText}</text>
      </svg>
    </div>
  )
}
