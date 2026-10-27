'use client'

import { useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { useCompany } from '@/contexts/CompanyContext'
import { useFormat } from '@/lib/hooks/use-format'
import { CLEAN_BATCHES_FOR_AUTOMATIC, type AutomaticReminderState } from '@/lib/reminders/automatic'
import { errorLocale, fetchAutomaticReminders, saveAutomaticReminders } from './reminders-client'

/**
 * Automatic reminders (accounted#104, phase 4): after three batches in a row
 * approved without changes, an owner or administrator may let the daily
 * batch send itself. Only reminders whose bank check passed then go out by
 * themselves; the uncertain ones still wait in Att göra. Shown in the
 * reminder settings sheet (state passed in) and after a batch is approved
 * (offerOnly: fetched here, shown only when it may be offered).
 */
export function AutomaticRemindersControl({
  state: given,
  offerOnly = false,
  onChanged,
}: {
  state?: AutomaticReminderState | null
  offerOnly?: boolean
  onChanged?: (state: AutomaticReminderState) => void
}) {
  const t = useTranslations('reminders_setup')
  const locale = errorLocale(useLocale())
  const { formatDateLong } = useFormat()
  const { role } = useCompany()
  const canManage = role === 'owner' || role === 'admin'
  const [fetched, setFetched] = useState<AutomaticReminderState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (given !== undefined) return
    let cancelled = false
    void fetchAutomaticReminders(locale).then((call) => {
      // Only an offer reads it here: without an answer, nothing is offered.
      if (!cancelled && call.ok) setFetched(call.data)
    })
    return () => {
      cancelled = true
    }
  }, [given, locale])

  const state = given ?? fetched
  if (!state) return null
  if (offerOnly && (state.on || !state.eligible || !canManage)) return null

  async function change(enabled: boolean) {
    setBusy(true)
    setError(null)
    const call = await saveAutomaticReminders(locale, enabled)
    setBusy(false)
    if (!call.ok) {
      setError(call.message)
      return
    }
    setFetched(call.data)
    onChanged?.(call.data)
  }

  return (
    <div className="space-y-2 text-[13px] leading-relaxed">
      {state.on ? (
        <p>{t('automatic_on', { date: state.since ? formatDateLong(state.since) : '' })}</p>
      ) : state.eligible ? (
        <p>{t('automatic_offer', { count: CLEAN_BATCHES_FOR_AUTOMATIC })}</p>
      ) : (
        <p className="text-muted-foreground">
          {t('automatic_not_yet', { streak: state.cleanStreak, count: CLEAN_BATCHES_FOR_AUTOMATIC })}
        </p>
      )}
      {canManage && (state.on || state.eligible) && (
        <Button size="sm" variant={state.on ? 'outline' : 'default'} loading={busy} onClick={() => change(!state.on)}>
          {state.on ? t('automatic_turn_off') : t('automatic_turn_on')}
        </Button>
      )}
      {error && <p className="text-destructive">{error}</p>}
    </div>
  )
}
