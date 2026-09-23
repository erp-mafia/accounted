'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { migrationProgress, migrationIssueKind, type ProviderMigrationStatus } from '@/lib/providers/migration-contract'

const ROOT = '/api/extensions/ext/arcim-migration/migration-jobs'

export default function ProviderMigrationProgress({ jobId, onResult, onReconnect }: {
  onReconnect: (status: ProviderMigrationStatus) => void
  jobId: string
  onResult: (status: ProviderMigrationStatus) => void
}) {
  const t = useTranslations('extensions')
  const [status, setStatus] = useState<ProviderMigrationStatus | null>(null)
  const [disconnected, setDisconnected] = useState(false)
  const [retrying, setRetrying] = useState(false)
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

  const retry = useCallback(async () => {
    setRetrying(true)
    try {
      const response = await fetch(`${ROOT}/retry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId }) })
      if (!response.ok) throw new Error('retry unavailable')
      setRefresh(n => n + 1)
    } catch { setDisconnected(true) }
    finally { setRetrying(false) }
  }, [jobId])

  const needsAttention = status?.job.state === 'needs_attention'
  return (
    <div className="space-y-6" aria-live="polite">
      <div className="space-y-2">
        <p className="text-sm">{t(needsAttention ? 'ext_arcim_job_attention' : 'ext_arcim_job_running')}</p>
        <p className="text-sm text-muted-foreground">{t('ext_arcim_job_background')}</p>
      </div>
      {status && <>
        <p className="text-sm">{t(`ext_arcim_job_phase_${status.job.phase}`)}</p>
        <Progress value={migrationProgress(status)} className="h-1" />
        <ul className="space-y-2 text-sm">
          {status.counts.map(row => <li key={row.resource} className="flex flex-wrap justify-between gap-2">
            <span>{t(`ext_arcim_job_resource_${row.resource}`)}</span>
            <span className="tabular-nums text-muted-foreground">{t('ext_arcim_job_counts', {
              imported: row.imported, total: row.total, pending: row.pending, failed: row.needs_attention,
            })}</span>
          </li>)}
        </ul>
      </>}
      {disconnected && <p className="text-sm text-muted-foreground">{t('ext_arcim_job_connection')}</p>}
      {needsAttention && <div className="space-y-3">
        <p className="text-sm text-muted-foreground">{t('ext_arcim_job_attention_detail')}</p>
        {status?.job.error_code && <p className="text-sm">{t(`ext_arcim_job_error_${migrationIssueKind(status.job.error_code)}`)}</p>}
        {status?.issues.length ? <ul className="space-y-1 text-sm text-muted-foreground">
          {status.issues.slice(0, 10).map(issue => <li key={issue.id}>
            {t(`ext_arcim_job_resource_${issue.resource}`)}: {issue.source_id}: {t(`ext_arcim_job_error_${migrationIssueKind(issue.error_code)}`)}
          </li>)}
        </ul> : null}
        {status?.job.error_code === 'PROVIDER_AUTH_EXPIRED' && <Button variant="outline" onClick={() => onReconnect(status)}>{t('ext_arcim_job_reconnect')}</Button>}
        <Button onClick={retry} disabled={retrying}>{t('ext_arcim_job_retry')}</Button>
      </div>}
    </div>
  )
}
