'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useSaveSettings } from '@/components/settings/use-save-settings'
import { useCompanySettings } from '@/lib/reference-data/hooks'
import { fetchActiveSendingProviders } from '@/lib/digital-mailboxes/sending-status'
import { fetchPeppolSending } from '@/lib/invoices/editor/peppol-sending'
import { availableSendOrderWays, type SendOrderWay } from '@/lib/invoices/send-order'

/**
 * The ways this company can use, read once: null until the two reads have
 * answered. The same two reads the invoice editor lists its channels by.
 */
export function useSendOrderWays(): SendOrderWay[] | null {
  const [ways, setWays] = useState<SendOrderWay[] | null>(null)
  useEffect(() => {
    let cancelled = false
    void Promise.all([fetchPeppolSending(), fetchActiveSendingProviders()]).then(([peppol, providers]) => {
      if (!cancelled) setWays(availableSendOrderWays(peppol !== null, providers))
    })
    return () => {
      cancelled = true
    }
  }, [])
  return ways
}

/** Saves the order through the settings write; true once it is stored. */
export function useSaveSendOrder(): (order: SendOrderWay[]) => Promise<boolean> {
  const t = useTranslations('invoice_send_order')
  const saveSettings = useSaveSettings()
  const { updateSettings } = useCompanySettings()
  return useCallback(
    async (order) => {
      const saved = await saveSettings({ invoice_send_order: order }, { failedTitle: t('save_failed') })
      if (!saved) return false
      updateSettings({ invoice_send_order: order })
      return true
    },
    [saveSettings, updateSettings, t],
  )
}
