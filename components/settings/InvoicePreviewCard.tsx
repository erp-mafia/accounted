'use client'

import { useEffect, useRef, useState } from 'react'
import { Eye } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { createClient } from '@/lib/supabase/client'
import { useCompany } from '@/contexts/CompanyContext'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import type { CompanySettings } from '@/types'

interface InvoicePreviewCardProps {
  settings: CompanySettings
}

export function InvoicePreviewCard({ settings }: InvoicePreviewCardProps) {
  const t = useTranslations('settings_invoicing_preview')
  const locale = useLocale() as ErrorLocale
  const { company } = useCompany()
  const [open, setOpen] = useState(false)
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const currentUrlRef = useRef<string | null>(null)

  const sampleItemDescription = t('sample_item_description')

  useEffect(() => {
    if (!open || !company?.id) return
    const companyId = company.id

    let cancelled = false
    const controller = new AbortController()

    // Debounce so rapid settings toggles (PDF print options on the invoicing
    // page) don't burst-fire requests at /api/invoices/preview-pdf while the
    // dialog is open. AbortController still cancels any in-flight fetch.
    const timer = setTimeout(() => {
      run()
    }, 500)

    async function run() {
      setIsLoading(true)
      setError(null)

      try {
        const supabase = createClient()
        const { data: customer, error: customerError } = await supabase
          .from('customers')
          .select('id')
          .eq('company_id', companyId)
          .limit(1)
          .maybeSingle()

        if (customerError) throw customerError
        if (cancelled) return

        // Non-momsregistrerade säljare ska inte få en exempel-rad med 25 %
        // VAT: förhandsvisningen är hårdkodad sample-data, inte ett val
        // användaren gjort, så vi följer settings.vat_registered direkt här
        // (till skillnad från /invoices/new som låter användaren välja och
        // bara varnar vid submit).
        const previewVatRate = settings.vat_registered === false ? 0 : 25
        const response = await fetch('/api/invoices/preview-pdf', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            customer_id: customer?.id,
            currency: 'SEK',
            document_type: 'invoice',
            items: [
              {
                description: sampleItemDescription,
                quantity: 1,
                unit: 'st',
                unit_price: 1000,
                vat_rate: previewVatRate,
              },
            ],
          }),
        })

        if (!response.ok) {
          const body = await response.json().catch(() => null)
          throw new Error(body?.error || `HTTP ${response.status}`)
        }

        const blob = await response.blob()
        if (cancelled) return

        const url = URL.createObjectURL(blob)
        if (currentUrlRef.current) URL.revokeObjectURL(currentUrlRef.current)
        currentUrlRef.current = url
        setBlobUrl(url)
        setIsLoading(false)
      } catch (err) {
        if (cancelled) return
        if (err instanceof Error && err.name === 'AbortError') return
        setError(getErrorMessage(err, { locale, context: 'invoice' }))
        setIsLoading(false)
      }
    }

    return () => {
      cancelled = true
      clearTimeout(timer)
      controller.abort()
    }
  }, [open, settings, company?.id, sampleItemDescription, locale])

  useEffect(() => {
    return () => {
      if (currentUrlRef.current) {
        URL.revokeObjectURL(currentUrlRef.current)
        currentUrlRef.current = null
      }
    }
  }, [])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Eye className="h-4 w-4" />
          {t('preview_button')}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
        </DialogHeader>

        {isLoading && (
          <div className="space-y-2" aria-live="polite" aria-busy="true">
            <Skeleton className="h-[70vh] w-full rounded-lg" />
            <p className="text-xs text-muted-foreground">{t('loading')}</p>
          </div>
        )}

        {!isLoading && error && (
          <div className="flex h-[70vh] w-full items-center justify-center rounded-lg border border-border bg-muted/30 px-6 text-center">
            <p className="text-sm text-destructive">{t('error')}: {error}</p>
          </div>
        )}

        {!isLoading && !error && blobUrl && (
          // <object> + type="application/pdf" invokes Chrome's PDF plugin
          // directly. <iframe> went through Chrome's frame pipeline first
          // and intermittently surfaced "Det här innehållet har blockerats"
          // even with a permissive CSP. See AttachmentPreviewSheet.tsx for
          // the same workaround on journal entry attachments.
          <object
            data={blobUrl}
            type="application/pdf"
            title={t('iframe_title')}
            className="w-full h-[70vh] rounded-lg border border-border"
          >
            <p className="p-4 text-sm text-muted-foreground">
              {t('error')}:{' '}
              <a href={blobUrl} target="_blank" rel="noreferrer" className="underline">
                {t('iframe_title')}
              </a>
            </p>
          </object>
        )}
      </DialogContent>
    </Dialog>
  )
}
