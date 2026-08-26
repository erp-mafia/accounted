'use client'

import { useState, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { useSearchParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { useToast } from '@/components/ui/use-toast'
import { AlertTriangle, CreditCard, ExternalLink } from 'lucide-react'
import { getSettingsPanel } from '@/lib/extensions/settings-panel-registry'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import { SettingsSectionHeader } from '@/components/settings/SettingsRows'
import { useBranding } from '@/lib/branding/brand-context'

const BankingPanel = getSettingsPanel('enable-banking')

export function BankingSettingsContent() {
  const t = useTranslations('settings_banking')
  const tNav = useTranslations('settings_nav')
  const tIntro = useTranslations('settings_intro')
  const { appName } = useBranding()
  const searchParams = useSearchParams()
  const router = useRouter()
  const { toast } = useToast()
  const [bankConnectionError, setBankConnectionError] = useState<string | null>(null)
  const [failedBankName, setFailedBankName] = useState<string | null>(null)
  const [isAccessDenied, setIsAccessDenied] = useState(false)
  const [showHbPoaHint, setShowHbPoaHint] = useState(false)
  const hasBankingExtension = ENABLED_EXTENSION_IDS.has('enable-banking')

  // Surface a bank connection/authorization failure that the OAuth callback
  // bounced back as `?bank_error=...`. The success path is handled by the
  // callback redirecting to `?select_accounts=<id>`, which the banking panel
  // picks up to open account selection: there is no `bank_connected` param.
  useEffect(() => {
    const bankError = searchParams.get('bank_error')
    if (!bankError) return

    let errorMsg: string
    try { errorMsg = decodeURIComponent(bankError) } catch { errorMsg = bankError }
    const bankName = searchParams.get('bank_name')
    const errorCode = searchParams.get('bank_error_code')
    const psuType = searchParams.get('psu_type')
    // The bank often returns a bare "server_error" with no description: show a
    // human message instead of the raw OAuth error code.
    if (errorCode === 'server_error' && errorMsg === 'server_error') {
      errorMsg = t('bank_server_error')
    }

    // Consume the one-shot ?bank_error= param off the render path: a microtask
    // defers these updates out of the effect body (react-hooks/set-state-in-
    // effect) without a user-visible delay, since the param appears at most
    // once per OAuth bounce-back. The cancellation flag drops the deferred work
    // if the effect re-runs or the component unmounts before it flushes (also
    // suppresses a duplicate toast under StrictMode's dev double-invoke).
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
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
      // Företag – tilläggstjänst API Företag"): surface the fix steps.
      if (bankName === 'Handelsbanken' && psuType === 'business' && errorCode === 'server_error') {
        setShowHbPoaHint(true)
      }
      router.replace('/settings/banking')
    })
    return () => { cancelled = true }
  }, [searchParams, router, toast, t])

  return (
    <div>
      <SettingsSectionHeader title={tNav('banking')} intro={tIntro('banking', { appName })} />

      {/* OAuth bounce-back failure: a live warning, so it stays visible in the
          page flow, as compact warning-tone lines instead of a bordered box. */}
      {bankConnectionError && (
        <div role="alert" className="mt-6 flex items-start gap-2 px-1">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-attn" />
          <div className="min-w-0 flex-1 space-y-1 text-[12.5px] leading-relaxed">
            <p className="text-attn">{bankConnectionError}</p>
            {isAccessDenied && failedBankName && (
              <p className="text-muted-foreground">
                {t('access_denied_hint', { bankName: failedBankName })}
              </p>
            )}
            {showHbPoaHint && (
              <p className="text-muted-foreground">
                {t('hb_business_poa_hint')}{' '}
                <a
                  href="https://tilisy.enablebanking.com/guides/SE/Handelsbanken/"
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  {t('hb_business_poa_link')}
                </a>
              </p>
            )}
            <p className="text-muted-foreground">
              {t('import_fallback_text')}<Link href="/import?mode=bank" className="underline underline-offset-2 hover:text-foreground">{t('import_fallback_link')}</Link>{t('import_fallback_suffix')}
            </p>
          </div>
          <button
            onClick={() => {
              setBankConnectionError(null)
              setFailedBankName(null)
              setIsAccessDenied(false)
              setShowHbPoaHint(false)
            }}
            className="shrink-0 rounded-sm p-1 text-muted-foreground transition-colors duration-150 hover:text-foreground"
            aria-label={t('dismiss_aria')}
          >
            <span className="text-lg leading-none">&times;</span>
          </button>
        </div>
      )}

      {hasBankingExtension && BankingPanel ? (
        // No BankSyncStatusChip here: on this page the chip links to itself,
        // and the panel now carries its own single attention sentence. The
        // chip stays on /transactions.
        <BankingPanel />
      ) : (
        <div className="pt-8">
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
        </div>
      )}
    </div>
  )
}
