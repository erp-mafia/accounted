'use client'

import { useEffect, useRef } from 'react'
import { createTheater, type TheaterAccount, type TheaterApi, type TheaterGroup, type TheaterParty } from '../engines/theater-engine'
import { ImportProgress, type ImportProgressProps } from './ImportProgress'

export interface TheaterLine {
  title: string
  sub: string
  tone?: 'ok' | 'err'
}

export interface TheaterModelInput {
  company: string
  accounts: TheaterAccount[]
  counterparties: TheaterParty[]
}

interface TheaterProps {
  model: TheaterModelInput | null
  lines: TheaterLine[]
  /** How many lines are on; the last one on is the active one. */
  shown: number
  /** True when the last shown line has finished (its check may turn green). */
  settled?: boolean
  hold?: string | null
  progress?: ImportProgressProps
  onApi: (api: TheaterApi | null) => void
  onCount?: (landed: number) => void
  groupLabels?: Partial<Record<TheaterGroup, string>>
  reviewLabel?: string
}

/**
 * The import theater: canvas stage on top, the progress lines under it.
 * The engine is created once the model exists and torn down on unmount;
 * the step drives it through the api (spawn, feed, register stage).
 */
export function Theater({ model, lines, shown, settled, hold, progress, onApi, onCount, groupLabels, reviewLabel }: TheaterProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const onApiRef = useRef(onApi)
  const onCountRef = useRef(onCount)
  useEffect(() => {
    onApiRef.current = onApi
    onCountRef.current = onCount
  })

  // The skyline dims while the theater is on so the lines read against it.
  useEffect(() => {
    document.body.classList.add('bks-theater')
    return () => document.body.classList.remove('bks-theater')
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !model) return
    const api = createTheater({
      canvas,
      company: model.company,
      accounts: model.accounts,
      counterparties: model.counterparties,
      onCount: (n) => onCountRef.current?.(n),
      groupLabels,
      reviewLabel,
    })
    onApiRef.current(api)
    return () => {
      api.stop()
      onApiRef.current(null)
    }
    // The model is stable for one import run; labels never change mid-run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model])

  return (
    <div className="theater">
      <div className="th-stage">
        <canvas ref={canvasRef} aria-hidden="true" />
      </div>
      {progress ? <ImportProgress {...progress} /> : null}
      <div className="th-lines" role="status" aria-live="polite">
        {lines.map((ln, i) => {
          const visible = shown > i
          const active = shown === i + 1 && !settled
          const ok = visible && ln.tone === 'ok' && !active
          return (
            <div key={ln.title} className={`th-line${visible ? ' is-on' : ''}${ok ? ' is-ok' : ''}${ln.tone === 'err' ? ' is-err' : ''}`}>
              <p>{ln.title}</p>
              <p className="sub">{visible ? ln.sub : ''}</p>
            </div>
          )
        })}
        {hold ? <p className="th-hold">{hold}</p> : null}
      </div>
    </div>
  )
}
