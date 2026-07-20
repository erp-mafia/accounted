'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { MonitorDown } from 'lucide-react'

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

function subscribeDisplayMode(onChange: () => void) {
  const mql = window.matchMedia('(display-mode: standalone)')
  mql.addEventListener('change', onChange)
  return () => mql.removeEventListener('change', onChange)
}

function getIsStandalone() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS Safari reports installed mode via navigator.standalone instead
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

/**
 * "Install as app" section for account settings. Chromium fires
 * beforeinstallprompt when the PWA is installable; we capture it and offer a
 * real install button. Other browsers get per-platform instructions. Hidden
 * entirely when already running standalone (installed) or after installing.
 */
export function InstallAppSection() {
  const t = useTranslations('settings')
  // Server snapshot says standalone so the section is absent from server HTML
  // and only appears client-side when actually running in a browser tab.
  const isStandalone = useSyncExternalStore(subscribeDisplayMode, getIsStandalone, () => true)
  const [installed, setInstalled] = useState(false)
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null)

  useEffect(() => {
    const onBeforeInstallPrompt = (e: Event) => {
      e.preventDefault()
      setInstallPrompt(e as BeforeInstallPromptEvent)
    }
    const onInstalled = () => {
      setInstallPrompt(null)
      setInstalled(true)
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  async function handleInstall() {
    if (!installPrompt) return
    await installPrompt.prompt()
    const choice = await installPrompt.userChoice
    if (choice.outcome === 'accepted') setInstallPrompt(null)
  }

  if (isStandalone || installed) return null

  const ua = navigator.userAgent
  const isIos = /iPad|iPhone|iPod/.test(ua)
  const isSafari = /Safari/.test(ua) && !/Chrome|Chromium|Edg|CriOS/.test(ua)
  const hint = isIos
    ? t('install_app_hint_ios')
    : isSafari
      ? t('install_app_hint_safari')
      : t('install_app_hint_generic')

  return (
    <section className="space-y-4 border-t border-border pt-8">
      <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
        {t('install_app_title')}
      </h2>
      <div className="flex items-center justify-between gap-4 p-4 border rounded-lg">
        <p className="text-sm text-muted-foreground max-w-md">
          {installPrompt ? t('install_app_description') : hint}
        </p>
        {installPrompt && (
          <Button variant="outline" onClick={handleInstall}>
            <MonitorDown className="mr-2 h-4 w-4" />
            {t('install_app_button')}
          </Button>
        )}
      </div>
    </section>
  )
}
