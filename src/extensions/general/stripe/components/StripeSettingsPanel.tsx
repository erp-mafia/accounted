'use client'

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { CreditCardIcon, LinkIcon } from '@/components/icons'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { failureDescription } from '@/lib/browser/action-failure'
import type { ErrorLocale } from '@/lib/errors/get-error-message'
import { FeedConnectorPanel } from '@/components/extensions/shared/FeedConnectorPanel'
import {
  stripeRequest,
  syncSummary,
  STRIPE_SYNC_TIMEOUT_MS,
  type StripeSyncPayload,
} from '../lib/settings-actions'
import { MAX_BACKFILL_YEARS } from '../types'
import type { StripeStatusResponse } from '../types'
import { InvoicePaymentLinksRow } from './InvoicePaymentLinksRow'

type ConnectionInfo = NonNullable<StripeStatusResponse['connection']>

/** Error codes the Connect callback appends as ?stripe_error, the rest are generic. */
const GENERIC_CONNECT_ERRORS = ['invalid_state', 'missing_parameters', 'connection_failed', 'activation_failed']

/** Stripe on the shared feed panel; connecting is Stripe Connect OAuth. */
export default function StripeSettingsPanel() {
  const t = useTranslations('settings_payments')
  const tf = useTranslations('feed_connector')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const [connecting, setConnecting] = useState(false)

  return (
    <FeedConnectorPanel<ConnectionInfo, StripeSyncPayload>
      extensionId="stripe"
      namespace="settings_payments"
      icon={CreditCardIcon}
      request={stripeRequest}
      syncTimeoutMs={STRIPE_SYNC_TIMEOUT_MS}
      maxBackfillYears={MAX_BACKFILL_YEARS}
      summarize={syncSummary}
      identity={(c) => ({
        name: c.display_name || c.stripe_account_id || t('unnamed_account'),
        detail: null,
      })}
      lastSyncedAt={(c) => c.last_balance_txn_synced_at}
      connectErrorMessage={(code) =>
        code === 'account_already_connected'
          ? t('error_account_already_connected')
          : code === 'access_denied'
            ? t('error_access_denied')
            : GENERIC_CONNECT_ERRORS.includes(code)
              ? t('error_generic')
              : code
      }
      renderBadges={(c) =>
        !c.livemode && c.status === 'active' ? <Badge variant="warning">{t('test_mode')}</Badge> : null
      }
      // Connecting does not turn invoice links on (that is the opt-in under
      // Settings > Invoicing): show the switch where the merchant expects it.
      renderExtras={(c) => (c.status === 'active' ? <InvoicePaymentLinksRow /> : null)}
      renderConnect={({ failureCopy }) => {
        async function handleConnect() {
          if (connecting) return
          setConnecting(true)
          try {
            // The route ignores the request body, so none is sent.
            const result = await stripeRequest<{ url?: string }>({
              url: '/api/extensions/ext/stripe/connect',
              locale,
            })
            if (!result.ok || !result.data?.url) {
              toast({
                title: tf('connect_failed_title'),
                // A 2xx with no url is a route bug: nothing more specific is known.
                description: result.ok ? t('error_generic') : failureDescription(result, failureCopy),
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
          <div>
            <Button onClick={handleConnect} disabled={connecting}>
              <LinkIcon className="mr-2 h-4 w-4" />
              {connecting ? tf('connecting') : t('connect')}
            </Button>
            <p className="mt-3 text-sm text-muted-foreground">{t('connect_hint')}</p>
          </div>
        )
      }}
    />
  )
}
