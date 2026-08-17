'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import TheaterCanvas, { type TheaterCanvasHandle } from '@/components/import/TheaterCanvas'
import type { TheaterModel } from '@/lib/import/theater-model'

/**
 * The migration wizard's version of the import theater. Unlike /import
 * (a fixed narration script paced against one opaque server call), the
 * wizard KNOWS what the server is doing: phase 1 posts one SIE file at a
 * time and phase 2 streams the orchestrator's real progress events. The
 * narration is therefore simply those real step labels, printed once each
 * as they arrive; the canvas reacts to the same events. Nothing here
 * invents progress.
 *
 * The graph itself is built from the client-parsed SIE data, so drawing it
 * while the server writes is honest: it shows what the data contains, the
 * narration shows how far the import has come.
 */

interface ArcimMigrationTheaterProps {
  model: TheaterModel
  /** The wizard's real current step label (SIE per-file, then streamed). */
  currentStep: string
  /** The wizard's real progress bar value, 0-100. */
  progress: number
}

interface LogLine {
  id: number
  text: string
}

/** Keep the printed log short enough to never overflow the card. */
const MAX_LOG_LINES = 6

export default function ArcimMigrationTheater({
  model,
  currentStep,
  progress,
}: ArcimMigrationTheaterProps) {
  const canvasRef = useRef<TheaterCanvasHandle | null>(null)
  const [log, setLog] = useState<LogLine[]>([])
  const [elapsed, setElapsed] = useState(0)

  const reduced =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches

  // Visible elapsed counter: a multi-minute migration must never look frozen.
  useEffect(() => {
    const started = Date.now()
    const id = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - started) / 1000)),
      1000,
    )
    return () => window.clearInterval(id)
  }, [])

  // Account waves (TheaterCanvas assigns account nodes wave = i % 4) are
  // rationed through one gate shared by the timer schedule and the
  // step-label reactions below. The floor between births matters: the
  // wizard emits three step labels within the first second ("Startar",
  // "Importerar bokföringsdata", "fil 1 av N"), and ungated spawns would
  // collapse the whole build back into the opening two seconds: the exact
  // "nothing left to perform" failure this pacing exists to fix.
  const accWaveRef = useRef(0)
  const nextWaveAtRef = useRef(0)
  const spawnNextAccountWave = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || accWaveRef.current >= 4) return
    const now = Date.now()
    if (now < nextWaveAtRef.current) return
    canvas.spawn('account', accWaveRef.current)
    accWaveRef.current += 1
    nextWaveAtRef.current = now + 1800
  }, [])

  // Opening beat: the GL skeleton (year rings, buckets, account waves)
  // builds while phase 1 writes the journal. The account waves are spread
  // across ~10s instead of the first two: a multi-year migration runs for
  // minutes and the canvas must still be performing when file 2 starts.
  // Real step labels can pull waves forward through the shared gate; these
  // timers are the ceiling that guarantees a full build by ~10s even if
  // phase 1 hangs on one file. Reduced motion renders the settled graph
  // instead (via the settled prop below).
  useEffect(() => {
    if (reduced) return
    const canvas = () => canvasRef.current
    const timers: number[] = []
    const at = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, ms))
    at(300, () => canvas()?.spawn('ring'))
    at(1200, () => {
      canvas()?.spawn('bucket')
      canvas()?.feed(2100)
    })
    // Floor slightly below the first timer so its own spawn never loses to
    // setTimeout jitter.
    nextWaveAtRef.current = Date.now() + 2300
    ;[2400, 5000, 7600, 10200].forEach((ms) => at(ms, spawnNextAccountWave))
    return () => timers.forEach((id) => window.clearTimeout(id))
  }, [reduced, spawnNextAccountWave])

  // Real-event narration: append each distinct step label once, and let the
  // canvas mark the milestone. The entity phase (bar past its 55% handoff)
  // attaches counterparties: that is literally what the orchestrator is
  // importing then. Reconciliation (95+) gets the pulse.
  const lastStepRef = useRef('')
  const idRef = useRef(0)
  const cpWaveRef = useRef(0)
  useEffect(() => {
    if (!currentStep || currentStep === lastStepRef.current) return
    lastStepRef.current = currentStep
    idRef.current += 1
    const line = { id: idRef.current, text: currentStep }
    setLog((prev) => [...prev, line].slice(-MAX_LOG_LINES))
    if (reduced) return
    const canvas = canvasRef.current
    if (!canvas) return
    // SIE phase (bar at or below its 55% handoff): each real step, one per
    // posted file, also births the next account wave through the rationing
    // gate, so a long phase 1 keeps building the graph between the timer
    // beats. Only canvas pacing reacts here: labels and progress stay the
    // wizard's real values.
    if (progress <= 55) spawnNextAccountWave()
    if (progress > 55 && cpWaveRef.current < 3) {
      canvas.spawn('counterparty', cpWaveRef.current)
      cpWaveRef.current += 1
    }
    canvas.feed(900)
    if (progress >= 95) canvas.pulse()
  }, [currentStep, progress, reduced, spawnNextAccountWave])

  return (
    <Card>
      <CardContent className="p-6">
        <div className="grid gap-6 md:grid-cols-[280px_1fr]">
          <div>
            <p className="text-sm font-medium">Migrering pågår</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Vi hämtar och importerar din bokföringsdata. Det kan ta några minuter.
            </p>
            {/* The live region covers only the step labels: the per-second
                timer below would drown them out in a screen reader. */}
            <ol className="mt-4 space-y-0" role="status" aria-live="polite">
              {log.map((line, i) => {
                const active = i === log.length - 1
                return (
                  <li
                    key={line.id}
                    className="border-b border-border/60 py-2.5 last:border-b-0"
                  >
                    <p className={`text-sm ${active ? '' : 'text-muted-foreground'}`}>
                      {line.text}
                    </p>
                  </li>
                )
              })}
            </ol>
            <div className="mt-4 space-y-1">
              <div
                className="flex justify-between text-xs text-muted-foreground tabular-nums"
                aria-hidden="true"
              >
                <span>{elapsed}s</span>
                <span>{progress}%</span>
              </div>
              <Progress value={progress} className="h-2" />
            </div>
          </div>
          <div className="relative min-h-[340px] md:min-h-[420px]">
            <TheaterCanvas ref={canvasRef} model={model} settled={reduced} />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
