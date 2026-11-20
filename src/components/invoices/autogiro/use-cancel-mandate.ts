'use client'

import { useLocale, useTranslations } from 'next-intl'
import { useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import { useToast } from '@/components/ui/use-toast'
import { failureDescription } from '@/lib/browser/action-failure'
import type { ErrorLocale } from '@/lib/errors/get-error-message'
import { downloadAutogiroFile, jsonRequest, requestAutogiro } from './client'
import type { CancelMandateResponse } from './types'

/**
 * Makulera a mandate, from the Autogiro page or the customer card: confirmed
 * up front in a dialog, then Accounted stops debiting it and the
 * cancellation file for the bank downloads at once. A download that fails
 * leaves the file under Filer on the Autogiro page.
 */
export function useCancelMandate(onDone: () => void) {
  const t = useTranslations('autogiro')
  const tCommon = useTranslations('common')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const { dialogProps, confirm } = useDestructiveConfirm()

  async function cancelMandate(mandate: { id: string; payer_number: string }) {
    await confirm(
      {
        title: t('cancel_mandate_title'),
        description: t('cancel_mandate_description', { payer: mandate.payer_number }),
        confirmLabel: t('cancel_mandate_confirm'),
        cancelLabel: tCommon('cancel'),
        variant: 'destructive',
      },
      async () => {
        const result = await requestAutogiro<CancelMandateResponse>(
          `/api/invoices/autogiro/mandates/${mandate.id}/cancel`,
          jsonRequest('POST'),
          locale,
        )
        if (!result.ok) {
          toast({ title: t('cancel_mandate_failed'), description: result.message, variant: 'destructive' })
          throw new Error(result.message)
        }
        const download = await downloadAutogiroFile(result.data.file, locale)
        if (download.ok) {
          toast({ title: t('cancel_mandate_done'), description: t('upload_in_bank') })
        } else {
          toast({
            title: t('cancel_mandate_download_failed'),
            description: failureDescription(download, {
              timeout: tCommon('download_timeout'),
              network: tCommon('download_network'),
            }),
            variant: 'destructive',
          })
        }
        onDone()
      },
    )
  }

  return { cancelMandate, dialogProps }
}
