'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'

/** Saved decisions remain reachable even after another import becomes latest. */
export default function ProviderMigrationReviews({ onOpen }: { onOpen: (jobId: string) => void }) {
  const t = useTranslations('extensions')
  const [jobs, setJobs] = useState<{ id: string; review_deferred_at: string }[]>([])
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        const response = await fetch('/api/extensions/ext/arcim-migration/migration-jobs/reviews', { cache: 'no-store', signal: controller.signal })
        if (!response.ok) throw new Error('Saved reviews unavailable')
        const body = await response.json()
        if (!controller.signal.aborted) setJobs(body.data)
      } catch { if (!controller.signal.aborted) setFailed(true) }
    })()
    return () => controller.abort()
  }, [])
  if (failed) return <p role="alert" className="text-sm">{t('ext_arcim_job_reviews_error')}</p>
  if (!jobs.length) return null
  return <section className="space-y-2">
    <h3 className="font-medium">{t('ext_arcim_job_reviews_title')}</h3>
    <ul className="space-y-2">{jobs.map(job => <li key={job.id}>
      <Button variant="outline" onClick={() => onOpen(job.id)}>{t('ext_arcim_job_reviews_open', { date: job.review_deferred_at.slice(0, 10) })}</Button>
    </li>)}</ul>
  </section>
}
