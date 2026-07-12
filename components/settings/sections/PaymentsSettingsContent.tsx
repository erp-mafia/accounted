'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { CreditCard, ExternalLink } from 'lucide-react'
import { getSettingsPanel } from '@/lib/extensions/settings-panel-registry'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'

const StripePanel = getSettingsPanel('stripe')

export function PaymentsSettingsContent() {
  const t = useTranslations('settings_payments')
  const hasStripeExtension = ENABLED_EXTENSION_IDS.has('stripe')

  return (
    <div className="space-y-8">
      {hasStripeExtension && StripePanel ? (
        <StripePanel />
      ) : (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={CreditCard}
              title={t('not_enabled_title')}
              description={t('not_enabled_description')}
            >
              <Button variant="outline" asChild>
                <Link href="/extensions">
                  <ExternalLink className="mr-2 h-4 w-4" />
                  {t('go_to_extensions')}
                </Link>
              </Button>
            </EmptyState>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
