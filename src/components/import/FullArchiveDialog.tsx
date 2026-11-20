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
import { useCompany } from '@/contexts/CompanyContext'
import { useFormat } from '@/lib/hooks/use-format'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { startBrowserDownload } from '@/lib/browser/download-file'
import { FiscalYearSelector } from '@/components/common/FiscalYearSelector'
import type { ApiResponse, ArchiveEstimate } from '@/types'
import { ArrowDownTrayIcon } from '@/components/icons'

type Scope = 'all' | 'period'
type ArchiveMode = 'active-company' | 'migration-reset-source'

const LAST_DOWNLOAD_STORAGE_KEY = 'Accounted:last-backup-download'

/**
 * Direct download of the complete company archive (SIE + reports + all
 * supporting documents) as a ZIP. The normal mode uses the owner/admin-only
 * full-archive route; migration-reset mode uses its owner-only retained-source
 * route without making that archived company active.
 *
 * The routes stream the ZIP, which runs to gigabytes for years of underlag,
 * so the browser's own download manager saves it straight to disk and shows
 * the progress: read into the tab first, the archive would have to fit in its
 * memory. The browser cannot hand a refusal back to this dialog, so the size
 * request (which the route authorizes the same way) carries an access
 * refusal. A failure while the archive is built (an SIE import in progress, a
 * storage outage) can only show as a failed download, logged by the route.
 */
export function FullArchiveDialog({
  open,
  onOpenChange,
  mode = 'active-company',
  companyId: explicitCompanyId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode?: ArchiveMode
  companyId?: string
}) {
  const t = useTranslations('import')
  const tCompany = useTranslations('settings_company')
  const errorLocale = useLocale() as ErrorLocale
  const { company } = useCompany()
  const { formatDateLong } = useFormat()

  const [scope, setScope] = useState<Scope>('all')
  const [periodId, setPeriodId] = useState<string | null>(null)
  const [includeDocuments, setIncludeDocuments] = useState(true)
  const [estimate, setEstimate] = useState<ArchiveEstimate | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [isLoadingEstimate, setIsLoadingEstimate] = useState(false)
  const [lastDownloadedAt, setLastDownloadedAt] = useState<string | null>(null)
  const isMigrationResetSource = mode === 'migration-reset-source'
  const archiveCompanyId = isMigrationResetSource
    ? explicitCompanyId ?? company?.id
    : company?.id

  const storageKey = useMemo(
    () => archiveCompanyId
      ? isMigrationResetSource
        ? `${LAST_DOWNLOAD_STORAGE_KEY}:migration-reset:${archiveCompanyId}`
        : `${LAST_DOWNLOAD_STORAGE_KEY}:${archiveCompanyId}`
      : null,
    [archiveCompanyId, isMigrationResetSource]
  )

  useEffect(() => {
    if (!storageKey || !open) return
    setLastDownloadedAt(window.localStorage.getItem(storageKey))
  }, [storageKey, open])

  const archiveUrl = useMemo(() => {
    if (isMigrationResetSource) {
      if (!archiveCompanyId) return ''
      const params = new URLSearchParams()
      if (!includeDocuments) params.set('include_documents', 'false')
      const query = params.toString()
      return `/api/company/${archiveCompanyId}/migration-reset/archive${query ? `?${query}` : ''}`
    }

    const params = new URLSearchParams({ scope })
    if (scope === 'period' && periodId) params.set('period_id', periodId)
    if (!includeDocuments) params.set('include_documents', 'false')
    return `/api/reports/full-archive?${params.toString()}`
  }, [archiveCompanyId, includeDocuments, isMigrationResetSource, periodId, scope])

  useEffect(() => {
    if (!open || !archiveUrl || (!isMigrationResetSource && scope === 'period' && !periodId)) {
      setEstimate(null)
      setRefusal(null)
      return
    }
    let cancelled = false
    setIsLoadingEstimate(true)
    setEstimate(null)
    setRefusal(null)
    ;(async () => {
      try {
        const separator = archiveUrl.includes('?') ? '&' : '?'
        const res = await fetch(`${archiveUrl}${separator}estimate=1`)
        if (!res.ok) {
          // A 4xx is the answer the download would get too (no access, no
          // retained source): say it here, since a browser download cannot.
          if (res.status >= 400 && res.status < 500 && !cancelled) {
            const body: unknown = await res.json().catch(() => null)
            if (!cancelled) setRefusal(getErrorMessage(body, { statusCode: res.status, locale: errorLocale }))
          }
          return
        }
        const { data } = (await res.json()) as ApiResponse<ArchiveEstimate>
        if (!cancelled && data) setEstimate(data)
      } catch {
        // leave estimate null; the user can still attempt the download
      } finally {
        if (!cancelled) setIsLoadingEstimate(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, archiveUrl, isMigrationResetSource, scope, periodId, errorLocale])

  const handleDownload = useCallback(() => {
    if (!archiveUrl || (!isMigrationResetSource && scope === 'period' && !periodId)) return
    startBrowserDownload(archiveUrl)
    const now = new Date().toISOString()
    if (storageKey) {
      window.localStorage.setItem(storageKey, now)
      setLastDownloadedAt(now)
    }
    onOpenChange(false)
  }, [archiveUrl, isMigrationResetSource, onOpenChange, periodId, scope, storageKey])

  const plannedSizeBytes = estimate
    ? includeDocuments
      ? estimate.total_bytes
      : Math.max(0, estimate.total_bytes - estimate.document_bytes)
    : 0
  const canDownload = !refusal && (isMigrationResetSource || scope === 'all' || !!periodId)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="confirm">
        <DialogHeader>
          <DialogTitle className="text-lg">
            {isMigrationResetSource
              ? tCompany('reset_archive_download_title')
              : t('export_archive_title')}
          </DialogTitle>
          <DialogDescription className="text-[13px] leading-relaxed">
            {isMigrationResetSource
              ? tCompany('reset_archive_download_description')
              : t('archive_dialog_description')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {!isMigrationResetSource ? (
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
          ) : null}

          {!isMigrationResetSource && scope === 'period' && (
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
                    {formatBytes(plannedSizeBytes)}
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

          <p className="text-xs leading-5 text-muted-foreground">{t('archive_download_note')}</p>

          {refusal && <AttnLine>{refusal}</AttnLine>}
        </div>
        <DialogFooter>
          <Button onClick={handleDownload} disabled={!canDownload}>
            <ArrowDownTrayIcon className="h-4 w-4" />
            {t('archive_download_button')}
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
