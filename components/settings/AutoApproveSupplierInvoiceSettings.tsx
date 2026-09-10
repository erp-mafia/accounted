'use client'

import { useTranslations } from 'next-intl'
import { useCallback, useState } from 'react'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/use-toast'
import { useCompanyOptional } from '@/contexts/CompanyContext'
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
 * Godkänn. Enskild firma always auto-approves in the create flow: the switch
 * is shown on and disabled so the setting is not a misleading no-op.
 */
export function AutoApproveSupplierInvoiceSettings({
  settings,
  onUpdate,
}: AutoApproveSupplierInvoiceSettingsProps) {
  const t = useTranslations('settings_auto_approve_supplier_invoices')
  const { toast } = useToast()
  const [isSaving, setIsSaving] = useState(false)
  const company = useCompanyOptional()?.company ?? null
  // Prefer the company row when settings.entity_type is stale on legacy data
  // (same pattern as BookkeepingSettingsContent).
  const isEF = (company?.entity_type ?? settings.entity_type) === 'enskild_firma'

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
      <SettingsRow label={t('enable_label')} help={isEF ? t('enable_help_ef') : t('enable_help')}>
        <SettingsRowEnd>
          <Switch
            checked={isEF ? true : (settings.auto_approve_supplier_invoices ?? false)}
            onCheckedChange={saveToggle}
            disabled={isEF || isSaving}
            aria-label={t('enable_label')}
          />
        </SettingsRowEnd>
      </SettingsRow>
    </SettingsGroup>
  )
}
