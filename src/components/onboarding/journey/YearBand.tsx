'use client'

import { InkText } from './ink'

/**
 * The fiscal-year band: 24 or 36 month cells with a springy highlight span,
 * a serif label ("1 januari – 31 december") and a small note line.
 * Pure display; the parent drives span/label/note from hover or selection.
 */
const MONTH_LETTERS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D']

interface YearBandProps {
  cells?: 24 | 36
  year0: number
  /** Inclusive month-cell indices to highlight, or null for none. */
  span?: [number, number] | null
  label?: string
  note?: string
}

export default function YearBand({ cells = 24, year0, span, label, note }: YearBandProps) {
  const years = Array.from({ length: cells / 12 }, (_, i) => year0 + i)
  return (
    <div className="jny-yband">
      <div className="jny-yb-grid">
        <div
          className={`jny-yb-span${span ? ' is-on' : ''}`}
          style={
            span
              ? {
                  left: `${(span[0] / cells) * 100}%`,
                  width: `${((span[1] - span[0] + 1) / cells) * 100}%`,
                }
              : undefined
          }
        />
        <div className="jny-yb-cells" style={{ gridTemplateColumns: `repeat(${cells}, 1fr)` }}>
          {Array.from({ length: cells }, (_, i) => (
            <span key={i} className={span && i >= span[0] && i <= span[1] ? 'is-in' : undefined}>
              {MONTH_LETTERS[i % 12]}
            </span>
          ))}
        </div>
      </div>
      <div className="jny-yb-years" style={{ gridTemplateColumns: `repeat(${cells}, 1fr)` }}>
        {years.map((y) => (
          <span key={y} style={{ gridColumn: 'span 12' }}>
            {y}
          </span>
        ))}
      </div>
      <div className="jny-yb-label">{label ? <InkText text={label} step={40} /> : null}</div>
      <div className="jny-yb-note">{note}</div>
    </div>
  )
}
