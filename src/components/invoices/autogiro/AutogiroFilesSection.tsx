'use client'

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { ArrowDownTrayIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { HelpPopover } from '@/components/ui/help-popover'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import { HOVER_REVEAL_CLASS, TD_CLASS, TH_CLASS } from '@/components/ui/dry-table'
import { useToast } from '@/components/ui/use-toast'
import { failureDescription } from '@/lib/browser/action-failure'
import type { ErrorLocale } from '@/lib/errors/get-error-message'
import { cn, formatDate } from '@/lib/utils'
import { AutogiroSection } from './AutogiroSection'
import { downloadAutogiroFile, jsonRequest, requestAutogiro } from './client'
import { fileKindLabel, fileSummary } from './labels'
import type { AutogiroDebitRow, AutogiroFileRow } from './types'

/**
 * Filer: what went to Bankgirot (debit and cancellation files) and what came
 * back (the reports read). A stored file downloads again; mandate reports
 * carry personal data and are not stored. A debit file Bankgirot has not
 * reported on can be withdrawn, which frees its invoices for a new file but
 * does not stop a file already uploaded in the bank.
 */
export function AutogiroFilesSection({
  files,
  debits,
  canWrite,
  onChanged,
}: {
  files: AutogiroFileRow[]
  debits: AutogiroDebitRow[]
  canWrite: boolean
  onChanged: () => void
}) {
  const t = useTranslations('autogiro')
  const tCommon = useTranslations('common')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const { dialogProps, confirm } = useDestructiveConfirm()
  const [downloading, setDownloading] = useState<string | null>(null)

  /** A debit file whose debits are all still sent (none reported, at least one not withdrawn). */
  function withdrawable(file: AutogiroFileRow): boolean {
    if (file.kind !== 'debits' || file.direction !== 'to_bankgirot') return false
    const own = debits.filter((d) => d.file_id === file.id)
    return own.some((d) => d.status === 'sent') && own.every((d) => d.status === 'sent' || d.status === 'cancelled')
  }

  async function download(file: AutogiroFileRow) {
    if (downloading) return
    setDownloading(file.id)
    const result = await downloadAutogiroFile({ id: file.id, filename: file.filename ?? 'autogiro.txt' }, locale)
    setDownloading(null)
    if (!result.ok) {
      toast({
        title: t('download_failed'),
        description: failureDescription(result, { timeout: tCommon('download_timeout'), network: tCommon('download_network') }),
        variant: 'destructive',
      })
    }
  }

  async function withdraw(file: AutogiroFileRow) {
    const ok = await confirm(
      {
        title: t('withdraw_title'),
        description: t('withdraw_description'),
        confirmLabel: t('withdraw_confirm'),
        cancelLabel: tCommon('cancel'),
        variant: 'warning',
      },
      async () => {
        const result = await requestAutogiro<{ cancelled: number }>(
          `/api/invoices/autogiro/debit-files/${file.id}/withdraw`,
          jsonRequest('POST'),
          locale,
        )
        if (!result.ok) {
          toast({ title: t('withdraw_failed'), description: result.message, variant: 'destructive' })
          throw new Error(result.message)
        }
        toast({ title: t('withdraw_done', { count: result.data.cancelled }) })
      },
    )
    if (ok) onChanged()
  }

  return (
    <AutogiroSection
      title={t('files_title')}
      help={
        <HelpPopover>
          <p>{t('files_help')}</p>
        </HelpPopover>
      }
    >
      {files.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">{t('files_empty')}</p>
      ) : (
        <div className="-mx-2 overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className={TH_CLASS}>{t('col_file')}</th>
                <th className={TH_CLASS}>{t('col_date')}</th>
                <th className={cn(TH_CLASS, 'w-full')}>{t('col_summary')}</th>
                <th className={TH_CLASS} aria-hidden="true"></th>
              </tr>
            </thead>
            <tbody className="stagger-enter">
              {files.map((file) => (
                <tr key={file.id} className="group transition-colors duration-150 hover:bg-secondary/35">
                  <td className={cn(TD_CLASS, 'whitespace-nowrap')}>
                    {fileKindLabel(file.kind, t)}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {file.direction === 'to_bankgirot' ? t('file_to_bankgirot') : t('file_from_bankgirot')}
                    </span>
                  </td>
                  <td className={cn(TD_CLASS, 'whitespace-nowrap date-figures')}>{formatDate(file.created_at)}</td>
                  <td className={cn(TD_CLASS, 'max-w-0')}>
                    <span className="block truncate text-muted-foreground" title={file.filename ?? undefined}>
                      {fileSummary(file, t)}
                    </span>
                  </td>
                  <td className={cn(TD_CLASS, 'whitespace-nowrap text-right')}>
                    <span className="inline-flex items-center justify-end gap-2">
                      {canWrite && withdrawable(file) && (
                        <Button type="button" variant="ghost" className={HOVER_REVEAL_CLASS} onClick={() => void withdraw(file)}>
                          {t('withdraw_action')}
                        </Button>
                      )}
                      {file.stored && (
                        <Button
                          type="button"
                          variant="ghost"
                          className={HOVER_REVEAL_CLASS}
                          loading={downloading === file.id}
                          disabled={downloading !== null && downloading !== file.id}
                          onClick={() => void download(file)}
                        >
                          {downloading !== file.id && <ArrowDownTrayIcon className="h-3.5 w-3.5" aria-hidden="true" />}
                          {t('download')}
                        </Button>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <DestructiveConfirmDialog {...dialogProps} />
    </AutogiroSection>
  )
}
