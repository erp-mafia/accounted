'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { AttnLine } from '@/components/ui/attn-line'
import { HelpPopover } from '@/components/ui/help-popover'
import { DefList, DefRow } from '@/components/arkiv/DefList'
import { ArrowTopRightOnSquareIcon, ArrowUturnLeftIcon } from '@/components/icons'
import {
  DestructiveConfirmDialog,
  useDestructiveConfirm,
} from '@/components/ui/destructive-confirm-dialog'
import { cn, formatCurrency } from '@/lib/utils'
import { useCompany } from '@/contexts/CompanyContext'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import TheaterCanvas from '@/components/import/TheaterCanvas'
import { FiscalYearGapNotice } from '@/components/import/FiscalYearGapNotice'
import { OpeningBalanceDifferencesTable } from '@/components/import/OpeningBalanceDifferencesTable'
import type { ImportPreview, ImportResult } from '@/lib/import/types'
import { resolveNotices } from '@/lib/import/notices'
import { ImportNotices } from '@/components/import/ImportNotices'
import type { TheaterModel } from '@/lib/import/theater-model'

/** The lead of a skipped-voucher line: its count and kind, set apart. */
const strong = (chunks: ReactNode) => <span className="font-medium">{chunks}</span>

interface ImportResultStepProps {
  result: ImportResult
  onNewImport: () => void
  onUndo?: (importId: string) => Promise<void> | void
  /** When the theater ran, the reveal replaces the plain success header:
   *  the settled constellation beside the personalized story + the bank
   *  bridge. Absent (failure, oversized file, parse miss) = plain header. */
  preview?: ImportPreview | null
  theaterModel?: TheaterModel | null
}

export default function ImportResultStep({
  result,
  onNewImport,
  onUndo,
  preview = null,
  theaterModel = null,
}: ImportResultStepProps) {
  const t = useTranslations('import')
  const tStep = useTranslations('import.sie_result')
  const { dialogProps, confirm } = useDestructiveConfirm()
  const { isSandbox } = useCompany()
  const hasBanking = ENABLED_EXTENSION_IDS.has('enable-banking')
  // The reveal only tells a story that is true: it needs the theater model,
  // the preview, and actual imported entries (an opening-balances-only run
  // must not claim "history in place" over an untouched constellation).
  const showReveal =
    result.success && !!theaterModel && !!preview && result.journalEntriesCreated > 0

  const handleUndoClick = async () => {
    if (!result.importId || !onUndo) return
    const ok = await confirm({
      title: t('sie_history_undo_confirm_title'),
      description: t('sie_job.undoConfirm'),
      confirmLabel: t('sie_history_undo_confirm_label'),
    })
    if (!ok) return
    await onUndo(result.importId)
  }
  const hasErrors = result.errors.length > 0
  const skipped = result.details?.skippedVouchers
  const untransferred = result.details?.untransferredResults
  const ibDifferences = result.details?.openingBalanceDifferences ?? []
  // The omföring of last year's result the import booked the way the file's
  // #IB has it (sie-result-transfer.ts).
  const resultTransfer = result.details?.resultTransfer
  // The books open on the file's own previous year on every account: the
  // file's #IB is the side that is off (booksMatchFilePreviousYear).
  const ibFileOff = (result.notices ?? []).some((n) => n.code === 'sie_ib_file_differs_from_previous_year')
  // Outcome rows that show beside the reveal too (the reveal carries the counts).
  const hasOutcomeRows =
    !!result.nextPeriodIBResync ||
    !!result.dimensionsImported ||
    !!resultTransfer ||
    (!!skipped && skipped.total > 0)

  // The skipped-voucher, untransferred-result, IB-difference, IB-resync and
  // result-transfer rows and lines below render those facts with their own
  // explanations, so their notice codes are excluded here by code, never by
  // matching Swedish sentences.
  const notices = resolveNotices(result, [
    'sie_vouchers_skipped',
    'sie_untransferred_result',
    'sie_ib_differs_from_file',
    'sie_ib_file_differs_from_previous_year',
    'sie_next_ib_resynced',
    'sie_next_period_locked',
    'sie_result_transferred',
  ])

  return (
    <div className="space-y-6">
      {/* "Din historia" reveal (theater ran) or the plain success/failure header */}
      {showReveal && theaterModel && preview ? (
        <Card>
          <CardContent>
            <div className="grid items-center gap-6 md:grid-cols-[minmax(280px,380px)_1fr]">
              <div>
                <p className="text-xs font-medium text-muted-foreground">
                  {t('reveal_eyebrow')}
                </p>
                <h2 className="mt-2 text-xl text-balance">
                  {t('reveal_title', { years: Math.max(theaterModel.years.length, 1) })}
                </h2>
                <p className="mt-3 text-[13px] text-muted-foreground tabular-nums">
                  {t('reveal_stats', {
                    vouchers: result.journalEntriesCreated,
                    accounts: preview.accountCount,
                    counterparties: theaterModel.totalCounterparties,
                  })}
                </p>
                {/* The balance claim comes from the pre-import file check; it
                    stays honest only when no unbalanced voucher was skipped. */}
                {preview.trialBalance.isBalanced && !(skipped && skipped.unbalanced > 0) && (
                  <p className="mt-1 text-[13px] tabular-nums text-success">{t('reveal_tie_ok')}</p>
                )}
                {skipped && skipped.total > 0 && (
                  <p className="mt-1 text-[13px] text-warning">
                    {t('reveal_skipped', { count: skipped.total })}
                  </p>
                )}
                <div className="mt-6 border-t-hairline pt-4">
                  {/* Sandbox strips live bank connections from /import, so the
                      bridge quiets down to the plain way onward there. */}
                  {!isSandbox && <p className="text-[15px] font-medium leading-[22px] text-strong">{t('reveal_bridge')}</p>}
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    {/* Both migrator paths: PSD2 covers recent history (banks
                        cap the window around 90 days), CSV upload reaches the
                        older period the SIE file covers. Either way the
                        overlap is matched against the imported verifikat.
                        Sandbox hides only the live bank connection; file-based
                        import works there and its CTA stays. */}
                    {!isSandbox && hasBanking && (
                      <Button asChild>
                        <Link href="/import?mode=psd2">{t('reveal_cta_bank')}</Link>
                      </Button>
                    )}
                    <Button
                      asChild
                      variant={!isSandbox && hasBanking ? 'outline' : 'default'}
                    >
                      <Link href="/import?mode=bank">{t('reveal_cta_csv')}</Link>
                    </Button>
                    <Link
                      href="/"
                      className="text-xs text-muted-foreground underline decoration-foreground/25 underline-offset-4 transition-colors hover:text-foreground"
                    >
                      {t('reveal_cta_open')}
                    </Link>
                  </div>
                </div>
              </div>
              <div className="relative hidden min-h-[360px] md:block">
                <TheaterCanvas model={theaterModel} settled />
              </div>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div>
          <h2
            className={cn(
              'text-xl',
              !result.success && 'text-destructive',
            )}
          >
            {result.success ? tStep('success_title') : tStep('failed_title')}
          </h2>
          {!result.success && (
            <p className="mt-1 text-[13px] text-muted-foreground">
              {tStep('failed_description')}
            </p>
          )}
        </div>
      )}

      {/* What the import did, as one definition list. Normal outcomes read
          as plain values; their explanations sit behind the row's "?". */}
      {result.success && (!showReveal || hasOutcomeRows) && (
        <DefList>
          {!showReveal && (
            <>
              <DefRow label={tStep('vouchers_created')} labelWidth={180}>
                {result.journalEntriesCreated}
              </DefRow>
              <DefRow label={t('result_accounts_created')} labelWidth={180}>
                {result.accountsCreated ?? 0}
                {result.accountsRenamed !== undefined && result.accountsRenamed > 0 && (
                  <span className="block text-xs text-muted-foreground">
                    {tStep('accounts_renamed', { count: result.accountsRenamed })}
                  </span>
                )}
              </DefRow>
              <DefRow label={tStep('fiscal_year')} labelWidth={180}>
                {result.fiscalPeriodId ? tStep('fiscal_year_created') : tStep('fiscal_year_existing')}
              </DefRow>
              <DefRow label={tStep('opening_balances')} labelWidth={180}>
                {result.openingBalanceEntryId
                  ? tStep('opening_balances_imported')
                  : result.details?.openingBalanceSkipped === 'prior_activity'
                    ? tStep('opening_balances_derived')
                    : tStep('opening_balances_none')}
                {/* The file's #IB was deliberately not booked: the company
                    already has posted entries, so this year's IB is the prior
                    year's UB. Said here, not as a warning (#2462). */}
                {!result.openingBalanceEntryId && result.details?.openingBalanceSkipped === 'prior_activity' && (
                  <span className="block text-xs text-muted-foreground">
                    {tStep('opening_balances_derived_hint')}
                  </span>
                )}
              </DefRow>
            </>
          )}

          {/* IB resync (prior-year backfill): a normal outcome. */}
          {result.nextPeriodIBResync && (
            <DefRow
              labelWidth={180}
              label={
                <span className="inline-flex items-center gap-2">
                  {t('result_ib_resync_label', { name: result.nextPeriodIBResync.nextPeriodName })}
                  <HelpPopover className="shrink-0">
                    {tStep('ib_resync_help', { name: result.nextPeriodIBResync.nextPeriodName })}
                  </HelpPopover>
                </span>
              }
            >
              {t('result_ib_resync_value')}
            </DefRow>
          )}

          {/* Last year's result moved the way the file's #IB has it: a
              verifikat the import booked, so the row names it. */}
          {resultTransfer && (
            <DefRow
              labelWidth={180}
              label={
                <span className="inline-flex items-center gap-2">
                  {t('result_transfer_label')}
                  <HelpPopover className="shrink-0">
                    {tStep('result_transfer_help', {
                      from: resultTransfer.from,
                      to: resultTransfer.to,
                      date: resultTransfer.date,
                    })}
                  </HelpPopover>
                </span>
              }
            >
              {t('result_transfer_value', {
                amount: formatCurrency(resultTransfer.amount, 'SEK', { minimumFractionDigits: 2 }),
                to: resultTransfer.to,
                voucher: resultTransfer.voucher,
              })}
            </DefRow>
          )}

          {/* Dimensions detected (lossless SIE round-trip, dimensions plan PR5) */}
          {result.dimensionsImported && (
            <DefRow
              labelWidth={180}
              label={
                <span className="inline-flex items-center gap-2">
                  {t('result_dimensions_label')}
                  <HelpPopover className="shrink-0">
                    {tStep('dimensions_help', {
                      lines: result.dimensionsImported.taggedLines,
                      values: result.dimensionsImported.values,
                    })}
                    {result.dimensionsImported.toggleEnabled && (
                      <>
                        {' '}
                        {tStep.rich('dimensions_enabled', {
                          link: (chunks) => (
                            <Link href="/dimensions" className="underline underline-offset-4">
                              {chunks}
                            </Link>
                          ),
                        })}
                      </>
                    )}
                  </HelpPopover>
                </span>
              }
            >
              {t('result_dimensions_value', { count: result.dimensionsImported.taggedLines })}
            </DefRow>
          )}

          {/* Skipped vouchers: the count stays, the breakdown sits behind the "?". */}
          {skipped && skipped.total > 0 && (
            <DefRow
              labelWidth={180}
              label={
                <span className="inline-flex items-center gap-2">
                  {t('result_skipped_label')}
                  <HelpPopover className="shrink-0">
                    <div className="space-y-2">
                      {skipped.empty > 0 && (
                        <p>{tStep.rich('skipped_empty', { count: skipped.empty, b: strong })}</p>
                      )}
                      {skipped.unbalanced > 0 && (
                        <p>{tStep.rich('skipped_unbalanced', { count: skipped.unbalanced, b: strong })}</p>
                      )}
                      {skipped.singleLine > 0 && (
                        <p>{tStep.rich('skipped_single_line', { count: skipped.singleLine, b: strong })}</p>
                      )}
                      {skipped.unmapped > 0 && (
                        <p>{tStep.rich('skipped_unmapped', { count: skipped.unmapped, b: strong })}</p>
                      )}
                    </div>
                  </HelpPopover>
                </span>
              }
            >
              {t('result_skipped_value', { count: skipped.total })}
            </DefRow>
          )}
        </DefList>
      )}

      {/* Deviations: one line each, the explanation behind the "?". */}

      {/* A year missing between the imported ones: say so here, where the next file is one click away. */}
      {result.success && <FiscalYearGapNotice />}

      {/* The year opened on the carried-forward balance, which differs from the file's #IB (crm#1099) */}
      {result.success && ibDifferences.length > 0 && (
        <div className="space-y-3">
          <AttnLine
            trailing={
              <HelpPopover className="ml-2 inline-flex align-middle">
                <div className="space-y-2">
                  <p>{t(ibFileOff ? 'ib_file_off_result_body' : 'ib_differs_result_body', { count: ibDifferences.length })}</p>
                  <p>{t(ibFileOff ? 'ib_file_off_advice' : 'ib_continuity_advice')}</p>
                </div>
              </HelpPopover>
            }
          >
            {t(ibFileOff ? 'ib_file_off_result_title' : 'ib_differs_result_title')}
          </AttnLine>
          <OpeningBalanceDifferencesTable
            rows={ibDifferences.map((row) => ({
              account: row.account,
              left: row.file,
              right: row.books,
              difference: row.difference,
            }))}
            leftLabel={t('ib_continuity_col_file')}
            rightLabel={t('ib_continuity_col_books')}
          />
        </div>
      )}

      {result.success && result.nextPeriodOpeningBalanceReview && (
        <div role="status">
          <AttnLine action={{ label: t('next_year_review_action'), href: '/settings/fiscal-years' }}>
            {t('next_year_review', { name: result.nextPeriodOpeningBalanceReview.nextPeriodName })}
          </AttnLine>
        </div>
      )}

      {result.success && result.nextPeriodIBResyncSkipped && (
        <AttnLine
          trailing={
            <HelpPopover className="ml-2 inline-flex align-middle">
              {tStep('ib_resync_skipped_help')}
            </HelpPopover>
          }
        >
          {t('result_ib_resync_skipped', { name: result.nextPeriodIBResyncSkipped.nextPeriodName })}
        </AttnLine>
      )}

      {/* Errors: the list stays in view, what to do sits behind the "?". */}
      {hasErrors && (
        <div className="space-y-2">
          <p className="flex items-center gap-2 text-[13px] font-medium text-destructive">
            {tStep('errors', { count: result.errors.length })}
            {!result.success && (
              <HelpPopover className="shrink-0">
                <div className="space-y-1">
                  <p className="font-medium">{tStep('what_to_do')}</p>
                  <ul className="list-disc list-inside space-y-1">
                    <li>{tStep('what_to_do_check_export')}</li>
                    <li>{tStep('what_to_do_export_again')}</li>
                    <li>{tStep('what_to_do_contact_support')}</li>
                  </ul>
                </div>
              </HelpPopover>
            )}
          </p>
          <ul className="max-h-48 space-y-1 overflow-y-auto text-[13px]">
            {result.errors.map((error, i) => (
              <li key={i}>{error}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Untransferred prior-year results: the year-end omföring is missing */}
      {untransferred && untransferred.length > 0 && (
        <div className="space-y-2">
          <AttnLine
            trailing={
              <HelpPopover className="ml-2 inline-flex align-middle">
                {tStep('untransferred_help')}
              </HelpPopover>
            }
          >
            {tStep('untransferred_title')}
          </AttnLine>
          <DefList>
            {untransferred.map((u) => (
              <DefRow key={u.fiscal_period_id} label={u.period_name} labelWidth={180}>
                {formatCurrency(u.pl_net, 'SEK', { minimumFractionDigits: 2 })}
              </DefRow>
            ))}
          </DefList>
        </div>
      )}

      {/* Everything else the import noticed: one sentence, the rest folded. */}
      <ImportNotices notices={notices} />

      {/* Next steps: the migrator bridge. Not instructions to read, an action
          to take: fetch the bank history so it can be matched against the
          verifikat that were just imported, instead of landing as anonymous
          "Att bokföra" rows. Why and how far back sit behind the "?". */}
      {result.success && !showReveal && (
        <div className="space-y-3 border-t-hairline pt-4">
          <p className="flex items-center gap-2 text-[13px] font-medium">
            {t('next_steps_title')}
            <HelpPopover className="shrink-0">
              <div className="space-y-2">
                <p>{t('next_steps_match_copy')}</p>
                <p>{t('next_steps_window_hint')}</p>
              </div>
            </HelpPopover>
          </p>
          <div className="flex flex-wrap items-center gap-3">
            {/* Sandbox hides only the live bank connection; file-based
                import works there and its CTA stays. */}
            {!isSandbox && hasBanking && (
              <Button asChild>
                <Link href="/import?mode=psd2">{t('next_steps_cta_bank')}</Link>
              </Button>
            )}
            <Button
              asChild
              variant={!isSandbox && hasBanking ? 'outline' : 'default'}
            >
              <Link href="/import?mode=bank">{t('next_steps_cta_csv')}</Link>
            </Button>
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:flex-wrap sm:justify-between">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button variant="outline" onClick={onNewImport}>
            <ArrowUturnLeftIcon className="h-4 w-4" />
            {tStep('new_import')}
          </Button>
          {result.success && result.importId && onUndo && (
            <Button variant="outline" className="text-destructive hover:text-destructive" onClick={handleUndoClick}>
              <ArrowUturnLeftIcon className="h-4 w-4" />
              {tStep('undo_import')}
            </Button>
          )}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          {result.success && (
            <>
              <Button variant="outline" asChild>
                <Link href="/bookkeeping">
                  {tStep('view_bookkeeping')}
                  <ArrowTopRightOnSquareIcon className="ml-2 h-4 w-4" />
                </Link>
              </Button>
              <Button asChild>
                <Link href="/reports">
                  {tStep('view_reports')}
                  <ArrowTopRightOnSquareIcon className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </>
          )}
        </div>
      </div>

      <DestructiveConfirmDialog {...dialogProps} />
    </div>
  )
}
