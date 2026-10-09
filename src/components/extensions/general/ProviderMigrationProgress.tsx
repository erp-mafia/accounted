'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { AttnLine } from '@/components/ui/attn-line'
import { migrationProgress, migrationIssueKind, migrationRefusals, type ProviderMigrationStatus } from '@/lib/providers/migration-contract'
import ProviderMigrationIssues, { migrationProviderName } from './ProviderMigrationIssues'

const ROOT = '/api/extensions/ext/arcim-migration/migration-jobs'

export default function ProviderMigrationProgress({ jobId, onResult, onReconnect }: {
  onReconnect: (status: ProviderMigrationStatus) => void
  jobId: string
  onResult: (status: ProviderMigrationStatus) => void
}) {
  const t = useTranslations('extensions')
  const [status, setStatus] = useState<ProviderMigrationStatus | null>(null)
  const [disconnected, setDisconnected] = useState(false)
  const [busy, setBusy] = useState<'retry' | 'accept' | null>(null)
  const [actionFailed, setActionFailed] = useState<'retry' | 'accept' | null>(null)
  const [refresh, setRefresh] = useState(0)
  const onResultRef = useRef(onResult)
  useEffect(() => { onResultRef.current = onResult }, [onResult])

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let lastNudge = 0
    async function poll() {
      try {
        const response = await fetch(`${ROOT}?jobId=${encodeURIComponent(jobId)}`, { signal: controller.signal, cache: 'no-store' })
        if (!response.ok) throw new Error('status unavailable')
        const data = await response.json() as { data: ProviderMigrationStatus }
        if (controller.signal.aborted) return
        setStatus(data.data)
        setDisconnected(false)
        if (data.data.job.state === 'completed') {
          onResultRef.current(data.data)
          return
        }
        if (data.data.job.state === 'needs_attention') return
        // Cron remains authoritative. This nudge also allows local development
        // to make progress without a hosted scheduler.
        if (Date.now() - lastNudge > 30_000) {
          lastNudge = Date.now()
          void fetch(`${ROOT}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobId }), signal: controller.signal }).catch(() => {})
        }
      } catch {
        if (!controller.signal.aborted) setDisconnected(true)
      }
      if (!controller.signal.aborted) timer = setTimeout(() => { void poll() }, 2500)
    }
    void poll()
    return () => { controller.abort(); if (timer) clearTimeout(timer) }
  }, [jobId, refresh])

  const act = useCallback(async (action: 'retry' | 'accept') => {
    setBusy(action)
    setActionFailed(null)
    try {
      const response = await fetch(`${ROOT}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId }) })
      if (!response.ok) throw new Error(`${action} unavailable`)
      setRefresh(n => n + 1)
    } catch { setActionFailed(action) }
    finally { setBusy(null) }
  }, [jobId])

  const needsAttention = status?.job.state === 'needs_attention'
  // Every record has an outcome: the import is done, only the review remains.
  const review = needsAttention && status?.review.acceptable ? status.review : null
  const provider = migrationProviderName(status?.job.provider)
  return (
    <div className="space-y-6" aria-live="polite">
      <div className="space-y-2">
        {review
          ? <h2 className="font-display text-2xl leading-8 tracking-tight text-balance">{t('ext_arcim_review_title', { count: review.total })}</h2>
          : <p className="text-sm">{t(needsAttention ? 'ext_arcim_job_attention' : 'ext_arcim_job_running')}</p>}
        <p className="text-sm text-muted-foreground">
          {review ? t('ext_arcim_review_lede', { provider }) : t('ext_arcim_job_background')}
        </p>
      </div>
      {status && <>
        {!review && <>
          <p className="text-sm">{t(`ext_arcim_job_phase_${status.job.phase}`)}</p>
          <Progress value={migrationProgress(status)} className="h-1" />
        </>}
        <ul className="space-y-2 text-sm">
          {status.counts.map(row => <li key={row.resource} className="flex flex-wrap justify-between gap-2">
            <span>{t(`ext_arcim_job_resource_${row.resource}`)}</span>
            <span className="tabular-nums text-muted-foreground">{t('ext_arcim_job_counts', {
              imported: row.imported, total: row.total, pending: row.pending, failed: row.needs_attention,
            })}{row.skipped > 0 && `, ${t('ext_arcim_job_counts_skipped', { skipped: row.skipped })}`}</span>
          </li>)}
        </ul>
        {migrationRefusals(status.job).map(group => <div key={group.messageKey} className="space-y-1 text-sm">
          <p>{t('ext_arcim_job_refused', {
            resources: group.resources.map(resource => t(`ext_arcim_job_resource_${resource}`)).join(', '),
          })}</p>
          <p className="text-muted-foreground">{t(group.messageKey, { provider })}</p>
        </div>)}
        {/* The job counts skipped records but not why (agent feedback seq 939430). */}
        {status.counts.some(row => row.skipped > 0) && (
          <p className="text-sm text-muted-foreground">{t('ext_arcim_job_skipped_explanation')}</p>
        )}
      </>}
      {disconnected && <p className="text-sm text-muted-foreground">{t('ext_arcim_job_connection')}</p>}
      {review && status && <div className="space-y-6">
        <ProviderMigrationIssues issues={status.issues} provider={status.job.provider}
          total={review.total} truncated={review.truncated} />
        {review.unchanged && <div className="space-y-1">
          <AttnLine>{t('ext_arcim_review_unchanged', { provider })}</AttnLine>
          <p className="text-[13px] text-muted-foreground">{t('ext_arcim_review_unchanged_next')}</p>
        </div>}
        {actionFailed && <p className="text-sm text-destructive">
          {t(actionFailed === 'accept' ? 'ext_arcim_review_accept_failed' : 'ext_arcim_review_retry_failed')}
        </p>}
        <div className="flex flex-col-reverse gap-3 border-t border-border pt-6 sm:flex-row sm:justify-end">
          {!review.unchanged && <Button variant="outline" onClick={() => void act('retry')}
            loading={busy === 'retry'} disabled={busy !== null}>
            {t('ext_arcim_review_retry', { count: review.total })}
          </Button>}
          <Button onClick={() => void act('accept')} loading={busy === 'accept'} disabled={busy !== null}>
            {t('ext_arcim_review_accept')}
          </Button>
        </div>
      </div>}
      {needsAttention && !review && <div className="space-y-3">
        <p className="text-sm text-muted-foreground">{t('ext_arcim_job_attention_detail')}</p>
        {status?.job.error_code && <p className="text-sm">{t(`ext_arcim_job_error_${migrationIssueKind(status.job.error_code)}`)}</p>}
        {status?.issues.length ? <ProviderMigrationIssues issues={status.issues} provider={status.job.provider}
          total={status.review.total} truncated={status.review.truncated} /> : null}
        {actionFailed === 'retry' && <p className="text-sm text-destructive">{t('ext_arcim_review_retry_failed')}</p>}
        {status?.job.error_code === 'PROVIDER_AUTH_EXPIRED' && <Button variant="outline" onClick={() => onReconnect(status)}>{t('ext_arcim_job_reconnect')}</Button>}
        <Button onClick={() => void act('retry')} loading={busy === 'retry'} disabled={busy !== null}>{t('ext_arcim_job_retry')}</Button>
      </div>}
    </div>
  )
}
