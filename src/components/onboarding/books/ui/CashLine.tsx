'use client'

import { useEffect, useRef } from 'react'
import type { CashPoint } from '@/lib/onboarding-books/cash-series'
import { createCashLine, type CashLineApi } from '../engines/cash-draw'

interface CashLineProps {
  locale: string
  fromLabel: string
  todayLabel: string
  /** null while the bank answers: the origin pulses on an empty baseline. */
  points: CashPoint[] | null
  inflow?: { label: string; amount: number } | null
  onValue?: (value: number, done: boolean, progress: number) => void
  className?: string
}

/** The cash line canvas. Mounts in the hold; grows once the points arrive. */
export function CashLine({ locale, fromLabel, todayLabel, points, inflow, onValue, className }: CashLineProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const apiRef = useRef<CashLineApi | null>(null)
  const onValueRef = useRef(onValue)
  useEffect(() => {
    onValueRef.current = onValue
  })

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const api = createCashLine(canvas, {
      locale,
      fromLabel,
      todayLabel,
      ms: 2600,
      holdMs: 250,
      ticks: true,
      events: true,
      onValue: (v, done, p) => onValueRef.current?.(v, done, p),
    })
    apiRef.current = api
    return () => {
      api.stop()
      apiRef.current = null
    }
    // Labels are fixed for one fetch; the canvas is remounted for a new one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (points && apiRef.current) apiRef.current.setPoints(points, inflow ?? null)
  }, [points, inflow])

  return (
    <div className={`cash${className ? ` ${className}` : ''}`}>
      <canvas ref={canvasRef} aria-hidden="true" />
    </div>
  )
}
