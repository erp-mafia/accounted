'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { ArrowPathRoundedSquareIcon, DocumentArrowDownIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/ui/page-header'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { HelpPopover } from '@/components/ui/help-popover'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import { useToast } from '@/components/ui/use-toast'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { failureDescription } from '@/lib/browser/action-failure'
import type { ErrorLocale } from '@/lib/errors/get-error-message'
import { sumOre } from '@/lib/money'
import { formatCurrency, formatDate } from '@/lib/utils'
import { AutogiroAgreementSection } from '@/components/invoices/autogiro/AutogiroAgreementSection'
import { AutogiroDueSection } from '@/components/invoices/autogiro/AutogiroDueSection'
import { AutogiroReportUpload } from '@/components/invoices/autogiro/AutogiroReportUpload'
import { AutogiroMandatesSection } from '@/components/invoices/autogiro/AutogiroMandatesSection'
import { AutogiroDebitsSection } from '@/components/invoices/autogiro/AutogiroDebitsSection'
import { AutogiroFilesSection } from '@/components/invoices/autogiro/AutogiroFilesSection'
import { downloadAutogiroFile, jsonRequest, requestAutogiro } from '@/components/invoices/autogiro/client'
import type { AutogiroOverviewResponse, DebitFileResponse } from '@/components/invoices/autogiro/types'

/**
 * Autogiro: the company collects its customer invoices by Bankgirot direct
 * debit on its own agreement. Accounted writes the files, the company uploads
 * them in its internet bank, and the bank's report files come back here.
 * Top to bottom: the agreement, what to debit next, the upload for Bankgirot's
 * reports, the mandates, the latest debits and the files.
 */
export default function AutogiroPage() {
  const t = useTranslations('autogiro')
  const tCommon = useTranslations('common')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const { canWrite } = useCanWrite()
  const { dialogProps, confirm } = useDestructiveConfirm()

  const [data, setData] = useState<AutogiroOverviewResponse | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  // Bumped to read the overview again after a change; a newer read wins.
  const [reloadKey, setReloadKey] = useState(0)
  const load = useCallback(() => setReloadKey((key) => key + 1), [])
  // A reload that fails keeps the page as it was and says so in a toast.
  const loaded = useRef(false)

  useEffect(() => {
    let current = true
    void requestAutogiro<AutogiroOverviewResponse>('/api/invoices/autogiro', undefined, locale).then((result) => {
      if (!current) return
      if (!result.ok) {
        if (loaded.current) toast({ title: t('load_failed_title'), description: result.message, variant: 'destructive' })
        else setLoadError(result.message)
        return
      }
      loaded.current = true
      setLoadError(null)
      setData(result.data)
      // Every invoice that can go in is chosen until the person says otherwise.
      setSelected(new Set(result.data.overview.due.filter((d) => d.blocker === null).map((d) => d.invoice_id)))
    })
    return () => {
      current = false
    }
  }, [locale, reloadKey, t, toast])

  const help = (
    <HelpPopover>
      <div className="space-y-2">
        <p>{t('help_flow')}</p>
        <p>{t('help_mandates')}</p>
        <p>{t('help_invoice')}</p>
      </div>
    </HelpPopover>
  )

  if (!data) {
    return (
      <div className="space-y-8">
        <PageHeader title={t('title')} help={help} />
        {loadError ? (
          <EmptyState icon={ArrowPathRoundedSquareIcon} title={t('load_failed_title')} description={loadError}>
            <Button type="button" variant="outline" onClick={() => load()}>
              {tCommon('retry')}
            </Button>
          </EmptyState>
        ) : (
          <div className="space-y-3" role="status" aria-label={tCommon('loading')}>
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        )}
      </div>
    )
  }

  const { enabled, overview } = data

  if (!enabled && !overview.settings) {
    return (
      <div className="space-y-8">
        <PageHeader title={t('title')} />
        <EmptyState icon={ArrowPathRoundedSquareIcon} title={t('pilot_title')} description={t('pilot_description')} supportHint />
      </div>
    )
  }

  const debitable = overview.due.filter((d) => d.blocker === null)
  const chosen = debitable.filter((d) => selected.has(d.invoice_id))
  const canCreate = enabled && canWrite && overview.settings !== null
  const allChosen = chosen.length === debitable.length

  async function createDebitFile() {
    if (chosen.length === 0) return
    const total = sumOre(chosen.map((d) => d.amount))
    const firstDate = chosen.map((d) => d.debit_date).sort()[0]!
    const ok = await confirm(
      {
        title: t('create_file_title'),
        description: t('create_file_description', {
          count: chosen.length,
          total: formatCurrency(total),
          date: formatDate(firstDate),
        }),
        confirmLabel: t('create_file_confirm'),
        cancelLabel: tCommon('cancel'),
        variant: 'warning',
      },
      async () => {
        const result = await requestAutogiro<DebitFileResponse>(
          '/api/invoices/autogiro/debit-files',
          // All of them: the route takes every invoice that can go in.
          jsonRequest('POST', allChosen ? {} : { invoice_ids: chosen.map((d) => d.invoice_id) }),
          locale,
        )
        if (!result.ok) {
          toast({ title: t('create_file_failed'), description: result.message, variant: 'destructive' })
          throw new Error(result.message)
        }
        const skipped = result.data.skipped.length
        const download = await downloadAutogiroFile(result.data.file, locale)
        if (download.ok) {
          toast({
            title: t('create_file_done', { count: result.data.debits, total: formatCurrency(result.data.total) }),
            description: [t('create_file_upload'), skipped > 0 ? t('create_file_skipped', { count: skipped }) : null]
              .filter(Boolean)
              .join(' '),
          })
        } else {
          toast({
            title: t('create_file_download_failed'),
            description: `${failureDescription(download, {
              timeout: tCommon('download_timeout'),
              network: tCommon('download_network'),
            })} ${t('download_from_files')}`,
            variant: 'destructive',
          })
        }
      },
    )
    if (ok) load()
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('title')}
        help={help}
        action={
          canCreate && debitable.length > 0 ? (
            <Button
              size="sm"
              type="button"
              disabled={chosen.length === 0}
              title={chosen.length === 0 ? t('create_file_none_chosen') : undefined}
              onClick={() => void createDebitFile()}
            >
              <DocumentArrowDownIcon className="mr-2 h-4 w-4" aria-hidden="true" />
              {allChosen ? t('create_file') : t('create_file_count', { count: chosen.length })}
            </Button>
          ) : undefined
        }
      />

      <AutogiroAgreementSection
        key={overview.settings ? `${overview.settings.customer_number}-${overview.settings.bankgiro}` : 'none'}
        settings={overview.settings}
        enabled={enabled}
        canWrite={canWrite}
        onSaved={load}
      />

      {overview.settings && (
        <>
          <AutogiroDueSection
            due={overview.due}
            selected={selected}
            selectable={canCreate}
            onToggle={(invoiceId, checked) =>
              setSelected((current) => {
                const next = new Set(current)
                if (checked) next.add(invoiceId)
                else next.delete(invoiceId)
                return next
              })
            }
            onToggleAll={(checked) => setSelected(new Set(checked ? debitable.map((d) => d.invoice_id) : []))}
          />

          <AutogiroReportUpload canWrite={canWrite} onApplied={load} />
        </>
      )}

      {/* Before the agreement is entered there is nothing to list yet. */}
      {(overview.settings || overview.mandates.length > 0 || overview.debits.length > 0 || overview.files.length > 0) && (
        <>
          <AutogiroMandatesSection mandates={overview.mandates} canWrite={canWrite} onChanged={load} />
          <AutogiroDebitsSection debits={overview.debits} due={overview.due} canWrite={canWrite} onChanged={load} />
          <AutogiroFilesSection files={overview.files} debits={overview.debits} canWrite={canWrite} onChanged={load} />
        </>
      )}

      <DestructiveConfirmDialog {...dialogProps} />
    </div>
  )
}
