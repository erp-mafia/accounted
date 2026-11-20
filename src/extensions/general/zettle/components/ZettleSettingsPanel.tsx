'use client'

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { CreditCardIcon, LinkIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { failureDescription } from '@/lib/browser/action-failure'
import type { ErrorLocale } from '@/lib/errors/get-error-message'
import { PaymentMethodMappingForm } from '@/components/orders/PaymentMethodMappingForm'
import { FeedConnectorPanel } from '@/components/extensions/shared/FeedConnectorPanel'
import {
  zettleRequest,
  syncSummary,
  ZETTLE_CONNECT_TIMEOUT_MS,
  ZETTLE_SYNC_TIMEOUT_MS,
  type ZettleSyncPayload,
} from '../lib/settings-actions'
import { MAX_BACKFILL_YEARS } from '../types'
import type { ZettleStatusResponse } from '../types'

type ConnectionInfo = NonNullable<ZettleStatusResponse['connection']>

/** Zettle on the shared feed panel; connecting is an OAuth round trip to Zettle. */
export default function ZettleSettingsPanel() {
  const t = useTranslations('zettle')
  const tf = useTranslations('feed_connector')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const [connecting, setConnecting] = useState(false)

  return (
    <FeedConnectorPanel<ConnectionInfo, ZettleSyncPayload>
      extensionId="zettle"
      namespace="zettle"
      icon={CreditCardIcon}
      request={zettleRequest}
      syncTimeoutMs={ZETTLE_SYNC_TIMEOUT_MS}
      maxBackfillYears={MAX_BACKFILL_YEARS}
      summarize={syncSummary}
      identity={(c) => ({
        name: c.organization_name || c.organization_uuid || t('unnamed_store'),
        detail: c.organization_name ? c.organization_uuid : null,
      })}
      lastSyncedAt={(c) => c.last_order_synced_at}
      // The store scope is the organization UUID (client twin of
      // zettleStoreScope(), which is the identity).
      renderExtras={(c) =>
        c.status === 'active' && c.organization_uuid ? (
          <PaymentMethodMappingForm platform="zettle" storeScope={c.organization_uuid} />
        ) : null
      }
      renderConnect={({ failureCopy }) => {
        async function handleConnect() {
          if (connecting) return
          setConnecting(true)
          try {
            const result = await zettleRequest<{ url?: string }>({
              url: '/api/extensions/ext/zettle/connect',
              locale,
              timeoutMs: ZETTLE_CONNECT_TIMEOUT_MS,
            })
            if (!result.ok || !result.data?.url) {
              toast({
                title: tf('connect_failed_title'),
                description: result.ok ? undefined : failureDescription(result, failureCopy),
                variant: 'destructive',
              })
              return
            }
            window.location.href = result.data.url
          } finally {
            setConnecting(false)
          }
        }
        return (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">{t('connect_hint')}</p>
            <Button onClick={handleConnect} loading={connecting}>
              {!connecting && <LinkIcon className="h-4 w-4" />}
              {connecting ? tf('connecting') : t('connect')}
            </Button>
          </div>
        )
      }}
    />
  )
}
