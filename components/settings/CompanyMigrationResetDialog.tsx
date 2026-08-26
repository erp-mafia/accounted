'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { AlertTriangle, Archive, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/components/ui/use-toast'
import { getBranding } from '@/lib/branding/service'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { useFormat } from '@/lib/hooks/use-format'
import {
  COMPANY_MIGRATION_RESET_COUNT_KEYS,
  type CompanyMigrationResetBlocker,
  type CompanyMigrationResetEligibility,
} from '@/types'

interface CompanyMigrationResetDialogProps {
  companyId: string
  companyName: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

const branding = getBranding()

function readApiError(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback
  const error = (body as { error?: unknown }).error
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return fallback
}

export function CompanyMigrationResetDialog({
  companyId,
  companyName,
  open,
  onOpenChange,
}: CompanyMigrationResetDialogProps) {
  const t = useTranslations('settings_company')
  const router = useRouter()
  const { toast } = useToast()
  const { formatDateLong } = useFormat()
  const loadFailedMessage = t('reset_load_failed')
  const [eligibility, setEligibility] = useState<CompanyMigrationResetEligibility | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isResetting, setIsResetting] = useState(false)
  const [reason, setReason] = useState('')
  const [confirmName, setConfirmName] = useState('')
  const [confirmedNoFilings, setConfirmedNoFilings] = useState(false)
  const [confirmedArchive, setConfirmedArchive] = useState(false)

  useEffect(() => {
    if (!open) return

    let cancelled = false
    async function loadEligibility() {
      setIsLoading(true)
      setLoadError(null)
      setEligibility(null)
      try {
        const response = await fetch(`/api/company/${companyId}/migration-reset`, {
          cache: 'no-store',
        })
        const body = await response.json().catch(() => ({}))
        if (!response.ok) {
          throw new Error(readApiError(body, loadFailedMessage))
        }
        if (!cancelled) setEligibility(body.data as CompanyMigrationResetEligibility)
      } catch (error) {
        if (!cancelled) {
          setLoadError(
            error instanceof Error ? getUserErrorMessage(error) : loadFailedMessage,
          )
        }
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    void loadEligibility()
    return () => {
      cancelled = true
    }
  }, [companyId, loadFailedMessage, open])

  function resetForm() {
    setEligibility(null)
    setLoadError(null)
    setReason('')
    setConfirmName('')
    setConfirmedNoFilings(false)
    setConfirmedArchive(false)
  }

  function handleOpenChange(nextOpen: boolean) {
    if (isResetting) return
    onOpenChange(nextOpen)
    if (!nextOpen) resetForm()
  }

  function blockerMessage(blocker: CompanyMigrationResetBlocker): string {
    switch (blocker.code) {
      case 'migration_window_expired':
        return t('reset_blocker_window', {
          date: eligibility ? formatDateLong(eligibility.window_ends_at) : '',
        })
      case 'sandbox_company':
        return t('reset_blocker_sandbox')
      case 'locked_or_closed_periods':
        return t('reset_blocker_periods', { count: blocker.count })
      case 'journal_entries_exist':
      case 'non_import_committed_entries':
        return t('reset_blocker_entries', { count: blocker.count })
      case 'voucher_sequence_state_exists':
        return t('reset_blocker_sequences', { count: blocker.count })
      case 'invoice_records_exist':
        return t('reset_blocker_invoices', { count: blocker.count })
      case 'authority_submission_detected':
        return t('reset_blocker_filings', { count: blocker.count })
      case 'live_bank_connections':
        return t('reset_blocker_bank_connections', { count: blocker.count })
      case 'imports_in_progress':
        return t('reset_blocker_imports', { count: blocker.count })
      case 'active_integrations_or_schedules':
        return t('reset_blocker_automations', { count: blocker.count })
      case 'background_work_in_progress':
        return t('reset_blocker_background_work', { count: blocker.count })
      default:
        return t('reset_blocker_other')
    }
  }

  function countLabel(key: (typeof COMPANY_MIGRATION_RESET_COUNT_KEYS)[number]): string {
    switch (key) {
      case 'journal_entries': return t('reset_count_journal_entries')
      case 'journal_entry_lines': return t('reset_count_journal_entry_lines')
      case 'committed_import_entries': return t('reset_count_committed_import_entries')
      case 'transactions': return t('reset_count_transactions')
      case 'fiscal_periods': return t('reset_count_fiscal_periods')
      case 'documents': return t('reset_count_documents')
      case 'voucher_sequences': return t('reset_count_voucher_sequences')
      case 'sie_imports': return t('reset_count_sie_imports')
      case 'bank_file_imports': return t('reset_count_bank_file_imports')
      case 'skattekonto_file_imports': return t('reset_count_skattekonto_file_imports')
      case 'bank_connections': return t('reset_count_bank_connections')
      case 'customers': return t('reset_count_customers')
      case 'suppliers': return t('reset_count_suppliers')
      case 'invoices': return t('reset_count_invoices')
      case 'supplier_invoices': return t('reset_count_supplier_invoices')
    }
  }

  const confirmationName = eligibility?.display_name ?? companyName
  const canReset = eligibility?.eligible === true
    && reason.trim().length >= 20
    && confirmName.trim() === confirmationName.trim()
    && confirmedNoFilings
    && confirmedArchive
    && !isResetting

  async function handleReset() {
    if (!canReset) return
    setIsResetting(true)
    try {
      const response = await fetch(`/api/company/${companyId}/migration-reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirm_name: confirmName,
          reason,
          confirm_no_filed_declarations: confirmedNoFilings,
          confirm_retained_archive: confirmedArchive,
        }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(readApiError(body, t('reset_failed_default')))
      }

      toast({
        title: t('reset_success_title'),
        description: t('reset_success_description'),
      })
      setIsResetting(false)
      onOpenChange(false)
      resetForm()
      router.push('/import')
      router.refresh()
    } catch (error) {
      toast({
        title: t('reset_failed_title'),
        description: error instanceof Error
          ? getUserErrorMessage(error)
          : t('reset_failed_default'),
        variant: 'destructive',
      })
      setIsResetting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle data-ph-mask="">
            {t('reset_dialog_title', { companyName })}
          </DialogTitle>
          <DialogDescription>{t('reset_dialog_description')}</DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex min-h-40 items-center justify-center text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t('reset_checking')}
          </div>
        ) : loadError ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            {loadError}
          </div>
        ) : eligibility ? (
          <div className="space-y-5">
            <div className="flex gap-3 rounded-lg border border-border bg-muted/40 p-4">
              <Archive className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
              <div className="space-y-1 text-sm">
                <p className="font-medium text-foreground">{t('reset_archive_title')}</p>
                <p className="text-muted-foreground">{t('reset_archive_description')}</p>
              </div>
            </div>

            {eligibility.blockers.length > 0 ? (
              <div className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
                <div className="flex items-center gap-2 text-sm font-medium text-destructive">
                  <AlertTriangle className="h-4 w-4" />
                  {t('reset_blocked_title')}
                </div>
                <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                  {eligibility.blockers.map((blocker) => (
                    <li key={blocker.code}>{blockerMessage(blocker)}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div>
              <h3 className="mb-2 text-sm font-medium">{t('reset_retained_heading')}</h3>
              <dl className="divide-y divide-border border-y border-border">
                {COMPANY_MIGRATION_RESET_COUNT_KEYS.map((key) => (
                  <div key={key} className="flex items-center justify-between py-2 text-sm">
                    <dt className="text-muted-foreground">{countLabel(key)}</dt>
                    <dd className="tabular-nums font-medium">{eligibility.counts[key] ?? 0}</dd>
                  </div>
                ))}
              </dl>
            </div>

            {eligibility.eligible ? (
              <>
                <div className="space-y-2">
                  <Label htmlFor="migration-reset-reason">{t('reset_reason_label')}</Label>
                  <Textarea
                    id="migration-reset-reason"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder={t('reset_reason_placeholder')}
                    maxLength={1000}
                    data-ph-mask=""
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('reset_reason_help', { count: reason.trim().length })}
                  </p>
                </div>

                <div className="space-y-3">
                  <div className="flex items-start gap-3">
                    <Checkbox
                      id="migration-reset-no-filings"
                      checked={confirmedNoFilings}
                      onCheckedChange={(checked) => setConfirmedNoFilings(checked === true)}
                    />
                    <Label htmlFor="migration-reset-no-filings" className="font-normal leading-5">
                      {t('reset_confirm_no_filings', { appName: branding.appName })}
                    </Label>
                  </div>
                  <div className="flex items-start gap-3">
                    <Checkbox
                      id="migration-reset-retained"
                      checked={confirmedArchive}
                      onCheckedChange={(checked) => setConfirmedArchive(checked === true)}
                    />
                    <Label htmlFor="migration-reset-retained" className="font-normal leading-5">
                      {t('reset_confirm_archive')}
                    </Label>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label data-ph-mask="" htmlFor="migration-reset-name">
                    {t.rich('reset_confirm_name', {
                      companyName: confirmationName,
                      strong: (chunks) => <strong>{chunks}</strong>,
                    })}
                  </Label>
                  <Input
                    id="migration-reset-name"
                    value={confirmName}
                    onChange={(event) => setConfirmName(event.target.value)}
                    placeholder={confirmationName}
                    autoComplete="off"
                    className="ph-no-capture"
                  />
                </div>
              </>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={isResetting}>
            {t('danger_cancel')}
          </Button>
          {eligibility?.eligible ? (
            <Button variant="destructive" onClick={handleReset} disabled={!canReset}>
              {isResetting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('reset_resetting')}
                </>
              ) : t('reset_submit')}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
