'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import TheaterCanvas, { type TheaterCanvasHandle } from '@/components/import/TheaterCanvas'
import type { ImportPreview } from '@/lib/import/types'
import type { TheaterModel } from '@/lib/import/theater-model'

/**
 * The import theater: while the SIE import commits server-side (one opaque
 * call, up to ~5 minutes), the client-parsed file drives a knowledge graph
 * that draws itself, with narration lines pacing alongside. The final line
 * holds with the elapsed counter until the server answers, so the animation
 * never pretends to know more than the import does. Reduced motion renders
 * the settled graph and all narration instantly.
 */

interface ImportTheaterProps {
  model: TheaterModel
  preview: ImportPreview
  /** Elapsed seconds since execute started (owned by ImportReviewStep). */
  elapsed: number
}

export default function ImportTheater({ model, preview, elapsed }: ImportTheaterProps) {
  const t = useTranslations('import')
  const canvasRef = useRef<TheaterCanvasHandle | null>(null)
  const [lineCount, setLineCount] = useState(0)
  const [voucherTick, setVoucherTick] = useState(0)

  const reduced =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches

  const lines: { title: string; sub: string | null; ok?: boolean; warn?: boolean }[] = [
    {
      title: t('theater_reading', { company: model.companyName || preview.companyName || '' }),
      sub: t('theater_years', { count: Math.max(model.years.length, 1) }),
      ok: true,
    },
    {
      title: t('theater_vouchers'),
      sub: `${voucherTick.toLocaleString('sv-SE')} ${t('theater_vouchers_unit')}`,
    },
    {
      title: t('theater_accounts'),
      sub: t('theater_accounts_sub', {
        mapped: preview.mappingStatus.mapped,
        total: preview.mappingStatus.total,
      }),
    },
    ...(model.totalCounterparties > 0
      ? [{
          title: t('theater_counterparties'),
          sub: t('theater_counterparties_sub', { count: model.totalCounterparties }),
        }]
      : []),
    {
      title: t('theater_balance'),
      sub: preview.trialBalance.isBalanced ? t('theater_balance_ok') : t('theater_balance_warn'),
      ok: preview.trialBalance.isBalanced,
      warn: !preview.trialBalance.isBalanced,
    },
  ]
  const holdingVisible = lineCount > lines.length

  // Narration pacing + graph spawn hooks: the narration and the constellation
  // always agree on what has "happened".
  useEffect(() => {
    const canvas = () => canvasRef.current
    if (reduced) {
      setLineCount(lines.length + 1)
      setVoucherTick(preview.voucherCount)
      return
    }
    const timers: number[] = []
    const at = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, ms))
    const hasCps = model.totalCounterparties > 0
    at(300, () => {
      setLineCount(1)
      canvas()?.spawn('ring')
    })
    at(1500, () => {
      setLineCount(2)
      canvas()?.spawn('bucket')
      canvas()?.feed(2100)
      ;[0, 1, 2, 3].forEach((w) =>
        timers.push(window.setTimeout(() => canvas()?.spawn('account', w), 200 + w * 420))
      )
      const t0 = performance.now()
      const tick = () => {
        const p = Math.min(1, (performance.now() - t0) / 1600)
        setVoucherTick(Math.round(preview.voucherCount * p))
        if (p < 1) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    at(3400, () => setLineCount(3))
    if (hasCps) {
      at(4600, () => {
        setLineCount(4)
        ;[0, 1, 2].forEach((w) =>
          timers.push(window.setTimeout(() => canvas()?.spawn('counterparty', w), 120 + w * 420))
        )
      })
    }
    at(hasCps ? 6000 : 4600, () => {
      setLineCount(hasCps ? 5 : 4)
      canvas()?.pulse()
    })
    at(hasCps ? 7100 : 5700, () => setLineCount(lines.length + 1))
    return () => timers.forEach((id) => window.clearTimeout(id))
  // The theater runs once per mount for one (model, preview) pair.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="grid gap-6 md:grid-cols-[280px_1fr]">
      <div role="status" aria-live="polite">
        <ol className="space-y-0">
          {lines.map((line, i) => {
            const visible = lineCount > i
            const active = lineCount === i + 1 && !holdingVisible
            return (
              <li
                key={line.title}
                className={`border-b border-border/60 py-2.5 transition-opacity duration-500 last:border-b-0 ${
                  visible ? 'opacity-100' : 'opacity-0'
                }`}
              >
                <p className="text-sm">{line.title}</p>
                <p
                  className={`mt-0.5 min-h-4 text-xs tabular-nums ${
                    visible && line.ok && !active
                      ? 'text-success'
                      : visible && line.warn
                        ? 'text-warning'
                        : 'text-muted-foreground'
                  }`}
                >
                  {visible ? line.sub : null}
                </p>
              </li>
            )
          })}
        </ol>
        {holdingVisible && (
          <p className="mt-4 text-xs text-muted-foreground tabular-nums">
            {t('theater_writing')} {elapsed}s
          </p>
        )}
      </div>
      <div className="relative min-h-[340px] md:min-h-[420px]">
        <TheaterCanvas ref={canvasRef} model={model} />
      </div>
    </div>
  )
}
