'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useToast } from '@/components/ui/use-toast'
import { SettingsRow, SettingsRowNote, SettingsSelect } from '@/components/settings/SettingsRows'
import { getErrorMessage } from '@/lib/errors/get-error-message'

type Model = 'expense' | 'capitalise'

/**
 * K3 punkt 18.7: the model for internally generated intangible assets. Its
 * own request (PATCH /api/company/accounting-policies): the column lives on
 * companies, so the row opts out of the settings form's dirty tracking like
 * the framework row above it.
 */
export function DevelopmentModelForm() {
  const t = useTranslations('settings_bookkeeping')
  const { toast } = useToast()
  const [model, setModel] = useState<Model | ''>('')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/company/accounting-policies')
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (cancelled) return
        setModel((body?.data?.development_expenditure_model as Model | null) ?? '')
        setLoaded(true)
      })
      .catch(() => setLoaded(true))
    return () => {
      cancelled = true
    }
  }, [])

  async function persist(next: Model) {
    const previous = model
    setModel(next)
    setSaving(true)
    try {
      const res = await fetch('/api/company/accounting-policies', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ development_expenditure_model: next }),
      })
      const body = await res.json()
      if (!res.ok) {
        setModel(previous)
        toast({ title: t('development_model_failed'), description: getErrorMessage(body?.error ?? body), variant: 'destructive' })
        return
      }
      toast({ title: t('development_model_saved') })
    } catch (err) {
      setModel(previous)
      toast({ title: t('development_model_failed'), description: getErrorMessage(err), variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsRow label={t('development_model_label')} htmlFor="development_expenditure_model" help={t('development_model_help')}>
      <SettingsSelect
        id="development_expenditure_model"
        value={model}
        onChange={(e) => {
          if (e.target.value === 'expense' || e.target.value === 'capitalise') void persist(e.target.value)
        }}
        onInput={(e) => e.stopPropagation()}
        disabled={!loaded || saving}
      >
        <option value="" disabled>
          {t('development_model_unset')}
        </option>
        <option value="expense">{t('development_model_expense')}</option>
        <option value="capitalise">{t('development_model_capitalise')}</option>
      </SettingsSelect>
      {saving && <SettingsRowNote>{t('development_model_saving')}</SettingsRowNote>}
    </SettingsRow>
  )
}
