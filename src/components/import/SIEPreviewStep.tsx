'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { AttnLine } from '@/components/ui/attn-line'
import { DefList, DefRow } from '@/components/arkiv/DefList'
import { formatCurrency } from '@/lib/utils'
import { ArrowRight } from 'lucide-react'
import type { ImportPreview, ParseIssue } from '@/lib/import/types'
import { HelpPopover } from '@/components/ui/help-popover'
import { OpeningBalanceDifferencesTable } from '@/components/import/OpeningBalanceDifferencesTable'

interface SIEPreviewStepProps {
  preview: ImportPreview
  issues: ParseIssue[]
  missingAccounts: { number: string; name: string }[]
  onCreateAccounts: () => Promise<void>
  isCreatingAccounts: boolean
  onContinue: () => void
  onBack: () => void
  /**
   * Opens the manual "Ingående balanser" wizard (issue #2082). Offered next to
   * the IB-imbalance acknowledgement so a user who rightly hesitates to book an
   * unexplained amount to 2099 has somewhere to go other than support.
   */
  onOpenManualOpeningBalances?: () => void
  /**
   * The "only the accounts the file uses" switch (#63): shown when the file
   * defines BAS accounts it never uses. `total` counts the file's mapped
   * definitions, `unused` the unused BAS ones the switch leaves out of the
   * chart, `own` the unused ones outside BAS that it keeps.
   */
  onlyUsedAccounts?: { on: boolean; onChange: (on: boolean) => void; unused: number; own: number; total: number }
}

export default function SIEPreviewStep({
  preview,
  issues,
  missingAccounts,
  onCreateAccounts,
  isCreatingAccounts,
  onContinue,
  onBack,
  onOpenManualOpeningBalances,
  onlyUsedAccounts,
}: SIEPreviewStepProps) {
  const t = useTranslations('import')
  const tNotice = useTranslations('import_notices')
  const errors = issues.filter((i) => i.severity === 'error')
  const warnings = issues.filter((i) => i.severity === 'warning')

  // Both blocks are optional: a preview built by an older parse response
  // lacks them, and the card then falls back to the BAS-reference counts.
  const chart = preview.chart
  const fiscalYear = preview.fiscalYear
  // Both refusals carry the import's own text: an overlap with a period that
  // has content, or #RAR dates that break a BFL 3 kap. shape rule.
  const fiscalYearRefused =
    fiscalYear?.verdict === 'conflict' || fiscalYear?.verdict === 'invalid'

  // Opening-balance imbalance. The importer plugs any diff > 0.01 to 2099, but a
  // diff under ~1 SEK is genuine öresavrundning. Anything larger is a real
  // imbalance (incomplete export: missing liabilities / unappropriated prior-year
  // result) that would silently book a bogus amount to 2099. Mirrors the importer's
  // own `fileImbalance > 1.00` "serious" threshold (lib/import/sie-import.ts).
  const ibDiff = Math.round((preview.trialBalance.totalDebit - preview.trialBalance.totalCredit) * 100) / 100
  const [ackImbalance, setAckImbalance] = useState(false)

  // crm#1099: a year imported on top of earlier bookkeeping opens on the
  // carried-forward balance and never books the file's #IB, so the 2099 plug
  // above does not happen, and where the two disagree the user sees the
  // amounts and acknowledges them before continuing.
  const continuity = preview.openingBalanceContinuity
  const ibCarriedForward = continuity?.carriedForward === true
  const ibDiffers = ibCarriedForward && continuity.differences.length > 0
  const sourceEdits = !ibCarriedForward ? (continuity?.sourceEdits ?? []) : []
  const showContinuity =
    !!continuity && (ibDiffers || sourceEdits.length > 0 || continuity.missingYears.length > 0 || continuity.noVouchers)
  const [ackContinuity, setAckContinuity] = useState(false)
  const significantImbalance = !preview.trialBalance.isBalanced && Math.abs(ibDiff) > 1 && !ibCarriedForward

  // Only block on actual parsing errors, not unmapped accounts
  // (users need to proceed to mapping step to fix unmapped accounts).
  // A significant IB imbalance and an IB that differs from the books are
  // soft blocks: the user must acknowledge them.
  const hasBlockingErrors = errors.length > 0
  const blockContinue =
    hasBlockingErrors || (significantImbalance && !ackImbalance) || (ibDiffers && !ackContinuity)

  const unknown = t('sie_preview_unknown')
  const mapping = preview.mappingStatus
  const ibHelp = (
    <>
      <p>
        {t('sie_preview_ib_totals', {
          debit: formatCurrency(preview.trialBalance.totalDebit),
          credit: formatCurrency(preview.trialBalance.totalCredit),
        })}
      </p>
      <p className="mt-2">Summan av alla debetsaldon i ingående balans, inte ett enskilt kontosaldo.</p>
    </>
  )
  // What the chart row folds away: the full sentence, the accounts that are
  // added, and the source accounts the import leaves out.
  const chartHelp = (
    <div className="space-y-2">
      <p>
        {chart
          ? t('chart_summary', { toCreate: chart.toCreate, existing: chart.existing })
          : 'Hur väl kunde kontona i filen matchas mot din kontoplan'}
      </p>
      {chart && chart.sample.length > 0 && (
        <div className="space-y-1">
          {chart.sample.map((acc) => (
            <div key={acc.number} className="flex gap-2 text-muted-foreground">
              <span className="font-mono">{acc.number}</span>
              <span>{acc.name}</span>
            </div>
          ))}
          {chart.toCreate > chart.sample.length && (
            <div className="text-muted-foreground">
              {t('chart_sample_more', { count: chart.toCreate - chart.sample.length })}
            </div>
          )}
        </div>
      )}
      {preview.excludedSystemAccounts.length > 0 && (
        <p>
          {preview.excludedSystemAccounts.length} internt systemkonto från källsystemet exkluderades ({preview.excludedSystemAccounts.map((a) => a.number).join(', ')}), inte bokföringskonton
        </p>
      )}
      {Boolean(preview.archivedOnlyAccounts?.length) && (
        <p data-ph-mask>
          {t('archived_only_accounts', { accounts: preview.archivedOnlyAccounts!.map(account => account.number).join(', ') })}
        </p>
      )}
    </div>
  )

  return (
    <div className="space-y-6">
      {/* What the file holds as one definition list: normal states read as
          plain values; only the deviations below get a line of their own. */}
      <DefList>
        <DefRow label={t('sie_preview_company')} labelWidth={180}>
          {preview.companyName || t('sie_preview_not_set')}
        </DefRow>
        <DefRow label={t('sie_preview_org_number')} labelWidth={180}>
          {preview.orgNumber || t('sie_preview_not_set')}
        </DefRow>
        <DefRow label={t('sie_preview_fiscal_year')} labelWidth={180}>
          {t('sie_preview_range', {
            start: preview.fiscalYearStart ?? unknown,
            end: preview.fiscalYearEnd ?? unknown,
          })}
          {fiscalYear && (fiscalYear.verdict === 'match' || fiscalYear.verdict === 'create') && (
            <span className="block text-[12.5px] text-muted-foreground">
              {fiscalYear.verdict === 'match'
                ? t('fiscal_year_match')
                : fiscalYear.replacesEmptyPeriodId
                  ? t('fiscal_year_create_replaces')
                  : t('fiscal_year_create')}
            </span>
          )}
          {fiscalYearRefused && (
            <span className="block text-[12.5px] text-destructive">{fiscalYear.message}</span>
          )}
        </DefRow>
        <DefRow label={t('sie_preview_contents_label')} labelWidth={180}>
          {t('sie_preview_contents', {
            accounts: preview.accountCount,
            vouchers: preview.voucherCount,
            lines: preview.transactionLineCount,
          })}
        </DefRow>
        <DefRow
          label={
            <span className="inline-flex items-center gap-2">
              {t('sie_preview_ib_label')}
              <HelpPopover className="shrink-0">{ibHelp}</HelpPopover>
            </span>
          }
          labelWidth={180}
        >
          {preview.trialBalance.isBalanced ? (
            t('sie_preview_ib_balanced', { amount: formatCurrency(preview.trialBalance.totalDebit) })
          ) : (
            <span className={significantImbalance ? 'text-attn' : undefined}>
              {t('sie_preview_ib_diff', { amount: formatCurrency(ibDiff) })}
            </span>
          )}
        </DefRow>
        <DefRow
          label={
            <span className="inline-flex items-center gap-2">
              {t('chart_card_title')}
              <HelpPopover className="shrink-0">{chartHelp}</HelpPopover>
            </span>
          }
          labelWidth={180}
        >
          {chart
            ? t('sie_preview_chart_value', { toCreate: chart.toCreate, existing: chart.existing })
            : t('sie_preview_mapping_value', { mapped: mapping.mapped, total: mapping.total })}
          {mapping.unmapped > 0 && (
            <span className="text-destructive"> · {t('sie_preview_unmapped', { count: mapping.unmapped })}</span>
          )}
          {mapping.lowConfidence > 0 && (
            <span className="text-attn"> · {t('sie_preview_low_confidence', { count: mapping.lowConfidence })}</span>
          )}
        </DefRow>
      </DefList>

      {/* Another organisation's file is said on the first screen after the
          upload, not first at the review step after every account and VAT
          code is mapped (PH 193). The confirmation stays at review. */}
      {preview.orgNumberMismatch === true && (
        <AttnLine>
          {tNotice('sie_org_mismatch', {
            fileOrg: preview.orgNumber ?? '?',
            companyOrg: preview.companyOrgNumber ?? '?',
          })}
        </AttnLine>
      )}

      {/* #63: a provider's export carries its whole chart in #KONTO. */}
      {onlyUsedAccounts && onlyUsedAccounts.unused > 0 && (
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-0.5">
            <Label htmlFor="sie-only-used-accounts" className="font-medium">
              {t('only_used_accounts_label')}
            </Label>
            <p className="text-[13px] text-muted-foreground">
              {t('only_used_accounts_hint', {
                used: onlyUsedAccounts.total - onlyUsedAccounts.unused - onlyUsedAccounts.own,
                total: onlyUsedAccounts.total,
                unused: onlyUsedAccounts.unused,
              })}
            </p>
          </div>
          <Switch
            id="sie-only-used-accounts"
            checked={onlyUsedAccounts.on}
            onCheckedChange={onlyUsedAccounts.onChange}
          />
        </div>
      )}

      {/* Parsing errors block the import: the list stays in view. */}
      {errors.length > 0 && (
        <div className="space-y-2">
          <p className="flex items-center gap-2 text-[13px] font-medium text-destructive">
            Tolkningsfel ({errors.length})
            <HelpPopover className="shrink-0">
              Dessa fel hittades under tolkningen av SIE-filen och kan påverka importresultatet.
            </HelpPopover>
          </p>
          <ul className="max-h-48 space-y-1 overflow-y-auto text-[13px] text-destructive">
            {errors.map((issue, i) => (
              <li key={`error-${i}`}>
                <span className="font-mono text-[11px] opacity-70">Rad {issue.line}</span>{' '}
                {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Significant imbalance: one sentence, the explanation behind the "?",
          and the acknowledgement before continuing. */}
      {significantImbalance && (
        <div className="space-y-3">
          <AttnLine
            trailing={
              <HelpPopover className="ml-2 inline-flex align-middle">
                <div className="space-y-2">
                  <p>
                    Vanligaste orsaken är att föregående års resultat aldrig fördes över till
                    eget kapital i det gamla programmet. SpeedLedger parkerar det till exempel på
                    egna 9xxx-konton (9030/9031 Obokat resultat), och då summerar inte filens
                    ingående balanser till noll: differensen är det oförda resultatet. En annan
                    orsak är en ofullständig export, till exempel att skulder saknas.
                  </p>
                  <p>
                    Rätta i källsystemet och ladda upp filen på nytt, eller lägg in de ingående
                    balanserna för hand i guiden Ingående balanser, där du kan rätta raderna
                    själv innan de bokförs (den här filen importeras då inte). Fortsätter du ändå
                    bokförs differensen på konto 2099 (Årets resultat), vilket nästan alltid blir
                    fel.
                  </p>
                </div>
              </HelpPopover>
            }
          >
            Ingående balanser balanserar inte ({formatCurrency(Math.abs(ibDiff))})
          </AttnLine>
          {onOpenManualOpeningBalances && (
            <Button type="button" variant="outline" size="sm" onClick={onOpenManualOpeningBalances}>
              Lägg in ingående balanser för hand
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          )}
          <label className="flex items-start gap-2 text-[13px] cursor-pointer">
            <Checkbox
              checked={ackImbalance}
              onCheckedChange={(v) => setAckImbalance(v === true)}
              className="mt-0.5"
            />
            <span className="text-muted-foreground">
              Jag förstår att differensen bokförs på 2099 och vill fortsätta ändå.
            </span>
          </label>
        </div>
      )}

      {/* Opening balance against the books and the years next to the file (crm#1099) */}
      {showContinuity && continuity && (
        <div className="space-y-3 text-[13px] leading-5">
          <AttnLine
            trailing={
              ibDiffers ? (
                <HelpPopover className="ml-2 inline-flex align-middle">
                  {t(continuity.bookedOpeningBalance ? 'ib_continuity_booked_advice' : 'ib_continuity_advice')}
                </HelpPopover>
              ) : undefined
            }
          >
            {t('ib_continuity_title')}
          </AttnLine>
          {continuity.missingYears.map((gap) => (
            <p key={`${gap.from}-${gap.to}`} className="tabular-nums">
              {t('ib_continuity_missing_years', { from: gap.from, to: gap.to })}
            </p>
          ))}
          {continuity.noVouchers && <p>{t('ib_continuity_no_vouchers')}</p>}
          {ibDiffers && (
            <>
              {/* crm#1272: a year with its own IB verifikat opens on it. */}
              <p>
                {continuity.bookedOpeningBalance
                  ? t('ib_continuity_booked', {
                      count: continuity.differences.length,
                      voucher: continuity.bookedOpeningBalance.voucher,
                    })
                  : t('ib_continuity_carried', { count: continuity.differences.length })}
              </p>
              <OpeningBalanceDifferencesTable
                rows={continuity.differences.map((row) => ({
                  account: row.account,
                  left: row.file,
                  right: row.books,
                  difference: row.difference,
                }))}
                leftLabel={t('ib_continuity_col_file')}
                rightLabel={t('ib_continuity_col_books')}
              />
              <label className="flex items-start gap-2 cursor-pointer">
                <Checkbox
                  checked={ackContinuity}
                  onCheckedChange={(v) => setAckContinuity(v === true)}
                  className="mt-0.5"
                />
                <span className="text-muted-foreground">{t('ib_continuity_ack')}</span>
              </label>
            </>
          )}
          {sourceEdits.length > 0 && (
            <>
              <p>{t('ib_continuity_source_edits', { count: sourceEdits.length })}</p>
              <OpeningBalanceDifferencesTable
                rows={sourceEdits.map((edit) => ({
                  account: edit.account,
                  left: edit.previousClosing,
                  right: edit.opening,
                  difference: edit.difference,
                }))}
                leftLabel={t('ib_continuity_col_previous_closing')}
                rightLabel={t('ib_continuity_col_opening')}
              />
            </>
          )}
        </div>
      )}

      {/* Accounts the chart lacks: one line with the action, the list behind the "?". */}
      {missingAccounts.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <AttnLine
            trailing={
              <HelpPopover className="ml-2 inline-flex align-middle">
                <div className="space-y-2">
                  <p>{t('sie_preview_missing_accounts_help')}</p>
                  <div className="max-h-32 space-y-1 overflow-y-auto">
                    {missingAccounts.slice(0, 10).map((acc) => (
                      <div key={acc.number} className="flex gap-2 text-muted-foreground">
                        <span className="font-mono">{acc.number}</span>
                        <span>{acc.name}</span>
                      </div>
                    ))}
                    {missingAccounts.length > 10 && (
                      <div className="text-muted-foreground">
                        ... och {missingAccounts.length - 10} till
                      </div>
                    )}
                  </div>
                </div>
              </HelpPopover>
            }
          >
            {t('sie_preview_missing_accounts', { count: missingAccounts.length })}
          </AttnLine>
          <Button size="sm" onClick={onCreateAccounts} loading={isCreatingAccounts}>
            {isCreatingAccounts ? <>Skapar konton...</> : <>Skapa {missingAccounts.length} konton</>}
          </Button>
        </div>
      )}

      {/* Warnings do not block the import: the list stays, the note goes behind the "?". */}
      {warnings.length > 0 && (
        <div className="space-y-2">
          <p className="flex items-center gap-2 text-[13px] font-medium text-attn">
            Varningar ({warnings.length})
            <HelpPopover className="shrink-0">
              Dessa varningar blockerar inte importen men bör granskas.
            </HelpPopover>
          </p>
          <ul className="max-h-48 space-y-1 overflow-y-auto text-[13px] text-muted-foreground">
            {warnings.map((issue, i) => (
              <li key={`warning-${i}`}>
                <span className="font-mono text-[11px] opacity-70">Rad {issue.line}</span>{' '}
                {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
        <Button variant="outline" onClick={onBack}>
          Tillbaka
        </Button>
        <Button onClick={onContinue} disabled={blockContinue}>
          {preview.mappingStatus.lowConfidence > 0 || preview.mappingStatus.unmapped > 0
            ? 'Granska mappningar'
            : 'Fortsätt'}
          <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
