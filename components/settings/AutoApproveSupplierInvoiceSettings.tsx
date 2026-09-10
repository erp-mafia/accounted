'use client'

import { useTranslations } from 'next-intl'
import { useCallback, useState } from 'react'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/use-toast'
import {
  SettingsGroup,
  SettingsRow,
  SettingsRowEnd,
} from '@/components/settings/SettingsRows'
import type { CompanySettings } from '@/types'

interface AutoApproveSupplierInvoiceSettingsProps {
  settings: CompanySettings
  onUpdate: (updates: Partial<CompanySettings>) => void
}

/**
 * Opt-in auto-approval of leverantörsfakturor after register. Off (default)
 * leaves aktiebolag invoices in status registered until someone clicks
 * Godkänn. Enskild firma still auto-approves in the create flow regardless.
 */
export function AutoApproveSupplierInvoiceSettings({
  settings,
  onUpdate,
}: AutoApproveSupplierInvoiceSettingsProps) {
  const t = useTranslations('settings_auto_approve_supplier_invoices')
  const { toast } = useToast()
  const [isSaving, setIsSaving] = useState(false)

  const saveToggle = useCallback(async (value: boolean) => {
    setIsSaving(true)
    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auto_approve_supplier_invoices: value }),
      })
      if (!response.ok) throw new Error()
      onUpdate({ auto_approve_supplier_invoices: value })
    } catch {
      toast({ title: t('toast_save_failed'), variant: 'destructive' })
    } finally {
      setIsSaving(false)
    }
  }, [onUpdate, toast, t])

  return (
    <SettingsGroup label={t('heading')}>
      <SettingsRow label={t('enable_label')} help={t('enable_help')}>
        <SettingsRowEnd>
          <Switch
            checked={settings.auto_approve_supplier_invoices ?? false}
            onCheckedChange={saveToggle}
            disabled={isSaving}
            aria-label={t('enable_label')}
          />
        </SettingsRowEnd>
      </SettingsRow>
    </SettingsGroup>
  )
}
