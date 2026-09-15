'use client'

import type { ReactNode } from 'react'
import { InkText } from './ink'

/**
 * The five journey stations (Företaget → Klart): dots, uppercase labels and
 * the inked-in answers beneath completed stations. No connecting lines.
 * Completed stations are jump-back buttons (plan: rewind to the station's
 * first question). Labels/answers hide under 640px; answers are mirrored
 * into a visually hidden aria-live region.
 */

export interface TrackStation {
  label: string
  answer?: string | null
}

interface JourneyTrackProps {
  stations: TrackStation[]
  /** Index of the active station (0-4). Earlier stations render as done. */
  active: number
  onJump?: (station: number) => void
  /** The orb canvas (positioned absolutely inside the band). */
  children?: ReactNode
  /** Screen-reader description of what the orb is doing. */
  orbLabel?: string
}

/** Stations sit evenly between 7% and 93% of the band, whatever their count
 *  (five in the first act, four in the books act), so the last one always
 *  lands where the orb's final target is. */
function stationLeft(i: number, count: number): string {
  return `${(7 + (i * 86) / Math.max(count - 1, 1)).toFixed(2)}%`
}

export default function JourneyTrack({ stations, active, onJump, children, orbLabel }: JourneyTrackProps) {
  return (
    <div className="jny-journey" aria-label="Steg i onboardingen">
      {stations.map((st, i) => {
        const done = i < active
        return (
          <div
            key={st.label}
            className={`jny-pt${done ? ' is-done' : ''}${i === active ? ' is-active' : ''}`}
            style={{ left: stationLeft(i, stations.length) }}
            role={done && onJump ? 'button' : undefined}
            tabIndex={done && onJump ? 0 : -1}
            title={done && onJump ? 'Ändra' : undefined}
            onClick={done && onJump ? () => onJump(i) : undefined}
            onKeyDown={
              done && onJump
                ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onJump(i)
                    }
                  }
                : undefined
            }
          >
            <span className="jny-dot" />
            <span className="jny-lbl">{st.label}</span>
            <span className="jny-ans">
              {st.answer ? <InkText text={st.answer} step={40} /> : null}
            </span>
          </div>
        )
      })}
      {children}
      <span className="sr-only" aria-live="polite">
        {orbLabel}
        {stations
          .filter((s) => s.answer)
          .map((s) => `${s.label}: ${s.answer}`)
          .join('. ')}
      </span>
    </div>
  )
}
