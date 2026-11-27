'use client'

/**
 * The click behind an Exportera or Ladda ner item that saves a file a route
 * renders (a report PDF or Excel, a register, an SIE file): fetch it from this
 * tab and save it, or say in one toast why nothing was saved.
 *
 * These items used to window.open() the route in a new tab. The route answers
 * Content-Disposition: attachment, so the new tab starts a download and closes
 * itself. A browser set to ask where to save each file (Opera with that
 * setting on) loses the download together with the tab: the user sees a tab
 * flash and nothing lands in Downloads. A refusal fared no better, raw JSON in
 * a stray tab. downloadFile saves from the page itself, so no tab is opened or
 * closed, and a refusal comes back as the route's own message.
 */

import { useCallback, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { useToast } from '@/components/ui/use-toast'
import { downloadFile, RENDERED_DOWNLOAD_TIMEOUT_MS } from '@/lib/browser/download-file'
import { failureDescription } from '@/lib/browser/action-failure'
import type { ErrorLocale } from '@/lib/errors/get-error-message'

export function useExportDownload(): {
  /** A file is on its way: show the trigger as busy. */
  pending: boolean
  /** Save the file `url` answers, under the server's name or `fallbackFilename`. */
  download: (url: string, fallbackFilename: string) => Promise<void>
} {
  const t = useTranslations('reports')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const [pending, setPending] = useState(false)
  // Closes the double-click race before React has re-rendered the trigger.
  const inFlight = useRef(false)

  const download = useCallback(
    async (url: string, fallbackFilename: string) => {
      if (inFlight.current) return
      inFlight.current = true
      setPending(true)
      try {
        const result = await downloadFile({
          url,
          filename: fallbackFilename,
          preferServerFilename: true,
          locale,
          timeoutMs: RENDERED_DOWNLOAD_TIMEOUT_MS,
        })
        if (!result.ok) {
          toast({
            title: t('export_failed_title'),
            description: failureDescription(result, {
              timeout: t('export_timeout'),
              network: t('export_network'),
            }),
            variant: 'destructive',
          })
        }
      } finally {
        inFlight.current = false
        setPending(false)
      }
    },
    [locale, t, toast],
  )

  return { pending, download }
}
