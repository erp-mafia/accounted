'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import { useToast } from '@/components/ui/use-toast'
import { useCompany } from '@/contexts/CompanyContext'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { useFiscalPeriods } from '@/lib/reference-data/hooks'
import { invalidateReferenceData } from '@/lib/reference-data/invalidate'
import { closableImportedYears, closeYearsInOrder } from '@/lib/onboarding/closable-imported-years'

/**
 * "Klarmarkera åren": the explicit, user-initiated close of imported
 * historical years, offered after a migration instead of closing them
 * automatically. A klarmarkerat year is closed and locked, and the
 * period-lock triggers then refuse linking further underlag to its
 * verifikat, so the offer says to link the old system's underlag first.
 *
 * Reuses the existing klarmarkera path (close-external, the same route the
 * Årsbokslut page calls) one year at a time, oldest first, and stops at the
 * first refusal. Renders nothing when no earlier year is still open.
 */
export function CloseImportedYearsOffer({
  showUnderlagLink = false,
  onClosed,
}: {
  showUnderlagLink?: boolean
  onClosed?: () => void
}) {
  const t = useTranslations('import')
  const { toast } = useToast()
  const { role } = useCompany()
  const { dialogProps, confirm } = useDestructiveConfirm()
  const { periods, refresh } = useFiscalPeriods()
  const [running, setRunning] = useState(false)

  const today = new Date().toISOString().slice(0, 10)
  const targets = useMemo(() => closableImportedYears(periods, today), [periods, today])

  if (role === 'member' || targets.length === 0) return null

  const names = targets.map((p) => p.name).join(', ')

  async function run() {
    const ok = await confirm({
      title: t('close_years_confirm_title'),
      description: t('close_years_confirm_body', { years: names }),
      confirmLabel: t('close_years_action'),
      cancelLabel: t('close_years_cancel'),
      variant: 'warning',
    })
    if (!ok) return
    setRunning(true)
    try {
      const result = await closeYearsInOrder(targets, async (id) => {
        const res = await fetch(`/api/bookkeeping/fiscal-periods/${id}/close-external`, { method: 'POST' })
        if (res.ok) return null
        // The route answers with the { error: { code, message } } envelope;
        // the refusal (for example unbooked bank transactions) is the useful part.
        const body = await res.json().catch(() => null)
        return body ? getErrorMessage(body, { statusCode: res.status }) : t('close_years_error_generic')
      })
      if (result.closed.length > 0) {
        void refresh()
        void invalidateReferenceData('ref:fiscal-periods')
        onClosed?.()
      }
      if (result.failed) {
        toast({
          title: t('close_years_failed_title', { name: result.failed.name }),
          description: result.failed.message,
          variant: 'destructive',
        })
      } else {
        toast({ title: t('close_years_done', { years: result.closed.join(', ') }) })
      }
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="space-y-2 rounded-lg border border-border p-4 text-sm">
      <p className="font-medium">{t('close_years_title', { count: targets.length, years: names })}</p>
      <p className="text-muted-foreground">{t('close_years_body')}</p>
      <div className="flex flex-wrap items-center gap-3 pt-1">
        <Button variant="outline" size="sm" loading={running} onClick={() => void run()}>
          {t('close_years_action')}
        </Button>
        {showUnderlagLink ? (
          <a href="/import?mode=underlag" className="text-muted-foreground underline underline-offset-4 hover:text-foreground">
            {t('close_years_underlag_link')}
          </a>
        ) : null}
      </div>
      <DestructiveConfirmDialog {...dialogProps} />
    </div>
  )
}
