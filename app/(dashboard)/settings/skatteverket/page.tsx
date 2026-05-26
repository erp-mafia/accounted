'use client'

import { useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { useSearchParams, useRouter } from 'next/navigation'
import { useToast } from '@/components/ui/use-toast'
import { SkatteverketConnectPanel } from '@/components/settings/SkatteverketConnectPanel'

export default function SkatteverketSettingsPage() {
  const t = useTranslations('settings_skatteverket')
  const searchParams = useSearchParams()
  const router = useRouter()
  const { toast } = useToast()

  useEffect(() => {
    const connected = searchParams.get('skv_connected')
    const error = searchParams.get('skv_error')

    if (connected === 'true') {
      toast({
        title: t('connected_title'),
        description: t('connected_description'),
      })
      router.replace('/settings/skatteverket')
    } else if (error) {
      let msg: string
      try { msg = decodeURIComponent(error) } catch { msg = error }
      toast({
        title: t('connect_failed_title'),
        description: msg,
        variant: 'destructive',
      })
      router.replace('/settings/skatteverket')
    }
  }, [searchParams, router, toast, t])

  return (
    <div className="space-y-8">
      <SkatteverketConnectPanel />
    </div>
  )
}
