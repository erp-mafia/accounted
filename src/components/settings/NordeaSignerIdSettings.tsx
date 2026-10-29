'use client'

import { useTranslations } from 'next-intl'
import { SettingsGroup, SettingsInput, SettingsRow } from '@/components/settings/SettingsRows'
import { useCompany } from '@/contexts/CompanyContext'
import { usePaymentFileAccount } from '@/lib/hooks/use-payment-file-account'
import { isNordeaCompany } from '@/lib/payments/nordea'
import type { CompanySettings } from '@/types'

/**
 * Nordea's Signer ID for payment files (lib/payments/nordea.ts): the id every
 * pain.001 file to Nordea must name as its sender (crm#1530). Shown to an
 * owner or admin of a company whose bank resolves to Nordea, whose payment
 * files pay from a Nordea account (lib/payments/paying-account.ts), or that
 * already has an id saved, exactly like the Swedbank ids beside it. The row
 * sits inside the page's SettingsFormWrapper; nordeaSignerIdUpdates reads it
 * on save.
 */
export function NordeaSignerIdSettings({ settings }: { settings: CompanySettings }) {
  const t = useTranslations('settings_nordea_signer_id')
  const { role } = useCompany()
  const canEdit = role === 'owner' || role === 'admin'
  const { account: payingAccount } = usePaymentFileAccount(null, { enabled: canEdit })

  if (!canEdit) return null
  if (!isNordeaCompany(settings) && !payingAccount?.nordea && !settings.nordea_signer_id) return null

  return (
    <SettingsGroup label={t('heading')} help={t('help')}>
      <SettingsRow label={t('signer_id_label')} htmlFor="nordea_signer_id" help={t('signer_id_help')} align="baseline">
        <SettingsInput
          // Remount on a saved change so the field shows the stored,
          // normalised id (upper case, no spaces) after the save.
          key={settings.nordea_signer_id ?? ''}
          id="nordea_signer_id"
          name="nordea_signer_id"
          defaultValue={settings.nordea_signer_id ?? ''}
          autoComplete="off"
          spellCheck={false}
          maxLength={35}
        />
      </SettingsRow>
    </SettingsGroup>
  )
}

/**
 * The Signer ID to save from the page form: only when the row rendered and
 * the value differs from the stored one, so saving the rest of the page never
 * re-sends it. An emptied field clears the id; the server normalises and
 * validates the rest.
 */
export function nordeaSignerIdUpdates(formData: FormData, settings: CompanySettings): Record<string, string | null> {
  if (!formData.has('nordea_signer_id')) return {}
  const value = String(formData.get('nordea_signer_id') ?? '').trim()
  return value === (settings.nordea_signer_id ?? '') ? {} : { nordea_signer_id: value || null }
}
