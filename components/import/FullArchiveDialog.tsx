'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { AttnLine } from '@/components/ui/attn-line'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/use-toast'
import { useCompany } from '@/contexts/CompanyContext'
import { useFormat } from '@/lib/hooks/use-format'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { FiscalYearSelector } from '@/components/common/FiscalYearSelector'
import { Download, Loader2 } from 'lucide-react'

type Scope = 'all' | 'period'

interface EstimateResponse {
  total_bytes: number
  document_bytes: number
  document_count: number
  size_limit_bytes: number
  within_limit: boolean
}

const LAST_DOWNLOAD_STORAGE_KEY = 'Accounted:last-backup-download'

/**
 * Direct download of the complete company archive (SIE + reports + all
 * supporting documents) as a ZIP, via GET /api/reports/full-archive.
 * The route is owner/admin-only; the caller gates the entry point.
 */
export function FullArchiveDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useTranslations('import')
  const errorLocale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const { company } = useCompany()
  const { formatDateLong } = useFormat()

  const [scope, setScope] = useState<Scope>('all')
  const [periodId, setPeriodId] = useState<string | null>(null)
  const [includeDocuments, setIncludeDocuments] = useState(true)
  const [estimate, setEstimate] = useState<EstimateResponse | null>(null)
  const [isLoadingEstimate, setIsLoadingEstimate] = useState(false)
  const [isDownloading, setIsDownloading] = useState(false)
  const [lastDownloadedAt, setLastDownloadedAt] = useState<string | null>(null)

  const storageKey = useMemo(
    () => (company ? `${LAST_DOWNLOAD_STORAGE_KEY}:${company.id}` : null),
    [company]
  )

  useEffect(() => {
    if (!storageKey || !open) return
    setLastDownloadedAt(window.localStorage.getItem(storageKey))
  }, [storageKey, open])

  const archiveUrl = useMemo(() => {
    const params = new URLSearchParams({ scope })
    if (scope === 'period' && periodId) params.set('period_id', periodId)
    if (!includeDocuments) params.set('include_documents', 'false')
    return `/api/reports/full-archive?${params.toString()}`
  }, [scope, periodId, includeDocuments])

  useEffect(() => {
    if (!open || (scope === 'period' && !periodId)) {
      setEstimate(null)
      return
    }
    let cancelled = false
    setIsLoadingEstimate(true)
    setEstimate(null)
    ;(async () => {
      try {
        const res = await fetch(`${archiveUrl}&estimate=1`)
        if (!res.ok) return
        const { data } = (await res.json()) as { data: EstimateResponse }
        if (!cancelled) setEstimate(data)
      } catch {
        // leave estimate null; the user can still attempt the download
      } finally {
        if (!cancelled) setIsLoadingEstimate(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, archiveUrl, scope, periodId])

  const handleDownload = useCallback(async () => {
    if (scope === 'period' && !periodId) return

    setIsDownloading(true)
    try {
      const res = await fetch(archiveUrl)
      if (!res.ok) {
        if (res.status === 413) {
          const body = await res.json().catch(() => ({}))
          const sizeMb = body.size_bytes ? Math.round(body.size_bytes / (1024 * 1024)) : null
          toast({
            title: t('archive_toast_too_large_title'),
            description: sizeMb
              ? t('archive_toast_too_large_with_size', { size: sizeMb })
              : t('archive_toast_too_large_generic'),
            variant: 'destructive',
          })
          return
        }
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || t('archive_toast_failed'))
      }

      const blob = await res.blob()
      const contentDisposition = res.headers.get('Content-Disposition') || ''
      const match = contentDisposition.match(/filename="?([^";]+)"?/)
      const filename = match?.[1] || 'arkiv.zip'

      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      window.URL.revokeObjectURL(url)

      const now = new Date().toISOString()
      if (storageKey) {
        window.localStorage.setItem(storageKey, now)
        setLastDownloadedAt(now)
      }

      toast({ title: t('archive_toast_created'), description: filename })
    } catch (err) {
      toast({
        title: t('archive_toast_failed'),
        description:
          err instanceof Error
            ? getErrorMessage(err, { locale: errorLocale })
            : t('archive_error_fallback'),
        variant: 'destructive',
      })
    } finally {
      setIsDownloading(false)
    }
  }, [archiveUrl, scope, periodId, storageKey, toast, t, errorLocale])

  const isOverLimit = !!estimate && !estimate.within_limit && includeDocuments
  const canDownload = !isDownloading && !isOverLimit && (scope === 'all' || !!periodId)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display text-lg tracking-tight">
            {t('export_archive_title')}
          </DialogTitle>
          <DialogDescription className="text-[13px] leading-relaxed">
            {t('archive_dialog_description')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <SegmentedControl
              value={scope}
              onChange={setScope}
              aria-label={t('archive_scope_label')}
              options={[
                { value: 'all', label: t('archive_scope_all') },
                { value: 'period', label: t('archive_scope_period') },
              ]}
            />
            {/* The two scopes count different document sets (all documents vs
                only those linked to posted vouchers in the year), so a company
                with unlinked inbox receipts sees very different counts. Say so,
                or the gap reads as a pagination bug. */}
            <p className="text-xs leading-5 text-muted-foreground">
              {scope === 'all' ? t('archive_scope_all_note') : t('archive_scope_period_note')}
            </p>
          </div>

          {scope === 'period' && (
            <FiscalYearSelector
              value={periodId}
              onChange={setPeriodId}
              includeAllOption={false}
              hideFuturePeriods
            />
          )}

          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <Label htmlFor="archive-include-documents">{t('archive_include_docs_label')}</Label>
              <p className="text-xs leading-5 text-muted-foreground">
                {t('archive_include_docs_help')}
              </p>
            </div>
            <Switch
              id="archive-include-documents"
              checked={includeDocuments}
              onCheckedChange={setIncludeDocuments}
            />
          </div>

          <div role="status" aria-live="polite" className="space-y-1">
            <p className="text-[13px] text-muted-foreground">
              {isLoadingEstimate ? (
                t('archive_calculating_size')
              ) : estimate ? (
                <>
                  {t('archive_estimated_size')}{' '}
                  <strong className="font-medium tabular-nums text-foreground">
                    {formatBytes(estimate.total_bytes)}
                  </strong>{' '}
                  ({estimate.document_count}{' '}
                  {estimate.document_count === 1
                    ? t('archive_attachment_singular')
                    : t('archive_attachment_plural')}
                  )
                </>
              ) : (
                t('archive_size_pending')
              )}
            </p>
            {lastDownloadedAt && (
              <p className="text-xs text-muted-foreground">
                {t('archive_last_download')}: {formatDateLong(lastDownloadedAt)}
              </p>
            )}
          </div>

          {isOverLimit && (
            <AttnLine>
              {t('archive_over_limit', { limit: formatBytes(estimate!.size_limit_bytes) })}
            </AttnLine>
          )}
        </div>
        <DialogFooter>
          <Button onClick={handleDownload} disabled={!canDownload}>
            {isDownloading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t('archive_creating')}
              </>
            ) : (
              <>
                <Download className="mr-2 h-4 w-4" />
                {t('archive_download_button')}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} kB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  return `${(mb / 1024).toFixed(2)} GB`
}
