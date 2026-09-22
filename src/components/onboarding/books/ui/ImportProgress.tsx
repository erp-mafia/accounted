'use client'

import { useTranslations } from 'next-intl'
import { Progress } from '@/components/ui/progress'
import { importPercent, type JobPhase } from '../lib/job-progress'

export interface ImportProgressProps {
  phase: JobPhase | 'complete' | 'failed'
  written: number
  total: number
  prepared?: number
  file?: { current: number; total: number }
}

export function ImportProgress({ phase, written, total, prepared = 0, file }: ImportProgressProps) {
  const t = useTranslations('books')
  const active = phase !== 'complete' && phase !== 'failed'
  const percent = phase === 'preparing' && written === 0
    ? null
    : importPercent(written, total, phase === 'complete')
  const label = t(`progress_${phase}`)
  const detail = phase === 'preparing'
    ? prepared > 0
      ? t('progress_prepared', { count: prepared.toLocaleString('sv-SE') })
      : total > 0 ? t('progress_total', { count: total.toLocaleString('sv-SE') }) : t('progress_wait')
    : t('progress_written', { count: written.toLocaleString('sv-SE') })

  return (
    <div className="th-progress" data-phase={phase} aria-busy={active}>
      <div className="th-progress-heading">
        <span className="th-progress-label">
          {active ? <span className="th-progress-activity" aria-hidden="true" /> : null}
          <span role="status">{label}</span>
        </span>
        {percent !== null ? <span className="tabular-nums">{percent}%</span> : null}
      </div>
      <Progress
        value={percent}
        className="th-progress-track h-1"
        aria-label={t('progress_label')}
        aria-valuetext={`${label}. ${detail}`}
      />
      <div className="th-progress-detail">
        <span>{detail}</span>
        {file && file.total > 1 ? <span>{t('progress_file', { current: file.current, total: file.total })}</span> : null}
      </div>
    </div>
  )
}
