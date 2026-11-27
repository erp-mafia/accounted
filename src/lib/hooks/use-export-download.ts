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
import { failureDescription, type ActionFailureCopy } from '@/lib/browser/action-failure'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'

export interface SaveExportOptions {
  locale: ErrorLocale
  /** The sentences for a timeout and for no connection; a refusal keeps the route's own message. */
  copy: ActionFailureCopy
  /** Seam for tests; defaults to downloadFile. */
  download?: typeof downloadFile
}

/**
 * Fetch one export and save it. Answers null when the file was saved, or the
 * one sentence that says why nothing was: the route's own message for a
 * refusal, the caller's copy for a timeout or no connection, and a general
 * sentence when the browser itself threw while saving. Never rejects, so the
 * click that awaits it always ends with a file or a toast.
 */
export async function saveExport(
  url: string,
  fallbackFilename: string,
  { locale, copy, download = downloadFile }: SaveExportOptions,
): Promise<string | null> {
  try {
    const result = await download({
      url,
      filename: fallbackFilename,
      preferServerFilename: true,
      locale,
      timeoutMs: RENDERED_DOWNLOAD_TIMEOUT_MS,
    })
    return result.ok ? null : failureDescription(result, copy)
  } catch (err) {
    return getErrorMessage(err, { locale })
  }
}

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
        const failure = await saveExport(url, fallbackFilename, {
          locale,
          copy: { timeout: t('export_timeout'), network: t('export_network') },
        })
        if (failure !== null) {
          toast({ title: t('export_failed_title'), description: failure, variant: 'destructive' })
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
