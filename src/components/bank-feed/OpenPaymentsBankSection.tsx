'use client'

import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { SettingsGroup, SettingsRow, SettingsRowEnd } from '@/components/settings/SettingsRows'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { OpenPaymentsConnectionRow } from './OpenPaymentsConnectionRows'
import type { BankConnectFlow } from './use-bank-connect-flow'
import type { BankConnectionRow } from './use-open-payments-connections'

interface OpenPaymentsBankSectionProps {
  flow: BankConnectFlow
  connections: BankConnectionRow[]
  onChanged: () => void
  /** Whether the company may start a consent (lib/bank-feed/door.ts): the connect row and Förnya. */
  canConnect: boolean
}

/**
 * Bank (PSD2) settings, the top section when Open Payments is available or
 * the company already holds an Open Payments connection: the connect row and
 * the Open Payments connections, above the Enable Banking panel that still
 * manages the older connections. A company the door no longer admits (a
 * cardless trial) still sees and can remove the connections it has.
 */
export function OpenPaymentsBankSection({ flow, connections, onChanged, canConnect }: OpenPaymentsBankSectionProps) {
  const t = useTranslations('settings_banking')
  const { canWrite } = useCanWrite()
  return (
    <SettingsGroup label={t('op_group')} help={t('op_connect_help')}>
      {canConnect && (
        <SettingsRow label={t('op_connect_label')} borderless={connections.length === 0}>
          <SettingsRowEnd>
            <Button size="sm" onClick={() => flow.open('new')} disabled={!canWrite}>
              {t('op_connect_button')}
            </Button>
          </SettingsRowEnd>
        </SettingsRow>
      )}
      {connections.map((connection) => (
        <OpenPaymentsConnectionRow key={connection.id} connection={connection} flow={flow} onChanged={onChanged} canRenew={canConnect} />
      ))}
    </SettingsGroup>
  )
}
