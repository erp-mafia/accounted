'use client'

import Link from 'next/link'
import { formatCurrency } from '@/lib/utils'
import HistoricalReceivableFindings from './HistoricalReceivableFindings'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import { useCompany } from '@/contexts/CompanyContext'


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
  const { role } = useCompany()
  const [confirmFinish, setConfirmFinish] = useState(false)
  const [finishing, setFinishing] = useState(false)
  const [finishError, setFinishError] = useState(false)
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

  async function finishWithReview() {
    if (finishing) return
    setFinishing(true); setFinishError(false)
    try {
      const response = await fetch(`${ROOT}/finish-with-review`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId }) })
      if (!response.ok) throw new Error('Review decision refused')
      setConfirmFinish(false)
      setRefresh(n => n + 1)
    } catch { setFinishError(true) }
    finally { setFinishing(false) }
  }

  const needsAttention = status?.job.state === 'needs_attention'
  const remainingReview = status?.counts.reduce((sum, row) => sum + row.needs_attention, 0) ?? 0
  const unimported = status?.issues.filter(issue => !issue.targetId).length ?? 0
  const deferred = status?.job.state === 'completed' && remainingReview > 0
  const canFinish = needsAttention && status?.job.phase === 'completed' && !status.job.error_code && remainingReview > 0 && status.counts.every(row => row.pending === 0)
  return (
    <div className="space-y-6" aria-live="polite">
      <div className="space-y-2">
        <p className="text-sm">{t(deferred ? 'ext_arcim_job_deferred' : needsAttention ? 'ext_arcim_job_attention' : status?.job.state === 'completed' ? 'ext_arcim_historical_finished' : 'ext_arcim_job_running')}</p>
        <p className="text-sm text-muted-foreground">{t(deferred ? 'ext_arcim_job_deferred_detail' : needsAttention ? 'ext_arcim_job_paused' : status?.job.state === 'completed' ? 'ext_arcim_historical_finished_detail' : 'ext_arcim_job_background')}</p>
      </div>
      {status && <>
        <p className="text-sm">{t(`ext_arcim_job_phase_${status.job.phase}`)}</p>
        <Progress value={migrationProgress(status)} className="h-1" />
        <ul className="space-y-2 text-sm">
          {status.counts.map(row => <li key={row.resource} className="flex flex-wrap justify-between gap-2">
            <span>{t(`ext_arcim_job_resource_${row.resource}`)}</span>
            <span className="tabular-nums text-muted-foreground">{t((row.unchanged ?? 0) > 0 ? 'ext_arcim_job_delta_counts' : 'ext_arcim_job_counts', {
              imported: row.imported, unchanged:row.unchanged ?? 0, total: row.total, skipped: row.skipped ?? 0, pending: row.pending, failed: row.needs_attention,
            })}</span>
          </li>)}
        </ul>
      </>}
      {status && ['needs_attention', 'completed'].includes(status.job.state) && (!status.counts.some(row => (row.unchanged ?? 0) > 0) || status.issues.some(issue => issue.resource==='salesInvoices')) &&
        <HistoricalReceivableFindings jobId={jobId} onApproved={() => setRefresh(n => n + 1)} />}
      {!!status?.changes?.length && <section className="space-y-3">
        <h3 className="font-medium">{t('ext_arcim_job_changes')}</h3>
        <ul className="space-y-2 text-sm">{status.changes.map(change => <li key={change.id} data-ph-mask="">
          {t(change.kind==='new' ? 'ext_arcim_job_change_new' : 'ext_arcim_job_change_changed')}{' · '}
          {['salesInvoices','supplierInvoices'].includes(change.resource)
            ? <Link className="underline" href={`/${change.resource==='salesInvoices' ? 'invoices' : 'supplier-invoices'}/${change.targetId}`}>{change.label}</Link>
            : change.label}
        </li>)}</ul>
      </section>}
      {status?.job.state === 'completed' && <Button onClick={() => onResultRef.current(status)}>{t('ext_arcim_historical_results')}</Button>}
      {disconnected && <p className="text-sm text-muted-foreground">{t('ext_arcim_job_connection')}</p>}
      {(needsAttention || deferred) && <div className="space-y-3">
        <p className="text-sm text-muted-foreground">{t('ext_arcim_job_attention_detail')}</p>
        {status?.job.error_code && <p className="text-sm">{t(`ext_arcim_job_error_${migrationIssueKind(status.job.error_code)}`)}</p>}
        {status?.issues.length ? <div className="space-y-3">
          <h3 className="font-medium">{t('ext_arcim_job_issues_title')}</h3>
          <ul className="space-y-4 text-sm">
            {status.issues.slice(0, 10).map(issue => <li key={issue.id} className="space-y-2 border-b border-border pb-4">
              <p className="font-medium" data-ph-mask="">{t(`ext_arcim_job_resource_${issue.resource}`)}: {issue.invoiceNumber || issue.source_id}
                {issue.invoiceDate && ` · ${issue.invoiceDate}`}
                {issue.amount !== undefined && ` · ${formatCurrency(issue.amount, issue.currency)}`}
              </p>
              <p>{t(`ext_arcim_job_error_${migrationIssueKind(issue.error_code)}`)}</p>
              {issue.targetId && ['salesInvoices', 'supplierInvoices'].includes(issue.resource) &&
                <Link className="underline" href={`/${issue.resource === 'salesInvoices' ? 'invoices' : 'supplier-invoices'}/${issue.targetId}`}>
                  {t('ext_arcim_job_open_invoice')}
                </Link>}
              <details className="text-xs text-muted-foreground">
                <summary>{t('ext_arcim_job_technical_reference')}</summary>
                <p className="break-all font-mono">{issue.source_id} · {issue.error_code}</p>
              </details>
            </li>)}
          </ul>
        </div> : null}
        {status?.job.error_code === 'PROVIDER_AUTH_EXPIRED' && <Button variant="outline" onClick={() => onReconnect(status)}>{t('ext_arcim_job_reconnect')}</Button>}
        <Button variant="outline" onClick={retry} loading={retrying} disabled={role === 'viewer'}>{t('ext_arcim_job_retry')}</Button>
        {canFinish && <Button onClick={() => { setFinishError(false); setConfirmFinish(true) }} disabled={role === 'viewer'}>{t('ext_arcim_job_finish_review')}</Button>}
      </div>}
      <ConfirmationDialog open={confirmFinish} onOpenChange={open => { if (!finishing) setConfirmFinish(open) }}
        onConfirm={() => { void finishWithReview() }} isSubmitting={finishing}
        title={t('ext_arcim_job_finish_title')} confirmLabel={t('ext_arcim_job_finish_confirm')}>
        <p>{t('ext_arcim_job_finish_description', { count: remainingReview })}</p>
        <p className="mt-3">{t('ext_arcim_job_finish_unimported', { count: unimported })}</p>
        {finishError && <p role="alert" className="mt-3 text-destructive">{t('ext_arcim_job_finish_error')}</p>}
      </ConfirmationDialog>
    </div>
  )
}
