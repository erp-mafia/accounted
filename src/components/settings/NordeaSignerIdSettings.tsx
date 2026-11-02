'use client'

import { useTranslations } from 'next-intl'
import { SettingsGroup, SettingsInput, SettingsRow } from '@/components/settings/SettingsRows'
import { useCompany } from '@/contexts/CompanyContext'
import { usePaymentFileAccount } from '@/lib/hooks/use-payment-file-account'
import { isNordeaCompany } from '@/lib/payments/nordea'
import type { CompanySettings } from '@/types'

/** The two company_settings columns this group edits, also its form field names. */
const NORDEA_FILE_ID_FIELDS = ['nordea_signer_id', 'nordea_agreement_id'] as const

/**
 * Nordea's ids for payment files (lib/payments/nordea.ts): the Signer ID
 * every pain.001 file to Nordea must name as its sender and the CCM
 * agreement id it must name as the debtor (crm#1530). Shown to an owner or
 * admin of a company whose bank resolves to Nordea, whose payment files pay
 * from a Nordea account (lib/payments/paying-account.ts), or that already
 * has an id saved, exactly like the Swedbank ids beside it. The rows sit
 * inside the page's SettingsFormWrapper; nordeaSignerIdUpdates reads them on
 * save.
 */
export function NordeaSignerIdSettings({ settings }: { settings: CompanySettings }) {
  const t = useTranslations('settings_nordea_signer_id')
  const { role } = useCompany()
  const canEdit = role === 'owner' || role === 'admin'
  const { account: payingAccount } = usePaymentFileAccount(null, { enabled: canEdit })

  if (!canEdit) return null
  const hasIds = Boolean(settings.nordea_signer_id || settings.nordea_agreement_id)
  if (!isNordeaCompany(settings) && !payingAccount?.nordea && !hasIds) return null

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
          placeholder="NB10000123456"
          autoComplete="off"
          spellCheck={false}
          maxLength={35}
        />
      </SettingsRow>
      <SettingsRow
        label={t('agreement_id_label')}
        htmlFor="nordea_agreement_id"
        help={t('agreement_id_help')}
        align="baseline"
      >
        <SettingsInput
          key={settings.nordea_agreement_id ?? ''}
          id="nordea_agreement_id"
          name="nordea_agreement_id"
          defaultValue={settings.nordea_agreement_id ?? ''}
          placeholder="NB123456"
          autoComplete="off"
          spellCheck={false}
          maxLength={35}
        />
      </SettingsRow>
    </SettingsGroup>
  )
}

/**
 * The Nordea ids to save from the page form: only fields the group rendered
 * and only when they differ from the stored value, so saving the rest of the
 * page never re-sends them. An emptied field clears the id; the server
 * normalises and validates the rest.
 */
export function nordeaSignerIdUpdates(formData: FormData, settings: CompanySettings): Record<string, string | null> {
  const updates: Record<string, string | null> = {}
  for (const field of NORDEA_FILE_ID_FIELDS) {
    if (!formData.has(field)) continue
    const value = String(formData.get(field) ?? '').trim()
    if (value !== (settings[field] ?? '')) updates[field] = value || null
  }
  return updates
}
