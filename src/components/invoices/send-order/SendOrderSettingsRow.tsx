'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { SettingsGroup, SettingsRow, SettingsRowEnd, SettingsRowNote } from '@/components/settings/SettingsRows'
import { useCompany, useSendOrderSetupEnabled } from '@/contexts/CompanyContext'
import { DIGITAL_MAILBOX_PROVIDER_NAMES } from '@/lib/digital-mailboxes/sending-status'
import { parseSendOrder, type SendOrderWay } from '@/lib/invoices/send-order'
import type { CompanySettings } from '@/types'
import { SendOrderEditor } from './SendOrderEditor'

/**
 * Ordning för utskick: the saved order of the ways invoices go out (or the
 * recommended one while none is saved), with the same list to change it.
 * Shown to the users in the rollout and to any company that has a saved
 * order; only an owner or admin can change it.
 */
export function SendOrderSettingsRow({ settings }: { settings: CompanySettings }) {
  const t = useTranslations('invoice_send_order')
  const { role } = useCompany()
  const inRollout = useSendOrderSetupEnabled()
  const [editing, setEditing] = useState(false)
  const saved = parseSendOrder(settings.invoice_send_order)
  if (!inRollout && !saved) return null
  const canEdit = role === 'owner' || role === 'admin'
  const wayName = (way: SendOrderWay) =>
    way === 'peppol' ? t('way_peppol') : way === 'email' ? t('way_email') : DIGITAL_MAILBOX_PROVIDER_NAMES[way]
  const summary = saved ? saved.map(wayName).join(', ') : t('recommended_order')

  return (
    <SettingsGroup>
      <SettingsRow label={t('row_label')} help={t('row_help')} borderless={editing}>
        <SettingsRowNote fill>{summary}</SettingsRowNote>
        {canEdit && !editing ? (
          <SettingsRowEnd>
            <Button type="button" variant="outline" onClick={() => setEditing(true)}>
              {t('change')}
            </Button>
          </SettingsRowEnd>
        ) : null}
      </SettingsRow>
      {canEdit && editing ? (
        <div className="py-3">
          <SendOrderEditor saved={saved} onSaved={() => setEditing(false)} onCancel={() => setEditing(false)} />
        </div>
      ) : null}
    </SettingsGroup>
  )
}
