'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { MailConnectionsPanel } from '@/components/extensions/general/MailConnectionsPanel'
import {
  MAIL_SETTINGS_HREF,
  parseMailCallback,
  type MailCallbackCode,
} from '@/components/extensions/general/mail-connections'
import { GoogleMark } from '@/components/ui/provider-marks'
import { useToast } from '@/components/ui/use-toast'
import { SettingsBackLink, SettingsSectionHeader } from '@/components/settings/SettingsRows'
import { useBranding } from '@/lib/branding/brand-context'

/**
 * Kopplingar > Gmail. Reached from the Kopplingar hub rather than the rail,
 * and keeps its own URL because Google's OAuth callback lands here:
 * /settings/mail?mail=<code> (extensions/general/mail, /oauth/callback).
 */
export function MailSettingsContent() {
  const t = useTranslations('mail')
  const tNav = useTranslations('settings_nav')
  const tIntro = useTranslations('settings_intro')
  const { appName } = useBranding()
  const searchParams = useSearchParams()
  const router = useRouter()
  const { toast } = useToast()
  // Read once, at mount: the parameter leaves the URL right below, and a
  // notice such as "tick the Gmail box" has to outlive that.
  const [callback] = useState<MailCallbackCode | null>(() => parseMailCallback(searchParams.get('mail')))
  const handled = useRef(false)

  useEffect(() => {
    if (handled.current || !searchParams.has('mail')) return
    handled.current = true
    if (callback === 'connected') {
      toast({ title: t('callback_connected_title'), description: t('callback_connected_body') })
    }
    router.replace(MAIL_SETTINGS_HREF)
  }, [callback, router, searchParams, t, toast])

  return (
    <div>
      <SettingsBackLink href="/settings/connections" label={tNav('connections')} />
      <SettingsSectionHeader
        title={tNav('mail')}
        intro={tIntro('mail', { appName })}
        mark={<GoogleMark className="h-5 w-5" />}
      />
      <MailConnectionsPanel notice={callback && callback !== 'connected' ? callback : null} />
    </div>
  )
}
