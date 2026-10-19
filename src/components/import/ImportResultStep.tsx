'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { AttnLine } from '@/components/ui/attn-line'
import { HelpPopover } from '@/components/ui/help-popover'
import { DefList, DefRow } from '@/components/arkiv/DefList'
import { ExternalLink, RotateCcw, Undo2 } from 'lucide-react'
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
  // Outcome rows that show beside the reveal too (the reveal carries the counts).
  const hasOutcomeRows =
    !!result.nextPeriodIBResync || !!result.dimensionsImported || (!!skipped && skipped.total > 0)

  // The skipped-voucher, untransferred-result, IB-difference and IB-resync
  // rows and lines below render those facts with their own explanations, so their
  // notice codes are excluded here by code, never by matching Swedish sentences.
  const notices = resolveNotices(result, [
    'sie_vouchers_skipped',
    'sie_untransferred_result',
    'sie_ib_differs_from_file',
    'sie_next_ib_resynced',
    'sie_next_period_locked',
  ])

  return (
    <div className="space-y-6">
      {/* "Din historia" reveal (theater ran) or the plain success/failure header */}
      {showReveal && theaterModel && preview ? (
        <Card>
          <CardContent className="pt-6">
            <div className="grid items-center gap-6 md:grid-cols-[minmax(280px,380px)_1fr]">
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  {t('reveal_eyebrow')}
                </p>
                <h2 className="mt-2 font-display text-2xl leading-8 tracking-tight text-balance">
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
                <div className="mt-6 border-t border-border pt-4">
                  {/* Sandbox strips live bank connections from /import, so the
                      bridge quiets down to the plain way onward there. */}
                  {!isSandbox && <p className="font-display text-base">{t('reveal_bridge')}</p>}
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    {/* Both migrator paths: PSD2 covers recent history (banks
                        cap the window around 90 days), CSV upload reaches the
                        older period the SIE file covers. Either way the
                        overlap is matched against the imported verifikat.
                        Sandbox hides only the live bank connection; file-based
                        import works there and its CTA stays. */}
                    {!isSandbox && hasBanking && (
                      <Button asChild size="sm">
                        <Link href="/import?mode=psd2">{t('reveal_cta_bank')}</Link>
                      </Button>
                    )}
                    <Button
                      asChild
                      size="sm"
                      variant={!isSandbox && hasBanking ? 'outline' : 'default'}
                    >
                      <Link href="/import?mode=bank">{t('reveal_cta_csv')}</Link>
                    </Button>
                    <Link
                      href="/"
                      className="text-xs text-muted-foreground underline decoration-border underline-offset-4 transition-colors hover:text-foreground"
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
              'font-display text-2xl leading-8 tracking-tight',
              !result.success && 'text-destructive',
            )}
          >
            {result.success ? 'Import genomförd' : 'Import misslyckades'}
          </h2>
          {!result.success && (
            <p className="mt-1 text-[13px] text-muted-foreground">
              Det uppstod fel under importen. Läs felmeddelanden nedan för att förstå vad som gick snett och hur du kan åtgärda det.
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
              <DefRow label="Verifikationer skapade" labelWidth={180}>
                {result.journalEntriesCreated}
              </DefRow>
              <DefRow label={t('result_accounts_created')} labelWidth={180}>
                {result.accountsCreated ?? 0}
                {result.accountsRenamed !== undefined && result.accountsRenamed > 0 && (
                  <span className="block text-[12.5px] text-muted-foreground">
                    {result.accountsRenamed === 1
                      ? '1 konto fick sitt namn från källsystemet'
                      : `${result.accountsRenamed} konton fick sina namn från källsystemet`}
                  </span>
                )}
              </DefRow>
              <DefRow label="Räkenskapsår" labelWidth={180}>
                {result.fiscalPeriodId ? 'Skapat' : 'Befintligt'}
              </DefRow>
              <DefRow label="Ingående balanser" labelWidth={180}>
                {result.openingBalanceEntryId
                  ? 'Importerade'
                  : result.details?.openingBalanceSkipped === 'prior_activity'
                    ? 'Härledda'
                    : 'Inga'}
                {/* The file's #IB was deliberately not booked: the company
                    already has posted entries, so this year's IB is the prior
                    year's UB. Said here, not as a warning (#2462). */}
                {!result.openingBalanceEntryId && result.details?.openingBalanceSkipped === 'prior_activity' && (
                  <span className="block text-[12.5px] text-muted-foreground">
                    Från föregående års utgående balans, eftersom bolaget redan har bokförda verifikationer.
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
                    Eftersom du importerade ett tidigare räkenskapsår uppdaterades ingående balanser för{' '}
                    {result.nextPeriodIBResync.nextPeriodName} automatiskt (gammal IB makulerad, ny IB
                    skapad från utgående balans).
                  </HelpPopover>
                </span>
              }
            >
              {t('result_ib_resync_value')}
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
                    Filen innehöll kostnadsställen/projekt: {result.dimensionsImported.taggedLines}{' '}
                    taggade rader importerades
                    {result.dimensionsImported.values > 0 && (
                      <> och {result.dimensionsImported.values} nya värden lades till i registret</>
                    )}
                    .{' '}
                    {result.dimensionsImported.toggleEnabled && (
                      <>Dimensioner aktiverades automatiskt för företaget: du hittar registret under{' '}
                      <Link href="/dimensions" className="underline underline-offset-4">
                        Kostnadsställen &amp; projekt
                      </Link>
                      .</>
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
                        <p>
                          <span className="font-medium">{skipped.empty} tomma verifikationer.</span>{' '}
                          Platshållare utan bokföringsrader: vanligt i Fortnox och Visma. Påverkar inte din bokföring.
                        </p>
                      )}
                      {skipped.unbalanced > 0 && (
                        <p>
                          <span className="font-medium">{skipped.unbalanced} obalanserade verifikationer.</span>{' '}
                          Debet och kredit stämmer inte överens i källsystemet. Saldon har justerats automatiskt.
                        </p>
                      )}
                      {skipped.singleLine > 0 && (
                        <p>
                          <span className="font-medium">{skipped.singleLine} enradsverifikationer.</span>{' '}
                          Verifikationer med bara en rad (t.ex. periodiseringar). Kräver minst två rader för dubbelbokning.
                        </p>
                      )}
                      {skipped.unmapped > 0 && (
                        <p>
                          <span className="font-medium">{skipped.unmapped} verifikationer med ej kopplade konton.</span>{' '}
                          Innehåller konton som inte kunde kopplas till din kontoplan.
                        </p>
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
                  <p>{t('ib_differs_result_body', { count: ibDifferences.length })}</p>
                  <p>{t('ib_continuity_advice')}</p>
                </div>
              </HelpPopover>
            }
          >
            {t('ib_differs_result_title')}
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
          <AttnLine action={{ label: t('next_year_review_action'), href: '/settings/bookkeeping' }}>
            {t('next_year_review', { name: result.nextPeriodOpeningBalanceReview.nextPeriodName })}
          </AttnLine>
        </div>
      )}

      {result.success && result.nextPeriodIBResyncSkipped && (
        <AttnLine
          trailing={
            <HelpPopover className="ml-2 inline-flex align-middle">
              Nästa räkenskapsår är låst eller stängt. Lås upp perioden och kör importen igen om du
              vill att ingående balanser ska uppdateras automatiskt.
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
            Fel ({result.errors.length})
            {!result.success && (
              <HelpPopover className="shrink-0">
                <div className="space-y-1">
                  <p className="font-medium">Vad kan du göra?</p>
                  <ul className="list-disc list-inside space-y-1">
                    <li>Kontrollera att SIE-filen exporterades korrekt från källsystemet</li>
                    <li>Prova att exportera filen igen och ladda upp på nytt</li>
                    <li>Om felet kvarstår, kontakta support med felmeddelandet ovan</li>
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
                Följande räkenskapsår saknar omföring av årets resultat till eget kapital.
                Senare års balansräkning visar en differens på beloppet tills omföringen
                bokförs (konto 8999 mot eget kapital, t.ex. 2099) i respektive år.
              </HelpPopover>
            }
          >
            Årets resultat är inte omfört
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
        <div className="space-y-3 border-t border-border pt-4">
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
              <Button asChild size="sm">
                <Link href="/import?mode=psd2">{t('next_steps_cta_bank')}</Link>
              </Button>
            )}
            <Button
              asChild
              size="sm"
              variant={!isSandbox && hasBanking ? 'outline' : 'default'}
            >
              <Link href="/import?mode=bank">{t('next_steps_cta_csv')}</Link>
            </Button>
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button variant="outline" onClick={onNewImport}>
            <RotateCcw className="mr-2 h-4 w-4" />
            Ny import
          </Button>
          {result.success && result.importId && onUndo && (
            <Button variant="outline" className="text-destructive hover:text-destructive" onClick={handleUndoClick}>
              <Undo2 className="mr-2 h-4 w-4" />
              Ångra import
            </Button>
          )}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          {result.success && (
            <>
              <Button variant="outline" asChild>
                <Link href="/bookkeeping">
                  Visa bokföring
                  <ExternalLink className="ml-2 h-4 w-4" />
                </Link>
              </Button>
              <Button asChild>
                <Link href="/reports">
                  Visa rapporter
                  <ExternalLink className="ml-2 h-4 w-4" />
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
