'use client'

import { useTranslations } from 'next-intl'
import { SettingsGroup, SettingsInput, SettingsRow } from '@/components/settings/SettingsRows'
import { useCompany } from '@/contexts/CompanyContext'
import { usePaymentFileAccount } from '@/lib/hooks/use-payment-file-account'
import { isSwedbankCompany } from '@/lib/payments/swedbank'
import type { CompanySettings } from '@/types'

/** The two company_settings columns this group edits, also its form field names. */
const SWEDBANK_FILE_ID_FIELDS = ['swedbank_signer_id', 'swedbank_corporate_pay_id'] as const

/**
 * Swedbank's own ids for payment files (lib/payments/swedbank.ts): the
 * SignerID and the Corporate Pay agreement id that every pain.001 file to
 * Swedbank must carry. Shown to an owner or admin of a company whose bank
 * resolves to Swedbank (or a savings bank), whose payment files pay from a
 * Swedbank account (the primary bank account, lib/payments/paying-account.ts:
 * the files require the ids then, crm#1483), or that already has an id saved.
 * The rows sit inside the page's SettingsFormWrapper, so they share its
 * dirty-only save bar; swedbankFileIdUpdates reads them on save.
 */
export function SwedbankFileIdsSettings({ settings }: { settings: CompanySettings }) {
  const t = useTranslations('settings_swedbank_file_ids')
  const { role } = useCompany()
  const canEdit = role === 'owner' || role === 'admin'
  const { account: payingAccount } = usePaymentFileAccount(null, { enabled: canEdit })

  if (!canEdit) return null
  const hasIds = Boolean(settings.swedbank_signer_id || settings.swedbank_corporate_pay_id)
  if (!isSwedbankCompany(settings) && !payingAccount?.swedbank && !hasIds) return null

  return (
    <SettingsGroup label={t('heading')} help={t('help')}>
      <SettingsRow label={t('signer_id_label')} htmlFor="swedbank_signer_id" help={t('signer_id_help')} align="baseline">
        <SettingsInput
          // Remount on a saved change so the field shows the stored,
          // normalised id (upper case, no spaces) after the save.
          key={settings.swedbank_signer_id ?? ''}
          id="swedbank_signer_id"
          name="swedbank_signer_id"
          defaultValue={settings.swedbank_signer_id ?? ''}
          placeholder="123456789ORI0001"
          autoComplete="off"
          spellCheck={false}
          maxLength={35}
        />
      </SettingsRow>
      <SettingsRow
        label={t('corporate_pay_id_label')}
        htmlFor="swedbank_corporate_pay_id"
        help={t('corporate_pay_id_help')}
        align="baseline"
      >
        <SettingsInput
          key={settings.swedbank_corporate_pay_id ?? ''}
          id="swedbank_corporate_pay_id"
          name="swedbank_corporate_pay_id"
          defaultValue={settings.swedbank_corporate_pay_id ?? ''}
          placeholder="123456789CPO0001"
          autoComplete="off"
          spellCheck={false}
          maxLength={35}
        />
      </SettingsRow>
    </SettingsGroup>
  )
}

/**
 * The Swedbank ids to save from the page form: only fields the group
 * rendered (owner/admin of a Swedbank company) and only when they differ from
 * the stored value, so saving the rest of the page never re-sends them. An
 * emptied field clears the id; the server normalises and validates the rest.
 */
export function swedbankFileIdUpdates(formData: FormData, settings: CompanySettings): Record<string, string | null> {
  const updates: Record<string, string | null> = {}
  for (const field of SWEDBANK_FILE_ID_FIELDS) {
    if (!formData.has(field)) continue
    const value = String(formData.get(field) ?? '').trim()
    if (value !== (settings[field] ?? '')) updates[field] = value || null
  }
  return updates
}
