'use client'

import { useState } from 'react'
import { InkText } from './ink'

/**
 * Tap-only date picker: year → month BY NAME → day. No dd/mm ambiguity.
 * Fires onPick("YYYY-MM-DD") shortly after the day is tapped (immediately
 * under reduced motion).
 */
const MONTHS_SV = [
  'januari', 'februari', 'mars', 'april', 'maj', 'juni',
  'juli', 'augusti', 'september', 'oktober', 'november', 'december',
]
const MONTHS_SHORT = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec']

function lastDay(y: number, m: number) {
  return new Date(y, m, 0).getDate()
}

interface JourneyDatePickerProps {
  years: number[]
  onPick: (date: string) => void
}

export default function JourneyDatePicker({ years, onPick }: JourneyDatePickerProps) {
  const [y, setY] = useState<number>(years[years.length - 1])
  const [m, setM] = useState<number>(0)
  const [d, setD] = useState<number>(0)

  function pickDay(day: number) {
    setD(day)
    const iso = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    window.setTimeout(() => onPick(iso), reduced ? 0 : 650)
  }

  const label = m && d ? `${d} ${MONTHS_SV[m - 1]} ${y}` : m ? `${MONTHS_SV[m - 1]} ${y}` : ''

  return (
    <div>
      <div className="jny-mchips" style={{ marginTop: 10 }}>
        {years.map((yy) => (
          <button
            key={yy}
            type="button"
            className={`jny-mchip${yy === y ? ' is-sel' : ''}`}
            onClick={() => {
              setY(yy)
              setD(0)
            }}
          >
            {yy}
          </button>
        ))}
      </div>
      <div className="jny-mchips">
        {MONTHS_SHORT.map((name, i) => (
          <button
            key={name}
            type="button"
            className={`jny-mchip${i + 1 === m ? ' is-sel' : ''}`}
            onClick={() => {
              setM(i + 1)
              setD(0)
            }}
          >
            {name}
          </button>
        ))}
      </div>
      {m ? (
        <div className="jny-mchips jny-dp-days">
          {Array.from({ length: lastDay(y, m) }, (_, i) => i + 1).map((day) => (
            <button
              key={day}
              type="button"
              className={`jny-mchip${day === d ? ' is-sel' : ''}`}
              onClick={() => pickDay(day)}
            >
              {day}
            </button>
          ))}
        </div>
      ) : null}
      <div className="jny-dp-label">{label ? <InkText text={label} step={40} /> : null}</div>
    </div>
  )
}
