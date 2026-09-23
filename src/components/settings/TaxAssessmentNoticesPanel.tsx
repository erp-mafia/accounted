'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Pencil, Trash2 } from 'lucide-react'
import { FiscalYearSelector } from '@/components/common/FiscalYearSelector'
import { Button } from '@/components/ui/button'
import {
  SettingsGroup,
  SettingsInput,
  SettingsRow,
  SettingsRowNote,
  SettingsSelect,
} from '@/components/settings/SettingsRows'
import { useToast } from '@/components/ui/use-toast'
import { useErrorToast } from '@/lib/hooks/use-error-toast'
import type {
  TaxAssessmentDecisionType,
  TaxAssessmentNotice,
} from '@/types'

function todayLocalIso(): string {
  const today = new Date()
  const year = today.getFullYear()
  const month = String(today.getMonth() + 1).padStart(2, '0')
  const day = String(today.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function TaxAssessmentNoticesPanel() {
  const t = useTranslations('tax_assessment_notices')
  const { toast } = useToast()
  const showError = useErrorToast()
  const [notices, setNotices] = useState<TaxAssessmentNotice[]>([])
  const [selectedPeriodId, setSelectedPeriodId] = useState<string | null>(null)
  const [decisionType, setDecisionType] = useState<TaxAssessmentDecisionType>('final')
  const [decisionDate, setDecisionDate] = useState(todayLocalIso)
  const [paymentDueDate, setPaymentDueDate] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch('/api/tax-assessment-notices')
        if (!response.ok) {
          if (!cancelled) await showError(response, { context: 'settings' })
          return
        }
        const payload = await response.json() as { data: TaxAssessmentNotice[] }
        if (!cancelled) setNotices(payload.data)
      } catch (error) {
        if (!cancelled) await showError(error, { context: 'settings' })
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  // The error helper is recreated with the toast hook. This load should run
  // once per panel mount, not after every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const resetForm = () => {
    setEditingId(null)
    setDecisionType('final')
    setDecisionDate(todayLocalIso())
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
          <Button type="submit" size="sm" disabled={saving || !selectedPeriodId || !paymentDueDate}>
            {saving ? t('saving') : t(editingId ? 'update_action' : 'save_action')}
          </Button>
          {editingId && (
            <Button type="button" variant="outline" size="sm" onClick={resetForm} disabled={saving}>
              {t('cancel')}
            </Button>
          )}
        </div>
      </form>

      {/* Registered notices continue as flat hairline rows under the form. */}
      {!loading && notices.length > 0 && notices.map((notice) => (
        <div
          key={notice.id}
          className="flex flex-col gap-3 border-t border-border px-1 py-3 sm:flex-row sm:items-center sm:justify-between"
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
            <Button type="button" variant="outline" size="sm" onClick={() => editNotice(notice)} disabled={saving}>
              <Pencil className="mr-2 h-4 w-4" />
              {t('edit')}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => void archiveNotice(notice)} disabled={saving}>
              <Trash2 className="mr-2 h-4 w-4" />
              {t('archive')}
            </Button>
          </div>
        </div>
      ))}
    </SettingsGroup>
  )
}
