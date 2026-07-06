'use client'

import { useState, useEffect, useRef } from 'react'
import { useTranslations } from 'next-intl'
import { useSearchParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { AlertTriangle, CreditCard, ExternalLink } from 'lucide-react'
import { getSettingsPanel } from '@/lib/extensions/settings-panel-registry'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import BankSyncStatusChip from '@/components/transactions/BankSyncStatusChip'

const BankingPanel = getSettingsPanel('enable-banking')

export function BankingSettingsContent() {
  const t = useTranslations('settings_banking')
  const searchParams = useSearchParams()
  const router = useRouter()
  const { toast } = useToast()
  const [bankConnectionError, setBankConnectionError] = useState<string | null>(null)
  const [failedBankName, setFailedBankName] = useState<string | null>(null)
  const [isAccessDenied, setIsAccessDenied] = useState(false)
  const [showHbPoaHint, setShowHbPoaHint] = useState(false)
  const syncInitiatedRef = useRef(false)
  const abortControllerRef = useRef<AbortController | null>(null)
  const unmountedRef = useRef(false)
  const hasBankingExtension = ENABLED_EXTENSION_IDS.has('enable-banking')

  useEffect(() => {
    return () => {
      unmountedRef.current = true
      if (abortControllerRef.current) abortControllerRef.current.abort()
    }
  }, [])

  useEffect(() => {
    const bankConnected = searchParams.get('bank_connected')
    const bankError = searchParams.get('bank_error')

    if (bankConnected === 'true' && !syncInitiatedRef.current) {
      syncInitiatedRef.current = true
      const connectionId = searchParams.get('connection_id')
      router.replace('/settings/banking')

      if (connectionId) {
        toast({
          title: t('sync_start_title'),
          description: t('sync_start_description'),
        })
        const controller = new AbortController()
        abortControllerRef.current = controller
        const syncTimeout = setTimeout(() => controller.abort(), 120_000)

        ;(async () => {
          try {
            const res = await fetch('/api/extensions/ext/enable-banking/sync', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ connection_id: connectionId, days_back: 120 }),
              signal: controller.signal,
            })
            clearTimeout(syncTimeout)
            const data = await res.json()
            if (res.ok) {
              if (!unmountedRef.current) {
                toast({
                  title: t('sync_success_title'),
                  description: t('sync_success_description', { count: data.imported ?? 0 }),
                })
              }
            } else {
              throw new Error(data.error || 'Sync failed')
            }
          } catch (err) {
            clearTimeout(syncTimeout)
            if (unmountedRef.current) return
            if (controller.signal.aborted) {
              toast({
                title: t('sync_timeout_title'),
                description: t('sync_timeout_description'),
              })
            } else {
              toast({
                title: t('sync_failed_title'),
                description: err instanceof Error ? err.message : t('sync_failed_default'),
                variant: 'destructive',
              })
            }
          }
        })()
      } else {
        toast({
          title: t('sync_success_title'),
          description: t('sync_success_no_id_description'),
        })
      }
    }

    if (bankError) {
      let errorMsg: string
      try { errorMsg = decodeURIComponent(bankError) } catch { errorMsg = bankError }
      const bankName = searchParams.get('bank_name')
      const errorCode = searchParams.get('bank_error_code')
      const psuType = searchParams.get('psu_type')
      // The bank often returns a bare "server_error" with no description —
      // show a human message instead of the raw OAuth error code.
      if (errorCode === 'server_error' && errorMsg === 'server_error') {
        errorMsg = t('bank_server_error')
      }
      toast({
        title: t('connect_failed_title'),
        description: errorMsg,
        variant: 'destructive',
      })
      setBankConnectionError(errorMsg)
      if (bankName) setFailedBankName(bankName)
      if (errorCode === 'access_denied') setIsAccessDenied(true)
      // Handelsbanken rejects business connects with server_error when the
      // company hasn't registered the open banking fullmakt ("Internet
      // Företag – tilläggstjänst API Företag") — surface the fix steps.
      if (bankName === 'Handelsbanken' && psuType === 'business' && errorCode === 'server_error') {
        setShowHbPoaHint(true)
      }
      router.replace('/settings/banking')
    }
  }, [searchParams, router, toast, t])

  return (
    <div className="space-y-8">
      {bankConnectionError && (
        <div className="flex items-start gap-3 rounded-lg border border-destructive/20 bg-destructive/10 p-4">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
          <div className="flex-1">
            <p className="text-sm font-medium text-destructive">{bankConnectionError}</p>
            {isAccessDenied && failedBankName && (
              <p className="mt-1 text-sm text-muted-foreground">
                {t('access_denied_hint', { bankName: failedBankName })}
              </p>
            )}
            {showHbPoaHint && (
              <p className="mt-1 text-sm text-muted-foreground">
                {t('hb_business_poa_hint')}{' '}
                <a
                  href="https://tilisy.enablebanking.com/guides/SE/Handelsbanken/"
                  target="_blank"
                  rel="noreferrer"
                  className="underline hover:text-foreground"
                >
                  {t('hb_business_poa_link')}
                </a>
              </p>
            )}
            <p className="mt-1 text-sm text-muted-foreground">
              {t('import_fallback_text')}<Link href="/import?mode=bank" className="underline hover:text-foreground">{t('import_fallback_link')}</Link>{t('import_fallback_suffix')}
            </p>
          </div>
          <button
            onClick={() => {
              setBankConnectionError(null)
              setFailedBankName(null)
              setIsAccessDenied(false)
              setShowHbPoaHint(false)
            }}
            className="shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground"
            aria-label={t('dismiss_aria')}
          >
            <span className="text-lg leading-none">&times;</span>
          </button>
        </div>
      )}

      {hasBankingExtension && BankingPanel ? (
        <>
          <BankSyncStatusChip />
          <BankingPanel />
        </>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <CreditCard className="h-10 w-10 text-muted-foreground/40 mb-4" />
            <p className="font-medium mb-1">{t('not_enabled_title')}</p>
            <p className="text-sm text-muted-foreground mb-4 max-w-md">
              {t('not_enabled_description')}
            </p>
            <Button variant="outline" asChild>
              <Link href="/extensions">
                <ExternalLink className="mr-2 h-4 w-4" />
                {t('go_to_extensions')}
              </Link>
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
