'use client'

import { useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { PencilIcon, TrashIcon } from '@/components/icons'
import { FiscalYearSelector } from '@/components/common/FiscalYearSelector'
import { Button } from '@/components/ui/button'
import { EmptyState, LoadError } from '@/components/ui/empty-state'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import {
  SettingsGroup,
  SettingsInput,
  SettingsRow,
  SettingsRowNote,
  SettingsSelect,
} from '@/components/settings/SettingsRows'
import { useToast } from '@/components/ui/use-toast'
import { useViewerLock } from '@/components/ui/viewer-lock'
import { useErrorToast } from '@/lib/hooks/use-error-toast'
import type {
  TaxAssessmentDecisionType,
  TaxAssessmentNotice,
} from '@/types'
import { todayIsoStockholm } from '@/lib/dates/iso'

export function TaxAssessmentNoticesPanel() {
  const t = useTranslations('tax_assessment_notices')
  const { toast } = useToast()
  const { canWrite, lockedTitle } = useViewerLock()
  const showError = useErrorToast()
  const locale = useLocale() as ErrorLocale
  const [notices, setNotices] = useState<TaxAssessmentNotice[]>([])
  const [selectedPeriodId, setSelectedPeriodId] = useState<string | null>(null)
  const [decisionType, setDecisionType] = useState<TaxAssessmentDecisionType>('final')
  const [decisionDate, setDecisionDate] = useState(todayIsoStockholm)
  const [paymentDueDate, setPaymentDueDate] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  // The list could not be read. The form hides with it: an empty form over a
  // list that failed to load invites a second notice for the same year.
  // message: the server's sentence for a 4xx about the company (no retry
  // helps); null: a failed read, with a retry.
  const [loadError, setLoadError] = useState<{ message: string | null } | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch('/api/tax-assessment-notices')
        if (!response.ok) {
          const body = await response.json().catch(() => null)
          const aboutCompany = response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429
          if (!cancelled) {
            setLoadError({
              message: aboutCompany
                ? getErrorMessage(body, { context: 'settings', statusCode: response.status, locale })
                : null,
            })
          }
          return
        }
        const payload = await response.json() as { data: TaxAssessmentNotice[] }
        if (!cancelled) {
          setNotices(payload.data)
          setLoadError(null)
        }
      } catch {
        if (!cancelled) setLoadError({ message: null })
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [reloadKey, locale])

  const resetForm = () => {
    setEditingId(null)
    setDecisionType('final')
    setDecisionDate(todayIsoStockholm())
    setPaymentDueDate('')
  }

  const saveNotice = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!selectedPeriodId || !paymentDueDate) return
    setSaving(true)
    try {
      const response = await fetch(
        editingId ? `/api/tax-assessment-notices/${editingId}` : '/api/tax-assessment-notices',
        {
          method: editingId ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fiscal_period_id: selectedPeriodId,
            decision_type: decisionType,
            decision_date: decisionDate,
            payment_due_date: paymentDueDate,
          }),
        },
      )
      if (!response.ok) {
        await showError(response, { context: 'settings' })
        return
      }
      const payload = await response.json() as { data: TaxAssessmentNotice }
      setNotices((current) => {
        const withoutSaved = current.filter((notice) => notice.id !== payload.data.id)
        return [...withoutSaved, payload.data]
          .sort((a, b) => a.payment_due_date.localeCompare(b.payment_due_date))
      })
      toast({ title: t(editingId ? 'updated' : 'saved') })
      resetForm()
    } catch (error) {
      await showError(error, { context: 'settings' })
    } finally {
      setSaving(false)
    }
  }

  const editNotice = (notice: TaxAssessmentNotice) => {
    setEditingId(notice.id)
    setSelectedPeriodId(notice.fiscal_period_id)
    setDecisionType(notice.decision_type)
    setDecisionDate(notice.decision_date)
    setPaymentDueDate(notice.payment_due_date)
  }

  const archiveNotice = async (notice: TaxAssessmentNotice) => {
    setSaving(true)
    try {
      const response = await fetch(`/api/tax-assessment-notices/${notice.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived: true }),
      })
      if (!response.ok) {
        await showError(response, { context: 'settings' })
        return
      }
      setNotices((current) => current.filter((item) => item.id !== notice.id))
      if (editingId === notice.id) resetForm()
      toast({ title: t('archived') })
    } catch (error) {
      await showError(error, { context: 'settings' })
    } finally {
      setSaving(false)
    }
  }

  return (
    // What this panel is for ("enter the exact payment date from the
    // slutskattebesked") is static guidance: it lives behind the group "?".
    <SettingsGroup label={t('title')} help={t('description')}>
      {loadError ? (
        loadError.message ? (
          <EmptyState title={loadError.message} className="pt-4" />
        ) : (
          <LoadError
            title={t('load_failed')}
            onRetry={() => {
              setLoadError(null)
              setLoading(true)
              setReloadKey((key) => key + 1)
            }}
            className="pt-4"
          />
        )
      ) : (
        <>
          <form onSubmit={saveNotice}>
            <SettingsRow label={t('fiscal_period')}>
              <FiscalYearSelector
                value={selectedPeriodId}
                onChange={(periodId) => setSelectedPeriodId(periodId)}
                includeAllOption={false}
                label={null}
                className="w-full max-w-72"
              />
            </SettingsRow>
            <SettingsRow label={t('decision_type')} htmlFor="tax-assessment-decision-type">
              <SettingsSelect
                id="tax-assessment-decision-type"
                value={decisionType}
                onChange={(event) => setDecisionType(event.target.value as TaxAssessmentDecisionType)}
              >
                <option value="final">{t('decision_final')}</option>
                <option value="reassessment">{t('decision_reassessment')}</option>
              </SettingsSelect>
            </SettingsRow>
            <SettingsRow
              label={t('decision_date')}
              htmlFor="tax-assessment-decision-date"
              align="baseline"
            >
              <SettingsInput
                id="tax-assessment-decision-date"
                type="date"
                required
                value={decisionDate}
                onChange={(event) => setDecisionDate(event.target.value)}
                className="max-w-40 flex-none tabular-nums"
              />
            </SettingsRow>
            <SettingsRow
              label={t('payment_due_date')}
              htmlFor="tax-assessment-payment-due-date"
              help={t('payment_due_date_help')}
              align="baseline"
            >
              <SettingsInput
                id="tax-assessment-payment-due-date"
                type="date"
                required
                min={decisionDate}
                value={paymentDueDate}
                onChange={(event) => setPaymentDueDate(event.target.value)}
                className="max-w-40 flex-none tabular-nums"
              />
            </SettingsRow>
            <div className="flex flex-wrap gap-2 px-1 py-3">
              <Button type="submit" disabled={!canWrite || saving || !selectedPeriodId || !paymentDueDate} title={lockedTitle}>
                {saving ? t('saving') : t(editingId ? 'update_action' : 'save_action')}
              </Button>
              {editingId && (
                <Button type="button" variant="outline" onClick={resetForm} disabled={saving}>
                  {t('cancel')}
                </Button>
              )}
            </div>
          </form>

          {/* Registered notices continue as flat hairline rows under the form. */}
          {!loading && notices.length > 0 && notices.map((notice) => (
            <div
              key={notice.id}
              className="flex flex-col gap-3 border-t-hairline px-1 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="text-sm">
                  {notice.decision_type === 'final' ? t('decision_final') : t('decision_reassessment')}
                  {notice.fiscal_period?.name ? `: ${notice.fiscal_period.name}` : ''}
                </p>
                <SettingsRowNote className="tabular-nums">
                  {t('due_summary', { date: notice.payment_due_date })}
                </SettingsRowNote>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button type="button" variant="outline" onClick={() => editNotice(notice)} disabled={!canWrite || saving} title={lockedTitle}>
                  <PencilIcon className="h-4 w-4" />
                  {t('edit')}
                </Button>
                <Button type="button" variant="outline" onClick={() => void archiveNotice(notice)} disabled={!canWrite || saving} title={lockedTitle}>
                  <TrashIcon className="h-4 w-4" />
                  {t('archive')}
                </Button>
              </div>
            </div>
          ))}
        </>
      )}
    </SettingsGroup>
  )
}
