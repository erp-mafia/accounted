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
import { zettleStoreDisplayName } from '../lib/organization-name'
import { MAX_BACKFILL_YEARS } from '../types'
import type { ZettleStatusResponse } from '../types'
import { StoreNameRow } from './StoreNameRow'

type ConnectionInfo = NonNullable<ZettleStatusResponse['connection']>

/**
 * Zettle on the shared feed panel; connecting is an OAuth round trip to Zettle.
 * Zettle gives no store name, so the card carries a row to name the store.
 */
export default function ZettleSettingsPanel() {
  const t = useTranslations('zettle')
  const tf = useTranslations('feed_connector')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const [connecting, setConnecting] = useState(false)
  // Names saved on this page, so the card's heading follows a rename at once.
  const [savedNames, setSavedNames] = useState<Record<string, string>>({})

  return (
    <FeedConnectorPanel<ConnectionInfo, ZettleSyncPayload>
      extensionId="zettle"
      namespace="zettle"
      icon={CreditCardIcon}
      request={zettleRequest}
      syncTimeoutMs={ZETTLE_SYNC_TIMEOUT_MS}
      maxBackfillYears={MAX_BACKFILL_YEARS}
      summarize={syncSummary}
      // The organization UUID is an identifier, never the store's name.
      identity={(c) => ({
        name: zettleStoreDisplayName(savedNames[c.id] ?? c.organization_name),
        detail: c.organization_uuid,
      })}
      lastSyncedAt={(c) => c.last_order_synced_at}
      // The store scope is the organization UUID (client twin of
      // zettleStoreScope(), which is the identity).
      renderExtras={(c) =>
        c.status === 'active' ? (
          <>
            <StoreNameRow
              storedName={savedNames[c.id] ?? c.organization_name}
              onSaved={(name) => setSavedNames((prev) => ({ ...prev, [c.id]: name }))}
            />
            {c.organization_uuid && (
              <PaymentMethodMappingForm platform="zettle" storeScope={c.organization_uuid} />
            )}
          </>
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
