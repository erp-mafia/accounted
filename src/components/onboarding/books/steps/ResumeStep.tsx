'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { useCompany } from '@/contexts/CompanyContext'
import { useAccounts } from '@/lib/reference-data/hooks'
import { invalidateReferenceData } from '@/lib/reference-data/invalidate'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { waitForSIEJob } from '@/lib/import/sie-job-client'
import { Theater, type TheaterLine, type TheaterModelInput } from '../ui/Theater'
import type { TheaterApi } from '../engines/theater-engine'
import { jobProgress, type JobPhase } from '../lib/job-progress'
import type { BooksCtx } from '../context'
import { Button } from '@/components/ui/button'

/**
 * The act reopened while an import job was still running (a reload mid
 * import, a return from another tab). The job is durable and the worker
 * keeps writing, so this step picks the theatre back up on that job: the
 * chart of accounts stands in for the file's account list, the count
 * follows the job's chunks, and the genomlysning takes over when it lands.
 * A job that fails or pauses says so and offers the source list again.
 */
export function ResumeStep({ ctx, importId }: { ctx: BooksCtx; importId: string }) {
  const t = useTranslations('books')
  const locale = useLocale() === 'en' ? 'en' : 'sv'
  const { company } = useCompany()
  const { accounts } = useAccounts(true)
  const { dispatch, loadFindings } = ctx
  const [api, setApi] = useState<TheaterApi | null>(null)
  const [shown, setShown] = useState(0)
  const [tick, setTick] = useState(0)
  const [prepared, setPrepared] = useState(0)
  const [total, setTotal] = useState(0)
  const [jobPhase, setJobPhase] = useState<JobPhase | null>('preparing')
  const [error, setError] = useState<string | null>(null)
  const started = useRef(false)

  const model = useMemo<TheaterModelInput | null>(
    () =>
      accounts.length > 0
        ? {
            company: company?.name ?? '',
            accounts: accounts.map((a) => ({ number: a.account_number, name: a.account_name, weight: 1 })),
            counterparties: [],
          }
        : null,
    [accounts, company?.name],
  )

  useEffect(() => {
    if (!api || started.current) return
    started.current = true
    const controller = new AbortController()
    setShown(1)
    api.spawnAccounts()
    api.feedVouchers(15 * 60_000, 1)
    api.setFeedCap(0)
    dispatch({ type: 'SET_WORKING', working: true })
    void (async () => {
      try {
        const result = await waitForSIEJob(
          importId,
          (job) => {
            const { written, phase } = jobProgress(job)
            const sourceTotal = phase === 'preparing' ? 0 : job.prepared_through ?? 0
            setTotal(sourceTotal)
            setPrepared(job.prepared_through ?? 0)
            setTick(written)
            api.setFeedTotal(Math.max(1, sourceTotal, written))
            api.setFeedCap(written)
            setJobPhase(phase)
          },
          controller.signal,
        )
        if (controller.signal.aborted) return
        setJobPhase(null)
        setTick(result.journalEntriesCreated ?? total)
        api.pulse()
        api.settle()
        void invalidateReferenceData(['ref:accounts', 'ref:fiscal-periods'])
        // The file's own account list is gone with the reload: every account
        // in the chart is a candidate for the momskod check instead.
        dispatch({ type: 'IMPORTED', accounts: accounts.map((a) => a.account_number) })
        void loadFindings()
        dispatch({ type: 'TO_INSIGHT' })
      } catch (err) {
        if (controller.signal.aborted) return
        setJobPhase(null)
        setError(getErrorMessage(err, { locale }))
        api.settle()
      } finally {
        if (!controller.signal.aborted) dispatch({ type: 'SET_WORKING', working: false })
      }
    })()
    return () => controller.abort()
    // accounts/total are read once at start on purpose: the job drives the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, importId])

  const lines: TheaterLine[] = [
    {
      title: t('th_write'),
      sub:
        jobPhase === 'preparing'
          ? t('progress_preparing')
          : jobPhase === 'checking'
            ? t('th_write_checking')
            : error ?? t('progress_written', { count: tick.toLocaleString('sv-SE') }),
      tone: error ? 'err' : 'ok',
    },
  ]

  return (
    <div className="bks-host">
      <div className="jny-qstep" style={{ textAlign: 'center' }}>
        <h1 className="jny-qtitle">{t('resume_title')}</h1>
        <p className="jny-qsub">{t('resume_sub')}</p>
      </div>
      {model ? (
        <Theater
          model={model}
          lines={lines}
          shown={shown}
          settled={!!error}
          hold={!error ? t('sie_hold_open') : null}
          progress={{ phase: error ? 'failed' : jobPhase ?? 'checking', written: tick, total, prepared }}
          onApi={setApi}
          groupLabels={{ tillgangar: t('grp_assets'), skulder: t('grp_liabilities'), intakter: t('grp_revenue'), kostnader: t('grp_costs') }}
          reviewLabel={t('grp_review')}
        />
      ) : null}
      {error ? (
        <div className="jny-qactions">
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => dispatch({ type: 'GO_BACK', flags: ctx.flags })}>
            {t('provider_change_source')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
