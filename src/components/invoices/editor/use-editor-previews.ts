'use client'

import { useEffect, useRef, useState } from 'react'
import { useLocale } from 'next-intl'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { readPdfPreviewMeta, type PdfPreviewMeta } from '@/lib/invoices/editor/preview-request'

/**
 * The invoice editor's live previews. Both follow InvoicePreviewCard's
 * pattern: a 500 ms debounce so typing does not fire a render per
 * keystroke, an AbortController that drops a render the next edit made
 * stale, and the last good result kept on screen while the next one loads
 * (a blank pane on every keystroke reads as broken).
 */

const DEBOUNCE_MS = 500

export interface PdfPreviewState extends PdfPreviewMeta {
  /** Blob URL of the latest good render; null before the first one. */
  url: string | null
  loading: boolean
  /** Why the latest request failed; the previous render stays. */
  error: string | null
}

const EMPTY_META: PdfPreviewMeta = { pageCount: null, qr: null, missing: [], exchangeRate: null, exchangeRateDate: null }

/**
 * POST /api/invoices/preview-pdf with the serialized request body. A new
 * `body` (or `refreshKey`, bumped when something outside the form changed,
 * like a logo upload) schedules a render. Null pauses.
 */
export function useInvoicePdfPreview(body: string | null, refreshKey = 0): PdfPreviewState {
  const locale = useLocale() as ErrorLocale
  const [result, setResult] = useState<{ url: string | null } & PdfPreviewMeta>({ url: null, ...EMPTY_META })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const currentUrlRef = useRef<string | null>(null)

  useEffect(() => {
    if (body === null) return
    let cancelled = false
    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      setLoading(true)
      try {
        const response = await fetch('/api/invoices/preview-pdf', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: controller.signal,
        })
        if (!response.ok) {
          const payload: unknown = await response.json().catch(() => null)
          if (cancelled) return
          setError(
            getErrorMessage(payload ?? new Error(`HTTP ${response.status}`), {
              locale,
              context: 'invoice',
              statusCode: response.status,
            }),
          )
          setLoading(false)
          return
        }
        const meta = readPdfPreviewMeta(response.headers)
        const blob = await response.blob()
        if (cancelled) return
        const url = URL.createObjectURL(blob)
        const previous = currentUrlRef.current
        currentUrlRef.current = url
        setResult({ url, ...meta })
        setError(null)
        setLoading(false)
        // The <object> swaps to the new URL on this render; the old one may
        // still be painting, so it is released a moment later.
        if (previous) window.setTimeout(() => URL.revokeObjectURL(previous), 10_000)
      } catch (err) {
        if (cancelled) return
        if (err instanceof Error && err.name === 'AbortError') return
        setError(getErrorMessage(err, { locale, context: 'invoice' }))
        setLoading(false)
      }
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [body, refreshKey, locale])

  useEffect(() => {
    return () => {
      if (currentUrlRef.current) URL.revokeObjectURL(currentUrlRef.current)
      currentUrlRef.current = null
    }
  }, [])

  return { ...result, loading, error }
}

/** POST /api/invoices/preview-email's data. */
export interface EmailPreview {
  subject: string
  html: string
  editable: { subject: string; body: string }
  from: { name: string; address: string | null }
  reply_to: string | null
  to: string[]
  cc: string[]
  missing: string[]
}

export interface EmailPreviewState {
  preview: EmailPreview | null
  loading: boolean
  error: string | null
}

/** POST /api/invoices/preview-email; null pauses (the Mejl tab is closed). */
export function useInvoiceEmailPreview(body: string | null): EmailPreviewState {
  const locale = useLocale() as ErrorLocale
  const [preview, setPreview] = useState<EmailPreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (body === null) return
    let cancelled = false
    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      setLoading(true)
      try {
        const response = await fetch('/api/invoices/preview-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: controller.signal,
        })
        const payload: unknown = await response.json().catch(() => null)
        if (cancelled) return
        if (!response.ok) {
          setError(
            getErrorMessage(payload ?? new Error(`HTTP ${response.status}`), {
              locale,
              context: 'invoice',
              statusCode: response.status,
            }),
          )
          setLoading(false)
          return
        }
        setPreview((payload as { data: EmailPreview }).data)
        setError(null)
        setLoading(false)
      } catch (err) {
        if (cancelled) return
        if (err instanceof Error && err.name === 'AbortError') return
        setError(getErrorMessage(err, { locale, context: 'invoice' }))
        setLoading(false)
      }
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [body, locale])

  return { preview, loading, error }
}
