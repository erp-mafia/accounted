'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { UpgradeNote } from '@/components/billing/UpgradeNote'
import { Button } from '@/components/ui/button'
import { AttnLine } from '@/components/ui/attn-line'
import { ActivationStepper } from '@/components/collections/ActivationStepper'
import { ConnectionSettingsPanel } from '@/components/collections/ConnectionSettingsPanel'
import { ConnectionStatusPanel } from '@/components/collections/ConnectionStatusPanel'
import {
  collectionsErrorMessageFor,
  useCollectionsSettings,
  useCollectionsWords,
  type CollectionsSettingsData,
} from '@/components/collections/collections-client'
import { SettingsLoadError } from '@/components/settings/SettingsLoadError'
import { SettingsLoadingSkeleton } from '@/components/settings/SettingsLoadingSkeleton'
import { SettingsBackLink, SettingsGroup, SettingsRow, SettingsRowNote, SettingsSectionHeader } from '@/components/settings/SettingsRows'

/**
 * Inställningar -> Påminnelser och inkasso (/settings/collections), reached
 * from Kopplingar and from Fakturering. What renders is decided by
 * GET /api/settings/collections alone (build spec 3.1): nothing while the
 * installation keeps collections dark, the paywall note without the paid
 * capability, the activation for an owner or admin, then the connection's
 * status and, once active, its rules. A connection that exists always shows,
 * whatever the start gates say.
 */
export function CollectionsSettingsContent() {
  const tNav = useTranslations('settings_nav')
  const { data, failed, loading, reload } = useCollectionsSettings()

  if (loading && !data) return <SettingsLoadingSkeleton />
  if (failed || !data) return <SettingsLoadError onRetry={reload} />
  return (
    <div>
      <SettingsBackLink href="/settings/connections" label={tNav('connections')} />
      <CollectionsSettingsBody data={data} reload={reload} />
    </div>
  )
}

function CollectionsSettingsBody({ data, reload }: { data: CollectionsSettingsData; reload: () => Promise<void> }) {
  const tCollections = useTranslations('collections')
  const { t, tp, words } = useCollectionsWords(data.availability.displayName ?? data.connection?.displayName)
  const [activating, setActivating] = useState(false)
  const { availability, connection } = data

  const header = <SettingsSectionHeader title={t('title')} intro={tp('intro')} />
  const sandbox = availability.sandbox ? <p className="pt-4 text-[12.5px] text-muted-foreground">{tCollections('sandbox_note')}</p> : null
  const health =
    connection && (connection.health === 'degraded' || connection.health === 'action_required') ? (
      <AttnLine className="pt-4">
        {connection.health === 'degraded'
          ? tp('health_degraded', { cause: collectionsErrorMessageFor(connection.healthCause, words.provider) })
          : tp('health_action_required', {
              action: t(connection.healthAction === 'retry_later' ? 'health_action_retry_later' : 'health_action_contact_support'),
            })}
      </AttnLine>
    ) : null

  // A connection is shown whatever the start gates say: it may carry work.
  if (connection) {
    const notSubmitted = connection.state === 'connecting' && connection.subStatus === 'not_started' && !connection.submittedAt && !connection.onboarded
    return (
      <div>
        {header}
        {sandbox}
        {health}
        {notSubmitted && data.canManage && data.activation && availability.start !== 'hidden' ? (
          <ActivationStepper data={data} onChanged={reload} />
        ) : null}
        <ConnectionStatusPanel data={data} connection={connection} onChanged={reload} />
        {connection.state === 'active' ? <ConnectionSettingsPanel data={data} connection={connection} onChanged={reload} /> : null}
      </div>
    )
  }

  if (availability.start === 'hidden') {
    return (
      <div>
        {header}
        <SettingsGroup>
          <SettingsRow label={t('status_label')}>
            <SettingsRowNote>{t('unavailable')}</SettingsRowNote>
          </SettingsRow>
        </SettingsGroup>
      </div>
    )
  }

  if (availability.start === 'upgrade') {
    return (
      <div>
        {header}
        <UpgradeNote className="mt-8">{tCollections('upgrade_note', { provider: words.provider })}</UpgradeNote>
      </div>
    )
  }

  const offered = data.provider !== null && data.provider.features.stepApprovalAction && !!data.provider.profile.termsVersion
  return (
    <div>
      {header}
      {sandbox}
      {!offered ? (
        <SettingsGroup>
          <SettingsRow label={t('status_label')}>
            <SettingsRowNote>{t('unavailable')}</SettingsRowNote>
          </SettingsRow>
        </SettingsGroup>
      ) : !data.canManage ? (
        <SettingsGroup>
          <SettingsRow label={t('status_label')}>
            <SettingsRowNote>{t('status_not_started')}</SettingsRowNote>
          </SettingsRow>
          <SettingsRow label={t('activate')} borderless>
            <SettingsRowNote>{t('admin_only')}</SettingsRowNote>
          </SettingsRow>
        </SettingsGroup>
      ) : activating ? (
        <ActivationStepper data={data} onChanged={reload} />
      ) : (
        <SettingsGroup>
          <SettingsRow label={t('status_label')}>
            <SettingsRowNote>{t('status_not_started')}</SettingsRowNote>
          </SettingsRow>
          {data.provider?.profile.feeSummarySv ? (
            <SettingsRow label={t('fee_summary_heading')} align="baseline">
              <span className="whitespace-pre-line text-muted-foreground">{data.provider.profile.feeSummarySv}</span>
            </SettingsRow>
          ) : null}
          <div className="flex justify-end pt-6">
            <Button onClick={() => setActivating(true)}>{t('activate')}</Button>
          </div>
        </SettingsGroup>
      )}
    </div>
  )
}
