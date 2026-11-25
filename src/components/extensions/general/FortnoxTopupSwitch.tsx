'use client'

import { useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/use-toast'
import { formatDate } from '@/lib/utils'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import type { FortnoxTopupView } from '@/extensions/general/arcim-migration/lib/fortnox-topup'

/**
 * The nightly top-up's switch on a Fortnox connection, and what its latest
 * run did (lib/fortnox-topup.ts): vouchers added, nothing new, a night that
 * failed and is tried again, or why it stopped. After a change the page reads
 * the connections again (`onChanged`): the key's line depends on it too.
 */
export function FortnoxTopupSwitch({ consentId, initial, onChanged }: {
  consentId: string
  initial: FortnoxTopupView | null
  onChanged?: () => void
}) {
  const t = useTranslations('extensions')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const own = (value: FortnoxTopupView | null) => (value?.consentId === consentId ? value : null)
  const [view, setView] = useState<FortnoxTopupView | null>(own(initial))
  // The connections read again: the server's answer is the one shown.
  useEffect(() => setView(initial?.consentId === consentId ? initial : null), [initial, consentId])
  const [saving, setSaving] = useState(false)
  const enabled = view?.enabled ?? false
  const run = view?.lastRun ?? null
  const switchId = `fortnox-topup-${consentId}`

  async function toggle(next: boolean) {
    setSaving(true)
    try {
      const response = await fetch('/api/extensions/ext/arcim-migration/fortnox-topup', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ consentId, enabled: next }),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok) {
        toast({
          title: t('ext_arcim_topup_save_failed'),
          description: getErrorMessage(body, { locale, statusCode: response.status }),
          variant: 'destructive',
        })
        return
      }
      setView(own((body as { data: FortnoxTopupView | null }).data))
      onChanged?.()
    } catch (error) {
      toast({ title: t('ext_arcim_topup_save_failed'), description: getErrorMessage(error, { locale }), variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  const reason = run?.reason ? getErrorMessage(run.reason, { locale }) : ''
  const date = run ? formatDate(run.finishedAt ?? run.startedAt) : ''
  const left = run
    ? [run.skippedDuplicates > 0 ? t('ext_arcim_topup_duplicates', { count: run.skippedDuplicates }) : null,
        run.skippedReversed > 0 ? t('ext_arcim_topup_reversed', { count: run.skippedReversed }) : null]
    : []
  let line: string
  if (!enabled && run?.outcome === 'stopped') {
    line = [t('ext_arcim_topup_stopped', { date, reason }), run.added > 0 ? t('ext_arcim_topup_stopped_added', { count: run.added }) : null]
      .filter(Boolean).join(' ')
  } else if (!enabled) {
    line = t('ext_arcim_topup_description')
  } else if (!run) {
    line = t('ext_arcim_topup_first_run')
  } else if (run.outcome === 'running') {
    line = t('ext_arcim_topup_running')
  } else if (run.outcome === 'failed') {
    line = t('ext_arcim_topup_last_failed', { date, reason })
  } else {
    line = [run.outcome === 'added'
      ? t('ext_arcim_topup_last_added', { date, count: run.added })
      : t('ext_arcim_topup_last_nothing_new', { date }), ...left].filter(Boolean).join(' ')
  }

  return (
    <div className="mt-2 flex items-start gap-3">
      <Switch
        id={switchId}
        className="mt-0.5"
        checked={enabled}
        disabled={saving}
        aria-describedby={`${switchId}-line`}
        onCheckedChange={(next) => void toggle(next)}
      />
      <div className="min-w-0">
        <label htmlFor={switchId} className="text-xs font-medium">{t('ext_arcim_topup_label')}</label>
        <p id={`${switchId}-line`} className="mt-0.5 text-xs text-muted-foreground tabular-nums">{line}</p>
      </div>
    </div>
  )
}
