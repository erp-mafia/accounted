'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Progress } from '@/components/ui/progress'
import { Button } from '@/components/ui/button'
import { DestructiveConfirmDialog } from '@/components/ui/destructive-confirm-dialog'
import { fetchSIEJob } from '@/lib/import/sie-job-client'
import type { SIEJob } from '@/lib/import/sie-job-contract'
import type { ImportResult } from '@/lib/import/types'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import Link from 'next/link'

export default function SIEJobProgress({importId,onCompleted,onUndone}:{
  importId:string;onCompleted?:(result:ImportResult)=>void;onUndone?:()=>void
}) {
  const t = useTranslations('import.sie_job')
  const [job,setJob] = useState<SIEJob|null>(null)
  const [error,setError] = useState<string|null>(null)
  const [confirmUndo,setConfirmUndo] = useState(false)
  const [busy,setBusy] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    let timer:ReturnType<typeof setTimeout>
    async function poll() {
      try {
        const next = await fetchSIEJob(importId,controller.signal)
        setJob(next);setError(null)
        if (next.job_state === 'completed') {
          if (next.job_kind !== 'duplicate_repair') onCompleted?.(next.job_result as unknown as ImportResult)
          return
        }
        if (next.job_state === 'undone') {onUndone?.();return}
        if (next.job_state === 'failed') return
      } catch { if (!controller.signal.aborted) setError(t('connection')) }
      if (!controller.signal.aborted) timer = setTimeout(poll,2000)
    }
    void poll()
    return () => {controller.abort();clearTimeout(timer)}
  },[importId,onCompleted,onUndone,t])
  async function act(action:'resume'|'undo') {
    setBusy(true)
    try {
      const response = await fetch(`/api/import/sie/${importId}/action`,{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action}),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(getErrorMessage(body))
      setJob(body.data);setError(null);setConfirmUndo(false)
    } catch (err) {setError(getErrorMessage(err))}
    finally {setBusy(false)}
  }
  const terminal = job && ['completed','undone','failed'].includes(job.job_state)
  const canResume = job && ['paused', 'reconciling'].includes(job.job_state)
  return <section className="space-y-4 rounded-lg border border-border p-6" aria-label={t('title')}>
    <div role="status" aria-live="polite" className="space-y-2">
      <p className="text-sm font-medium">{job?.job_result?.repairOutcome === 'stopped' ? t('repairStopped') : job ? t(`states.${job.job_state}`) : t('loading')}</p>
      <p className="text-sm text-muted-foreground">{job ? t('progress',{done:job.chunks_done,total:job.chunks_total,count:job.transactions_count}) : t('durable')}</p>
      <Progress value={job?.chunks_total ? 100*job.chunks_done/job.chunks_total : 0}/>
    </div>
    {!terminal && <p className="text-sm text-muted-foreground">{t('durable')}</p>}
    {(error || job?.error_message) && <p role="alert" className="text-sm text-destructive">{error ?? job?.error_message}</p>}
    {job?.job_result?.repairOutcome === 'stopped' && <p className="text-sm text-muted-foreground">
      {t('repairStoppedDetails',{reversed:Number(job.job_result.reversed),cancelled:Number(job.job_result.cancelled)})}
    </p>}
    {!terminal && <div className="flex flex-wrap gap-3">
      {canResume && <Button variant="outline" disabled={busy} onClick={() => void act('resume')}>{t('resume')}</Button>}
      {job?.job_kind !== 'duplicate_repair' && <Button variant="ghost" disabled={busy || job?.job_state === 'undoing'} onClick={() => setConfirmUndo(true)}>{t('undo')}</Button>}
    </div>}
    {job?.job_state === 'failed' && <Button variant="outline" asChild>
      <Link href="/import?mode=sie">{t('newImport')}</Link>
    </Button>}
    <DestructiveConfirmDialog open={confirmUndo} onOpenChange={setConfirmUndo} title={t('undo')}
      description={t('undoConfirm')} confirmLabel={t('undo')} onConfirm={() => act('undo')}/>
  </section>
}
