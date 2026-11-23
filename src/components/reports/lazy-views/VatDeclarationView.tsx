'use client'

import React, { useState, useEffect } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useTranslations, useLocale } from 'next-intl'
import {
  CheckIcon,
  ChevronDownIcon,
  CodeBracketSquareIcon,
  DocumentArrowDownIcon,
  ExclamationCircleIcon,
  PercentBadgeIcon,
} from '@/components/icons'
import { useFiscalPeriods } from '@/lib/reference-data/hooks'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { ToastAction } from '@/components/ui/toast'
import { useToast } from '@/components/ui/use-toast'
import { Skeleton, LateReveal } from '@/components/ui/skeleton'
import { EmptyState, LoadError } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/ui/page-header'
import { StepBar } from '@/components/ui/step-bar'
import { Table, TableBody } from '@/components/ui/table'
import { Dialog, DialogContent, DialogHeader, DialogTitle, holdEscapeWhileUnsaved, useEditedSinceOpen } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { HelpPopover } from '@/components/ui/help-popover'
import { FyPicker } from '@/components/common/FyPicker'
import { ContextPicker } from '@/components/common/ContextPicker'
import { ReportBodyLoading } from '@/components/reports/ReportLoading'
import { ReportExportMenu } from '@/components/reports/ReportExportMenu'
import { useReportRowExpansion } from '@/components/reports/ReportRowExpansion'
import { VatFilingStatusCard } from '@/components/reports/VatFilingStatusCard'
import { VatFiledChangesLine } from '@/components/reports/VatFiledChangesLine'
import { PayDeclarationViaBankButton } from '@/components/payments/PayDeclarationViaBankButton'
import { VatChecksCard } from '@/components/reports/VatChecksCard'
import { SKATTEVERKET_DIRECT_FILING, SkatteverketPanel } from '@/components/reports/SkatteverketPanel'
import { useVatSettlementProposal } from '@/components/reports/use-vat-settlement-proposal'
import { useCompanySettings } from '@/components/settings/useSettings'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { mostRecentEndedVatPeriod } from '@/lib/vat/period-defaults'
import { vatLandingStep } from '@/lib/vat/landing-step'
import { partlySettledRestBooksAlone } from '@/lib/vat/partly-settled-rest'
import { postedVatSettlements } from '@/lib/reports/vat-settlement'
import { resolveInitialVatPeriodSelection } from '@/lib/vat/period-selection'
import { fiscalPeriodForVatYear } from '@/lib/reports/period-dates'
import { fiscalYearEndMonthIn, fiscalYearEndMonthOn } from '@/lib/tax/deadline-config'
import {
  indexVatFilings,
  vatFilingKey,
  vatFilingTaxPeriod,
  type VatFilingRecord,
} from '@/lib/vat/filing-record'
import type { VatFilingRecordWithChange } from '@/lib/vat/filed-period-changes'
import { cn, formatAmount, formatDate } from '@/lib/utils'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { runVatDeclarationChecks } from '@/lib/reports/vat-declaration-checks'
import { rcInputTotalsFromDeclaration } from '@/lib/reports/vat-declaration'
import { buildFiledAmounts } from '@/lib/reports/vat-manual-filing'
import {
  isFilingBlocked,
  withRcBasisGapFindings,
  type RcBasisGapScan,
} from '@/lib/reports/vat-filing-gate'
import type { RcBasisGap } from '@/lib/reports/rc-basis-gaps'
import type { MarkedMomsredovisningEntry } from '@/lib/vat/momsredovisning-marks'
import {
  applyVatCheckReviews,
  type VatCheckReview,
  type VatCheckReviewInputs,
} from '@/lib/vat/check-reviews'
import type { FormLine } from '@/components/bookkeeping/JournalEntryForm'
import type {
  VatSettlementDateReason,
  VatSettlementExistingEntry,
  VatSettlementProposal,
} from '@/lib/reports/vat-settlement'
import type { ReportSourceLine, ReportSourceFetcher } from '@/lib/reports/source-lines'
import type { VatDeclaration, VatPeriodType } from '@/types'
import { formatAmountInput } from '@/lib/money'
import { stockholmYearMonth, todayIsoStockholm } from '@/lib/dates/iso'

// The full journal entry editor is heavy (BAS catalogue, comboboxes, review
// dialogs): defer it until the user opens the momsverifikat dialog.
const JournalEntryForm = dynamic(() => import('@/components/bookkeeping/JournalEntryForm'), {
  ssr: false,
  loading: () => <Skeleton className="h-64 w-full" />,
})

// Carries the selected fiscal period into the ruta drill-down rows so their
// source-verifikat query matches the report's period. Only set for yearly
// (räkenskapsår); undefined for monthly/quarterly (calendar periods).
const VatDrillContext = React.createContext<{ fiscalPeriodId?: string }>({})

// Skatteverket's e-service entry point for manually filing the momsdeklaration.
// Manual filing needs no connection, so this link is the default path for
// anyone who hasn't set up (or doesn't want) the direct-submission integration.
const SKATTEVERKET_MOMS_URL =
  'https://www.skatteverket.se/foretag/etjansterochblanketter/etjanster/momsocharbetsgivardeklarationer'

/**
 * "Ladda ner" in the Lämna in row: the filing artifacts for filing by hand.
 * The report is generated purely from the bookkeeping and never depends on
 * the Skatteverket connection, so every user (including core builds with the
 * skatteverket extension disabled) can file manually: the eSKD XML to upload
 * under "Deklarera via fil" (the fast path), or the PDF (in hela kronor) to
 * read off when typing the boxes in. A PDF cannot be uploaded, only the XML.
 */
function VatFilingDownloadMenu({ xmlHref, pdfHref }: { xmlHref: string; pdfHref: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="gap-2">
          <DocumentArrowDownIcon className="h-4 w-4" />
          Ladda ner
          <ChevronDownIcon className="h-4 w-4 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem asChild>
          <a href={xmlHref} target="_blank" rel="noopener noreferrer">
            <CodeBracketSquareIcon className="h-4 w-4" />
            Fil för uppladdning (XML)
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={pdfHref} target="_blank" rel="noopener noreferrer">
            <DocumentArrowDownIcon className="h-4 w-4" />
            Momsdeklaration (PDF)
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The one "?" of the Lämna in step (convention 7): what each action in the
 * row does, including the manual filing steps that used to fill the step
 * as always-visible copy.
 */
function VatFilingHelp({ markPrompt }: { markPrompt: string }) {
  return (
    <HelpPopover>
      <div className="space-y-2">
        {SKATTEVERKET_DIRECT_FILING && (
          <p>
            Skicka till Skatteverket: deklarationen kontrolleras, sparas som utkast i
            Eget utrymme (företagets privata yta hos Skatteverket) och låses för
            signering med BankID. Inget lämnas in förrän du har signerat. Första
            gången ansluter du med BankID.
          </p>
        )}
        <p>Lämna in själv, med fil. Du behöver inte vara ansluten till Skatteverket.</p>
        <ol className="list-decimal space-y-1 pl-4">
          <li>Ladda ner XML-filen under Ladda ner.</li>
          <li>Logga in på skatteverket.se med BankID.</li>
          <li>Öppna Moms- och arbetsgivardeklarationer och välj Deklarera via fil.</li>
          <li>Ladda upp filen, granska och signera.</li>
        </ol>
        <p>
          Vill du hellre fylla i rutorna för hand laddar du ner PDF:en och skriver av
          beloppen (i hela kronor).
        </p>
        <p>{markPrompt}</p>
        <p>
          <a
            href={SKATTEVERKET_MOMS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:opacity-80"
          >
            Öppna skatteverket.se
          </a>
        </p>
      </div>
    </HelpPopover>
  )
}

/** Why the proposal is not dated the period's last day (statutory surface, Swedish in both locales). */
const SETTLEMENT_DATE_REASON: Record<VatSettlementDateReason, string> = {
  period_closed: 'Räkenskapsåret som periodens sista dag hör till är stängt.',
  period_locked: 'Perioden som periodens sista dag hör till är låst.',
  company_lock_date: 'Bokföringen är låst till och med periodens sista dag.',
}

/**
 * The period's posted momsredovisningar as links, "A2 (2026-09-30) och A4
 * (2026-09-30)", joined the locale's way.
 */
function VoucherLinks({ entries, locale }: { entries: VatSettlementExistingEntry[]; locale: ErrorLocale }) {
  const parts = new Intl.ListFormat(locale, { type: 'conjunction' }).formatToParts(entries.map((_, i) => String(i)))
  return (
    <>
      {parts.map((part, i) => {
        const entry = part.type === 'element' ? entries[Number(part.value)] : undefined
        return entry ? (
          <Link key={i} href={`/bookkeeping/${entry.id}`} className="underline underline-offset-2 hover:text-foreground">
            {formatVoucher(entry)} ({formatDate(entry.entry_date)})
          </Link>
        ) : (
          <React.Fragment key={i}>{part.value}</React.Fragment>
        )
      })}
    </>
  )
}

/**
 * "Bokför momsrapport" (issue #980): builds an editable verifikat proposal
 * from the momsrapport (clearing the period's 26xx accounts to 2650/1650,
 * öre gap on 3740) and books it through the ordinary journal entry form, so
 * every line can be adjusted before committing. The proposal comes from
 * /api/reports/vat-declaration/settlement-proposal; booking goes through
 * POST /api/bookkeeping/journal-entries with source_type 'vat_settlement',
 * which the declaration projection excludes, so the report above keeps
 * showing the declared figures after booking.
 */
function VatBookingCard({
  checksBlocked,
  proposal,
  failed,
  upToDate,
  booked,
  draft,
  onRetry,
  onMarkChanged,
  periodQuery,
  fiscalPeriodId,
}: {
  /**
   * True when the local pre-flight checks found ERRORs. Booking stays
   * possible (the RC-basis fixes only touch 44xx/45xx pairs, never the 26xx
   * accounts the settlement clears), but the user should know before filing.
   */
  checksBlocked?: boolean
  /** Settlement proposal loaded by the parent so Granska can reuse it. */
  proposal: VatSettlementProposal | null
  failed: boolean
  upToDate: boolean
  booked?: VatSettlementExistingEntry
  draft?: VatSettlementExistingEntry
  onRetry: () => void
  /**
   * A verifikat was marked as a correction, or the mark undone (crm#1849):
   * the declaration and the proposal both read it differently now.
   */
  onMarkChanged: () => void
  /** The period as a query string (period_type, year, period[, fiscal_period_id]); '' while unknown. */
  periodQuery: string
  /** Helårsmoms: the räkenskapsår the proposal was built for. */
  fiscalPeriodId?: string
}) {
  const { canWrite } = useCanWrite()
  const t = useTranslations('reports')
  const errorLocale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [markOpen, setMarkOpen] = useState(false)
  // Only a verifikat the shapes caught in the period can be a correction: the
  // app's own momsredovisning (source_type vat_settlement) is annulled
  // instead, and one dated later that clears exactly this period's balances
  // (late_settlement) is the momsredovisning by its amounts.
  const markable =
    booked && booked.source_type !== 'vat_settlement' && !booked.late_settlement ? booked : undefined
  // The period's verifikat marked as no momsredovisning, so the mark stays
  // visible and can be undone after the toast has gone.
  const [marked, setMarked] = useState<MarkedMomsredovisningEntry[]>([])
  const [marksKey, setMarksKey] = useState(0)
  useEffect(() => {
    if (!periodQuery) return
    let cancelled = false
    fetch(`/api/reports/vat-declaration/not-momsredovisning?${periodQuery}`)
      .then(async (res) => {
        const json = await res.json().catch(() => null)
        if (!cancelled && res.ok && Array.isArray(json?.data)) setMarked(json.data as MarkedMomsredovisningEntry[])
      })
      .catch(() => {
        // Safe to ignore: the list only offers Ångra for marks already made.
        // A failed read leaves it as it was; the figure above still reads
        // every mark, and the next mark or period change reads it again.
      })
    return () => {
      cancelled = true
    }
  }, [periodQuery, marksKey])

  const undoMark = async (entryId: string) => {
    try {
      const res = await fetch(
        `/api/reports/vat-declaration/not-momsredovisning?journal_entry_id=${encodeURIComponent(entryId)}`,
        { method: 'DELETE' },
      )
      const json = await res.json().catch(() => null)
      if (!res.ok || json?.error) {
        toast({
          title: t('vat_not_settlement_undo_failed'),
          description: getErrorMessage(json, { locale: errorLocale, fallback: t('vat_not_settlement_undo_failed') }),
          variant: 'destructive',
        })
        return
      }
      toast({ title: t('vat_not_settlement_undone') })
      setMarksKey((k) => k + 1)
      onMarkChanged()
    } catch {
      toast({ title: t('vat_not_settlement_undo_failed'), variant: 'destructive' })
    }
  }

  const markNotSettlement = async () => {
    if (!markable) return
    const voucher = formatVoucher(markable)
    try {
      const res = await fetch('/api/reports/vat-declaration/not-momsredovisning', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ journal_entry_id: markable.id }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok || json?.error) {
        toast({
          title: t('vat_not_settlement_failed'),
          description: getErrorMessage(json, { locale: errorLocale, fallback: t('vat_not_settlement_failed') }),
          variant: 'destructive',
        })
        return
      }
      setMarkOpen(false)
      toast({
        title: t('vat_not_settlement_done', { voucher }),
        action: (
          <ToastAction altText={t('vat_not_settlement_undo')} onClick={() => void undoMark(markable.id)}>
            {t('vat_not_settlement_undo')}
          </ToastAction>
        ),
      })
      setMarksKey((k) => k + 1)
      onMarkChanged()
    } catch {
      toast({ title: t('vat_not_settlement_failed'), variant: 'destructive' })
    }
  }
  const { edited, editProps } = useEditedSinceOpen()
  // Every posted momsredovisning of the period gates booking it again, so the
  // advice to reverse names all of them, not only the first (#3646).
  const posted = postedVatSettlements(proposal?.existing_entries)
  const postedVouchers = new Intl.ListFormat(errorLocale, { type: 'conjunction' }).format(posted.map((entry) => formatVoucher(entry)))

  // FormLine amounts are input strings; the proposal's numbers are already
  // öre-rounded server-side.
  const initialLines: FormLine[] = (proposal?.lines ?? []).map((l) => ({
    account_number: l.account_number,
    debit_amount: l.debit_amount > 0 ? formatAmountInput(l.debit_amount, '.') : '',
    credit_amount: l.credit_amount > 0 ? formatAmountInput(l.credit_amount, '.') : '',
    line_description: l.line_description ?? '',
  }))

  return (
    <div className="space-y-4">
        <p className="text-[13px] leading-6 text-muted-foreground">
          Skapa ett verifikat som nollställer periodens momskonton och bokför
          momsen att betala eller få tillbaka på redovisningskontot. Du granskar
          förslaget och kan ändra raderna innan verifikatet bokförs.
        </p>

        {booked && proposal?.partly_settled && (
          // The posted momsredovisning no longer clears the period (a
          // verifikat added to it afterwards, a credit note after it, or a
          // settlement that came with an import): the proposal's lines are
          // what is left. "Already
          // booked" alone hid that the momskonton are not at zero and that
          // 2650/1650 no longer matches ruta 49 (#3570).
          <div className="flex items-start gap-2 text-[13px] leading-6 text-attn">
            <ExclamationCircleIcon className="mt-1 h-4 w-4 shrink-0" aria-hidden="true" />
            <div className="space-y-1">
              <p>
                {t.rich('vat_partly_settled_intro', {
                  count: posted.length,
                  vouchers: () => <VoucherLinks entries={posted} locale={errorLocale} />,
                })}
              </p>
              <ul className="tabular-nums">
                {proposal.lines.map((line, i) => (
                  <li key={i}>
                    {t('vat_partly_settled_line', {
                      account: line.account_number,
                      side: line.debit_amount > 0 ? 'debit' : 'credit',
                      amount: formatAmount(line.debit_amount > 0 ? line.debit_amount : line.credit_amount),
                    })}
                  </li>
                ))}
              </ul>
              <p>
                {partlySettledRestBooksAlone(proposal)
                  ? t('vat_partly_settled_ways', {
                      count: posted.length,
                      vouchers: postedVouchers,
                      date: formatDate(proposal.entry_date),
                    })
                  : t('vat_partly_settled_rebook', { count: posted.length, vouchers: postedVouchers })}
              </p>
            </div>
          </div>
        )}
        {booked && !proposal?.partly_settled && (
          <div className="flex items-start gap-2 text-[13px] leading-6 text-muted-foreground">
            <ExclamationCircleIcon className="mt-1 h-4 w-4 shrink-0" aria-hidden="true" />
            <p>
              {t.rich('vat_already_booked', {
                count: posted.length,
                vouchers: () => <VoucherLinks entries={posted} locale={errorLocale} />,
              })}
            </p>
          </div>
        )}
        {markable && canWrite && (
          <div className="pl-6">
            <Button variant="link" onClick={() => setMarkOpen(true)}>
              {t('vat_not_settlement_action', { voucher: formatVoucher(markable) })}
            </Button>
            <ConfirmDialog
              open={markOpen}
              onOpenChange={setMarkOpen}
              title={t('vat_not_settlement_title', { voucher: formatVoucher(markable) })}
              description={t('vat_not_settlement_body', { voucher: formatVoucher(markable) })}
              confirmLabel={t('vat_not_settlement_confirm')}
              cancelLabel={t('vat_not_settlement_cancel')}
              onConfirm={markNotSettlement}
            />
          </div>
        )}
        {marked.length > 0 && (
          <div className="space-y-1">
            {marked.map((entry) => (
              <div
                key={entry.journal_entry_id}
                className="flex flex-wrap items-center gap-x-2 text-[13px] leading-6 text-muted-foreground"
              >
                <span>{t('vat_not_settlement_marked', { voucher: formatVoucher(entry) })}</span>
                {canWrite && (
                  <Button variant="link" onClick={() => void undoMark(entry.journal_entry_id)}>
                    {t('vat_not_settlement_undo')}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
        {draft && (
          <div className="flex items-start gap-2 text-[13px] leading-6 text-muted-foreground">
            <ExclamationCircleIcon className="mt-1 h-4 w-4 shrink-0" aria-hidden="true" />
            <p>
              Det finns redan ett{' '}
              <Link
                href={`/bookkeeping/${draft.id}`}
                className="underline underline-offset-2 hover:text-foreground"
              >
                utkast för momsen i perioden
              </Link>
              .
            </p>
          </div>
        )}

        {proposal?.entry_date_reason && !booked && (
          <p className="text-[13px] leading-6 text-muted-foreground">
            {SETTLEMENT_DATE_REASON[proposal.entry_date_reason]} Förslaget dateras
            därför {formatDate(proposal.entry_date)}, första dagen som går att bokföra.
          </p>
        )}

        {checksBlocked && (
          <p className="text-xs leading-5 text-attn">
            Det finns fel under steg 1, Kontrollera. Du kan bokföra momsen ändå, men
            åtgärda felen innan du lämnar in.
          </p>
        )}

        {failed ? (
          <LoadError title="Kunde inte hämta verifikatförslaget" onRetry={onRetry} />
        ) : !upToDate ? (
          <LateReveal>
            <Skeleton className="h-10 w-40" />
          </LateReveal>
        ) : proposal?.is_empty ? (
          <p className="text-sm text-muted-foreground">Ingen moms att bokföra för perioden.</p>
        ) : (
          <div className="space-y-2">
            <Button
              // A posted settlement blocks re-booking: the proposal re-clears the
              // FULL period (it is not delta-aware), so booking twice would
              // corrupt the 26xx balances. Annulling the verifikat restores them
              // and re-enables the button.
              disabled={!proposal || !canWrite || !!booked}
              onClick={() => setDialogOpen(true)}
            >
              Skapa verifikat
            </Button>
            {!canWrite && (
              <p className="text-xs text-muted-foreground">
                Du har läsbehörighet och kan inte bokföra.
              </p>
            )}
          </div>
        )}

      {proposal && (
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent size="wide"

 // Escape closes it while the proposal is as it opened (the form
 // opens filled, so "changed since open" decides:
 // useEditedSinceOpen). An adjusted proposal survives a stray
 // Escape: then closing is explicit via the header X. A backdrop
 // click never closes it.
 onEscapeKeyDown={(e) => holdEscapeWhileUnsaved(e, edited())}
 onPointerDownOutside={(e) => e.preventDefault()}
 onInteractOutside={(e) => e.preventDefault()}
>
            <DialogHeader>
              <DialogTitle>Bokför momsrapport</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              Förslaget bygger på momsrapporten för {proposal.period_label}. Justera
              datum, konton eller belopp vid behov och bokför sedan verifikatet.
            </p>
            {dialogOpen && (
              <div className="contents" {...editProps}>
                <JournalEntryForm
                  bare
                  sourceType="vat_settlement"
                  // The period this settles: the route refuses it when the
                  // period is already booked (another tab, an approved agent
                  // proposal) and keys the verifikat on it (accounted#58).
                  extraBody={{
                    vat_settlement_period: {
                      period_type: proposal.period.type,
                      year: proposal.period.year,
                      period: proposal.period.period,
                      ...(fiscalPeriodId ? { fiscal_period_id: fiscalPeriodId } : {}),
                    },
                  }}
                  initialDate={proposal.entry_date}
                  initialDescription={proposal.description}
                  initialLines={initialLines}
                  onCreated={() => {
                    setDialogOpen(false)
                    onRetry()
                  }}
                />
              </div>
            )}
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}

/** The Stegen header (concept Moms C): the filing pipeline as a clickable
 *  horizontal stepper with honest per-step status subs. Statutory surface,
 *  Swedish in both locales like the rest of the declaration. */
function VatStepper({
  active,
  onSelect,
  errorCount,
  warningCount,
  ruta49,
  bookingStatus,
  bookedVoucher,
  partlySettled,
  filed,
}: {
  active: number
  onSelect: (step: number) => void
  errorCount: number
  warningCount: number
  ruta49: number
  bookingStatus: 'booked' | 'draft' | 'none' | null
  /**
   * The posted settlement's voucher ("A-217"), named in step 3's sub so the
   * stepper carries what the removed "redan bokförd" banner said; the link
   * to it lives in step 3 itself (a link cannot sit inside the tab button).
   */
  bookedVoucher?: string | null
  /**
   * The posted momsredovisning no longer clears the period (the proposal's
   * partly_settled): step 3 is not done while VAT is left (#3570).
   */
  partlySettled: boolean
  /** The period has a filing record (Skatteverket kvittens or marked by hand). */
  filed: boolean
}) {
  const steps = [
    {
      n: 1,
      label: 'Kontrollera',
      sub:
        errorCount > 0
          ? `${errorCount} fel`
          : warningCount > 0
            ? `${warningCount} ${warningCount === 1 ? 'varning' : 'varningar'}`
            : 'klart',
      done: errorCount === 0,
      warn: errorCount > 0,
    },
    {
      n: 2,
      label: 'Granska',
      sub:
        ruta49 > 0
          ? `${formatAmount(ruta49)} kr att betala`
          : ruta49 < 0
            ? `${formatAmount(Math.abs(ruta49))} kr att återfå`
            : 'ingen moms',
      done: false,
      warn: false,
    },
    {
      n: 3,
      label: 'Bokför',
      sub:
        bookingStatus === 'booked' && partlySettled
          ? 'moms kvar att bokföra'
          : bookingStatus === 'booked'
            ? bookedVoucher
              ? `bokförd ${bookedVoucher}`
              : 'bokförd'
            : bookingStatus === 'draft'
              ? 'utkast finns'
              : 'mot 2650',
      done: bookingStatus === 'booked' && !partlySettled,
      warn: bookingStatus === 'booked' && partlySettled,
    },
    {
      n: 4,
      label: 'Lämna in',
      sub: filed ? 'inlämnad' : 'till Skatteverket',
      done: filed,
      warn: false,
    },
  ]

  return (
    <div
      className="flex w-full items-center gap-3 overflow-x-auto px-1"
      role="tablist"
      aria-label="Momsdeklarationens steg"
    >
      {steps.map((step, i) => (
        <React.Fragment key={step.n}>
          {i > 0 && <span className="h-px min-w-4 flex-1 bg-border" aria-hidden="true" />}
          <button
            type="button"
            role="tab"
            aria-selected={active === step.n}
            onClick={() => onSelect(step.n)}
            className="group flex shrink-0 items-center gap-2 text-left"
          >
            <span
              className={cn(
                'flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs tabular-nums transition-colors duration-150',
                step.done
                  ? 'border-success/40 text-success'
                  : active === step.n
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-border text-muted-foreground group-hover:border-foreground/30',
              )}
            >
              {step.done ? <CheckIcon className="h-3.5 w-3.5" aria-hidden="true" /> : step.n}
            </span>
            <span className="leading-tight">
              <span
                className={cn(
                  'block text-xs transition-colors duration-150',
                  active === step.n
                    ? 'font-medium'
                    : 'text-muted-foreground group-hover:text-foreground',
                )}
              >
                {step.label}
              </span>
              {step.sub && (
                <span
                  className={cn(
                    'block text-xs tabular-nums',
                    step.warn ? 'text-attn' : 'text-muted-foreground',
                  )}
                >
                  {step.sub}
                </span>
              )}
            </span>
          </button>
        </React.Fragment>
      ))}
    </div>
  )
}

const MONTH_NAMES = [
  'Januari', 'Februari', 'Mars', 'April', 'Maj', 'Juni',
  'Juli', 'Augusti', 'September', 'Oktober', 'November', 'December',
]
const QUARTER_SPANS = ['jan-mar', 'apr-jun', 'jul-sep', 'okt-dec']
const PERIOD_TYPE_ITEMS: { id: VatPeriodType; label: string }[] = [
  { id: 'monthly', label: 'Månadsvis' },
  { id: 'quarterly', label: 'Kvartalsvis' },
  { id: 'yearly', label: 'Årsvis' },
]

// Inline momsperiod setup for the "registered but no period picked" state.
// Writes through the same PUT /api/settings validation as the tax settings
// form (SFL 26 kap coherence rules included), so this is a shortcut, not a
// second write path. Until a period exists the deadline engine generates NO
// VAT deadlines at all, silently, which is why this state answers inline
// instead of bouncing to settings.
function MomsPeriodInlineSetup({
  onSaved,
}: {
  onSaved: (value: 'monthly' | 'quarterly' | 'yearly') => Promise<void> | void
}) {
  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { canWrite } = useCanWrite()

  const choose = async (value: 'monthly' | 'quarterly' | 'yearly') => {
    if (saving) return
    setSaving(value)
    setError(null)
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ moms_period: value }),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        setError(getErrorMessage(json, { statusCode: res.status }))
        return
      }
      await onSaved(value)
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setSaving(null)
    }
  }

  const options: { value: 'monthly' | 'quarterly' | 'yearly'; label: string }[] = [
    { value: 'quarterly', label: 'Varje kvartal' },
    { value: 'monthly', label: 'Varje månad' },
    { value: 'yearly', label: 'Helår' },
  ]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap justify-center gap-2">
        {options.map((opt) => (
          <Button
            key={opt.value}
            variant="outline"
            // The clicked button stays enabled (aria-busy) so keyboard focus
            // survives the save; the `if (saving) return` guard in choose()
            // prevents a double submit.
            disabled={!canWrite || (saving !== null && saving !== opt.value)}
            aria-busy={saving === opt.value}
            onClick={() => choose(opt.value)}
          >
            {saving === opt.value ? 'Sparar …' : opt.label}
          </Button>
        ))}
      </div>
      {error && (
        <p role="status" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

export default function VatDeclarationView({ pageTitle }: { pageTitle?: string } = {}) {
  const { year: currentYear, month: currentMonth } = stockholmYearMonth()
  const currentQuarter = Math.ceil(currentMonth / 3)

  // periodType stays null until the company's VAT settings have settled, so
  // the first (automatic) fetch runs against the configured momsperiod instead
  // of a guessed default.
  const [periodType, setPeriodType] = useState<VatPeriodType | null>(null)
  const [year, setYear] = useState(currentYear)
  const [period, setPeriod] = useState(currentQuarter)
  // Annual VAT (helårsmoms) is reported per räkenskapsår, not per calendar
  // year. In yearly mode `year` is the year the räkenskapsår ends (the same
  // key every cadence uses, lib/vat/filing-record.ts) and the fiscal period
  // below is derived from it; a pick in the räkenskapsår picker is kept as an
  // explicit override (and moves `year` along). Monthly/quarterly are
  // calendar periods and need no fiscal year.
  const [pickedFiscalPeriodId, setPickedFiscalPeriodId] = useState('')
  const { periods: fiscalPeriods, isLoading: fiscalPeriodsLoading } = useFiscalPeriods()
  const tReports = useTranslations('reports')
  const errorLocale = useLocale() as ErrorLocale
  const tPay = useTranslations('skattekonto_bank_payment')
  // Latest fetch outcome, tagged with the fetch key it was requested under.
  // loading / error / data are all derived by comparing that tag with the
  // current key, so the fetch effect never sets state synchronously.
  const [result, setResult] = useState<{
    key: string
    declaration?: VatDeclaration
    error?: string
  } | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  // Stegen: which of the four pipeline steps is open. null = automatic
  // (errors land on Kontrollera, otherwise Granska). A period switch resets
  // to automatic so stale step choices never survive a context change.
  const [chosenStep, setChosenStep] = useState<number | null>(null)
  const [settlementRefreshKey, setSettlementRefreshKey] = useState(0)
  // Filing records (issue #2746): which calendar periods are on record as
  // filed, through the Skatteverket connection or marked by hand. Tagged with
  // the company they were fetched for, because the initial period seed below
  // must read them: a filed period is skipped in favour of the next one.
  // `changed` holds the filed periods whose books moved after the filing.
  const [filings, setFilings] = useState<{
    key: string
    byPeriod: Map<string, VatFilingRecord>
    changed: VatFilingRecordWithChange[]
  } | null>(null)
  const [filingsRefreshKey, setFilingsRefreshKey] = useState(0)
  // Per-verifikat RC-basis scan, fetched here (not only inside VatChecksCard)
  // because the filing gate lives here and the worklist unmounts as soon as
  // the user leaves steg 1. Tagged with the PERIOD it was requested for (see
  // gapScanPeriodKey), so a korrigering refetches without the gate falling
  // open in between; gaps === null means "not known" (scan failed), which is
  // deliberately NOT the same as an empty list. The list itself (not only its
  // length) is kept because a reviewed warning's fingerprint reads it.
  const [gapScan, setGapScan] = useState<{ key: string; gaps: RcBasisGap[] | null } | null>(null)
  // Reviewed warnings for the period (crm#1171), tagged like the scan. A
  // failed read is an empty list: the warnings simply stay unreviewed.
  const [checkReviews, setCheckReviews] = useState<{ key: string; reviews: VatCheckReview[] } | null>(null)
  const [reviewsRefreshKey, setReviewsRefreshKey] = useState(0)

  // Company settings drive both the momsregistrerad gate and the default
  // periodicity (moms_period in Inställningar). Applied once per company the
  // first time its settings settle, as a render-phase adjustment, not an
  // effect. A later manual change to the picker is preserved for the session,
  // and a company switch re-applies the new company's setting. The cadence is
  // deliberately NOT persisted across visits: the redovisningsperiod is fixed
  // by the company's Skatteverket registration, so this mount-time re-seed is
  // the control that self-heals an in-session detour to the wrong period
  // type (see lib/vat/period-selection.ts). `useCompanySettings` only
  // refetches when the active company changes, so this never clobbers a
  // manual selection mid-session.
  const {
    settings,
    isLoading: settingsLoading,
    loadFailed: settingsLoadFailed,
    refetch: refetchSettings,
  } = useCompanySettings()
  const [appliedCompany, setAppliedCompany] = useState<string | null>(null)
  const companyKey = settingsLoading ? null : (settings?.company_id ?? 'none')

  // The filing records load per company and again after a mark/undo. A
  // failed fetch settles as an empty set rather than blocking the seed: the
  // page must still open on a missing list, it just cannot skip ahead.
  useEffect(() => {
    if (companyKey === null) return
    let cancelled = false
    fetch('/api/reports/vat-declaration/filings')
      .then(async (res) => {
        const json = await res.json().catch(() => null)
        if (cancelled) return
        const rows: VatFilingRecordWithChange[] = res.ok && Array.isArray(json?.data) ? json.data : []
        setFilings({
          key: companyKey,
          byPeriod: indexVatFilings(rows),
          changed: rows.filter((row) => row.changed_after_filing),
        })
      })
      .catch(() => {
        if (!cancelled) setFilings({ key: companyKey, byPeriod: new Map(), changed: [] })
      })
    return () => {
      cancelled = true
    }
  }, [companyKey, filingsRefreshKey])
  const filingsReady = filings !== null && filings.key === companyKey
  const filedByPeriod = filingsReady ? filings.byPeriod : null

  // Where the räkenskapsår ends: places a yearly period, as on the server,
  // from the recorded years. The seed asks for the year running today, the
  // filing card for the year selected.
  const fiscalCalendar = {
    entity_type: settings?.entity_type,
    fiscal_year_start_month: settings?.fiscal_year_start_month,
    fiscal_years: fiscalPeriods.map((p) => ({ start: p.period_start, end: p.period_end })),
  }
  const fiscalYearEndMonth = fiscalYearEndMonthIn(year, fiscalCalendar)
  const runningYearEndMonth = fiscalYearEndMonthOn(todayIsoStockholm(), fiscalCalendar)

  // Seeded once settings AND the filing records for the company have
  // settled, so the seed can step past an already-filed period (#2746,
  // helårsmoms included since #2786) instead of reopening it on every visit
  // until the next period ends.
  if (companyKey !== null && filingsReady && !fiscalPeriodsLoading && appliedCompany !== companyKey) {
    setAppliedCompany(companyKey)
    const initial = resolveInitialVatPeriodSelection({
      momsPeriod: settings?.moms_period ?? null,
      over40m: settings?.vat_taxable_base_over_40m === true,
      fiscalYearEndMonth: runningYearEndMonth,
      isFiled: (cadence, y, p) => filings.byPeriod.has(vatFilingKey(cadence, y, p)),
    })
    setPeriodType(initial.periodType)
    setYear(initial.year)
    setPeriod(initial.period)
    setPickedFiscalPeriodId('')
  }

  // Settings row present and the company answered "not VAT-registered":
  // the declaration is meaningless, so the whole view is gated below.
  const notVatRegistered = !settingsLoading && settings !== null && !settings.vat_registered
  // No company_settings row at all (company created outside onboarding):
  // VAT registration AND periodicity are both unknown. This used to fall
  // through every gate and render a silently guessed quarterly declaration;
  // the wrong period type for an årsmoms company is a compliance hazard, so
  // it now gates like the other unknowns.
  // A failed read is not a missing row: it says so with a retry below.
  const settingsRowMissing = !settingsLoading && settings === null && !settingsLoadFailed
  // Registered but never picked a redovisningsperiod (rare: onboarding
  // requires it, but companies created outside that flow can miss it).
  const momsPeriodMissing = settings?.vat_registered === true && !settings.moms_period

  // Switching periodicity resets the period to the most recently ended one in
  // the new unit (same default as first load: the current period can never be
  // filed). Done in the change handler (not an effect) so the auto-fetch below
  // never sees an inconsistent periodType/period pair.
  const handlePeriodTypeChange = (value: VatPeriodType) => {
    setPeriodType(value)
    const ended = mostRecentEndedVatPeriod(value, new Date(), {
      over40m: settings?.vat_taxable_base_over_40m === true,
      fiscalYearEndMonth: runningYearEndMonth,
    })
    setYear(ended.year)
    setPeriod(ended.period)
    setPickedFiscalPeriodId('')
  }

  // Annual VAT (helårsmoms) is reported per räkenskapsår, not per calendar year.
  // For yearly we pass the selected fiscal period so the API uses its actual
  // bounds (handles extended/shortened years); monthly/quarterly stay calendar.
  // The fiscal period is the explicit pick, else the one the yearly key names
  // (the räkenskapsår ending in `year`). Its end date lets the Skatteverket
  // panel target the FY-end month (broken fiscal years do not end in December).
  const isYearly = periodType === 'yearly'
  const yearlyFiscalPeriod = isYearly
    ? (fiscalPeriods.find((p) => p.id === pickedFiscalPeriodId) ??
      fiscalPeriodForVatYear(fiscalPeriods, year, todayIsoStockholm()))
    : null
  const fiscalPeriodId = yearlyFiscalPeriod?.id ?? ''
  const fiscalPeriodEnd = yearlyFiscalPeriod?.period_end ?? null
  const awaitingFiscalPeriod = isYearly && !fiscalPeriodId
  const vatQueryString = () => {
    const params = new URLSearchParams({
      periodType: periodType ?? 'quarterly',
      year: String(year),
      period: String(period),
    })
    if (isYearly && fiscalPeriodId) params.set('fiscal_period_id', fiscalPeriodId)
    return params.toString()
  }

  // The declaration loads as soon as the period is known: no manual "Hämta"
  // step. fetchKey is null while a prerequisite is missing (settings pending,
  // gated, or no redovisningsperiod configured); any change to it triggers a
  // refetch and stale responses are discarded.
  // seedPending: the seed above now waits for the filing records, so on a
  // company switch the previous company's cadence is still selected for one
  // round trip. Nothing is fetched at that stale cadence.
  const seedPending = appliedCompany !== companyKey
  const fetchKey =
    periodType === null ||
    seedPending ||
    notVatRegistered ||
    settingsLoadFailed ||
    settingsRowMissing ||
    momsPeriodMissing ||
    awaitingFiscalPeriod
      ? null
      : `${periodType}:${year}:${period}:${isYearly ? fiscalPeriodId : ''}:${retryKey}`

  // Period identity WITHOUT the retry counter, used to decide whether the gap
  // scan below still speaks for what is on screen. The scan re-runs on every
  // retryKey bump (each korrigering), but the last settled count stays in
  // force until the new one lands: falling back to `pending` mid-korrigering
  // would drop the gap finding out of `checks` for one round trip, and with
  // the aggregate check silent (the tolerance case this gate exists for) the
  // green "Inga fel hittades i underlaget för perioden" would render right
  // above the vouchers still left in the worklist, with Skicka enabled. That
  // is the exact regression being fixed, and steg 1 stays mounted across a
  // korrigering, so the user would be looking straight at it. Stale-but-closed
  // is the safe direction, and it matches the declaration itself, which stays
  // on screen (dimmed) while the next one loads.
  const gapScanPeriodKey =
    periodType === null
      ? null
      : `${periodType}:${year}:${period}:${isYearly ? fiscalPeriodId : ''}`

  const settlement = useVatSettlementProposal({
    periodType,
    year,
    period,
    fiscalPeriodId: isYearly ? fiscalPeriodId : undefined,
    enabled: fetchKey != null,
    refreshKey: settlementRefreshKey,
  })
  const bookingStatus = settlement.upToDate ? settlement.bookingStatus : null
  const { canWrite } = useCanWrite()
  // The selected period's filing record, if any: one key for every cadence
  // (helårsmoms: the year the räkenskapsår ends, period 1).
  const filingRecord =
    filedByPeriod && periodType
      ? (filedByPeriod.get(vatFilingKey(periodType, year, period)) ?? null)
      : null

  useEffect(() => {
    setChosenStep(null)
  }, [periodType, year, period, fiscalPeriodId])

  useEffect(() => {
    if (!fetchKey || periodType === null) return
    const params = new URLSearchParams({
      periodType,
      year: String(year),
      period: String(period),
    })
    if (periodType === 'yearly') params.set('fiscal_period_id', fiscalPeriodId)
    let cancelled = false
    fetch(`/api/reports/vat-declaration?${params.toString()}`)
      .then(async (res) => {
        const json = await res.json().catch(() => null)
        if (cancelled) return
        if (!res.ok || json?.error) {
          setResult({
            key: fetchKey,
            error:
              getErrorMessage(json, { locale: errorLocale, fallback: 'Kunde inte hämta momsdeklaration' }),
          })
        } else {
          setResult({ key: fetchKey, declaration: json.data })
        }
      })
      .catch(() => {
        if (!cancelled) setResult({ key: fetchKey, error: 'Kunde inte hämta momsdeklaration' })
      })
    return () => {
      cancelled = true
    }
  }, [fetchKey, periodType, year, period, fiscalPeriodId])

  // The per-verifikat gap scan runs on the same key as the declaration, so a
  // korrigering (which bumps retryKey via onCorrected) re-verifies the gate
  // instead of leaving it stuck on the pre-correction count.
  useEffect(() => {
    if (!fetchKey || periodType === null || !gapScanPeriodKey) return
    const params = new URLSearchParams({
      periodType,
      year: String(year),
      period: String(period),
    })
    if (periodType === 'yearly') params.set('fiscal_period_id', fiscalPeriodId)
    let cancelled = false
    fetch(`/api/reports/vat-declaration/rc-basis-gaps?${params.toString()}`)
      .then(async (res) => {
        const json = await res.json().catch(() => null)
        if (cancelled) return
        // count === null is a settled FAILURE, and unknown is not "inga
        // brister": it becomes a visible warning row (so the banner cannot
        // claim all-clear on a check that never ran) but does not block, or a
        // network hiccup would lock the user out of a statutory deadline.
        if (!res.ok || json?.error) setGapScan({ key: gapScanPeriodKey, gaps: null })
        else setGapScan({ key: gapScanPeriodKey, gaps: Array.isArray(json?.data?.gaps) ? json.data.gaps : [] })
      })
      .catch(() => {
        if (!cancelled) setGapScan({ key: gapScanPeriodKey, gaps: null })
      })
    return () => {
      cancelled = true
    }
  }, [fetchKey, gapScanPeriodKey, periodType, year, period, fiscalPeriodId])

  // The period's reviewed warnings, keyed by the period like the scan and read
  // again after a mark or an undo. The last list for the same period stays in
  // force while the next one loads: a review only applies while its
  // fingerprint matches the figures on screen, so a stale list cannot quiet a
  // warning whose figures moved.
  useEffect(() => {
    if (!fetchKey || periodType === null || !gapScanPeriodKey) return
    const params = new URLSearchParams({
      period_type: periodType,
      year: String(year),
      period: String(period),
    })
    if (periodType === 'yearly') params.set('fiscal_period_id', fiscalPeriodId)
    const key = gapScanPeriodKey
    let cancelled = false
    fetch(`/api/reports/vat-declaration/check-reviews?${params.toString()}`)
      .then(async (res) => {
        const json = await res.json().catch(() => null)
        if (cancelled) return
        setCheckReviews({ key, reviews: res.ok && Array.isArray(json?.data) ? json.data : [] })
      })
      .catch(() => {
        if (!cancelled) setCheckReviews({ key, reviews: [] })
      })
    return () => {
      cancelled = true
    }
  }, [fetchKey, gapScanPeriodKey, reviewsRefreshKey, periodType, year, period, fiscalPeriodId])

  // Derived fetch state: the previous declaration stays visible (dimmed)
  // while the next period loads.
  const upToDate = result !== null && result.key === fetchKey
  const data = result?.declaration ?? null
  const error = upToDate ? (result.error ?? null) : null
  const loading = fetchKey !== null && !upToDate

  // Local pre-flight checks on the calculated declaration. Computed here (not
  // in SkatteverketPanel) so every user sees them: they gate direct submission
  // but concern manual filers just as much.
  //
  // The per-verifikat gap scan is folded in BEFORE anything derives from the
  // list. The aggregate checks compare period totals with a tolerance that
  // scales with period size, so they can stay silent while individual
  // verifikat still miss their basbelopp: reading them alone let the green
  // "Inga fel hittades i underlaget för perioden" render directly above the
  // worklist of those verifikat, with Skicka enabled. Banner, stegen and the
  // send gate now all read this ONE array. The three scan states are kept
  // apart: only a settled count of zero is allowed to mean "inga brister".
  const gapScanSettled = gapScan !== null && gapScan.key === gapScanPeriodKey
  const rcBasisScan: RcBasisGapScan = !gapScanSettled
    ? { status: 'pending' }
    : gapScan.gaps === null
      ? { status: 'unavailable' }
      : { status: 'scanned', gapCount: gapScan.gaps.length }
  // The declaration carries the 2645/2647 totals (rcInputAccountTotals), so
  // RC_INPUT_VAT_MISMATCH compares rutor 30-32 against the reverse-charge INPUT
  // accounts instead of the ruta 48 aggregate. Without them, 50 000 kr of
  // fiktiv utgående moms with nothing on 2645 sits silently behind 60 000 kr of
  // ordinary 2641 and the user pays in moms they were entitled to deduct.
  // rcInputTotalsFromDeclaration returns undefined (not an empty map) when a
  // response predates the field, which keeps the fallback honest.
  // The gap-downgrade evidence (per-momssats 44xx/45xx balances) travels on
  // the declaration payload. Absent on responses from an older deploy: then
  // the gaps keep their blocking ERROR tier rather than guessing.
  // The class 3 accounts and the moms accounts that reach no ruta travel on
  // the payload too (REVENUE_ACCOUNT_WITHOUT_RUTA, #3387, and
  // VAT_ACCOUNT_WITHOUT_RUTA); absent on an older response, which keeps those
  // warnings silent.
  const rawChecks = data
    ? withRcBasisGapFindings(
        runVatDeclarationChecks(data.rutor, rcInputTotalsFromDeclaration(data), {
          revenueAccountsWithoutRuta: data.revenueAccountsWithoutRuta,
          vatAccountsWithoutRuta: data.vatAccountsWithoutRuta,
          kontantmetodCutoff: data.kontantmetodCutoff,
        }),
        rcBasisScan,
        data.rcBasisByRate
          ? { rutor: data.rutor, rcBasisByRate: data.rcBasisByRate }
          : undefined,
      )
    : []
  // Reviews (crm#1171) apply over the same declaration and gap list the
  // server fingerprinted, and only to WARNINGs: the gate below reads the same
  // ERRORs either way. Null inputs while the scan is pending: nothing is
  // reviewable before the scan has answered.
  const reviewInputs: VatCheckReviewInputs | null =
    data && gapScanSettled ? { declaration: data, gaps: gapScan.gaps } : null
  const reviewsSettled = checkReviews !== null && checkReviews.key === gapScanPeriodKey
  const checks =
    reviewInputs && reviewsSettled ? applyVatCheckReviews(rawChecks, checkReviews.reviews, reviewInputs) : rawChecks
  const checksBlocked = isFilingBlocked(checks)
  const errorCount = checks.filter((c) => c.status === 'ERROR').length
  const warningCount = checks.filter((c) => c.status === 'WARNING' && !c.review).length
  // The per-verifikat gaps are advisory (the period matches per momssats):
  // the worklist then offers no Korrigera, which would count the basis twice.
  const rcBasisAdvisory =
    rcBasisScan.status === 'scanned' &&
    checks.some((c) => c.code === 'RC_BASIS_MISSING' && c.status === 'WARNING')
  // Latch the automatic landing step once per period, as a render-phase
  // adjustment when the period's declaration first settles. Deriving it live
  // from checksBlocked navigated the user away mid-work: the refetch after a
  // korrigering can clear the aggregate error while the Kontrollera worklist
  // still holds broken vouchers, and the view would jump to Granska under
  // their feet. The period-change effect below resets chosenStep to null,
  // which re-arms this latch for the next period. It also waits for the gap
  // scan: latching on the aggregate alone landed the user on Granska while
  // steg 1 still held a blocking worklist. A period with no amount in any
  // ruta opens on Kontrollera too (lib/vat/landing-step): Granska would lead
  // with "Nästa: Bokför momsen" for nothing. Every step stays in the stepper.
  if (chosenStep === null && upToDate && data && !error && gapScanSettled) {
    setChosenStep(vatLandingStep({ checksBlocked, rutor: data.rutor }))
  }
  const activeStep = chosenStep ?? (data ? vatLandingStep({ checksBlocked, rutor: data.rutor }) : checksBlocked ? 1 : 2)

  // Settings not settled yet: the picker defaults and the gate both depend
  // on them, so hold the whole view in a skeleton.
  // The standalone page renders its own PageHeader (FocusedReport passes the
  // title and skips its own), so the H1 must survive the gated/loading
  // states too: each early return carries the action-less header.
  const bareHeader = pageTitle ? <PageHeader title={pageTitle} /> : null

  // A failed settings read needs no seeded period to say so.
  if (settingsLoadFailed) {
    return (
      <div className="space-y-8">
        {bareHeader}
        <LoadError title={tReports('vat_settings_load_failed')} onRetry={() => void refetchSettings()} />
      </div>
    )
  }

  if (settingsLoading || periodType === null) {
    return (
      <div className="space-y-8">
        {bareHeader}
        <ReportBodyLoading />
      </div>
    )
  }

  if (settingsRowMissing) {
    return (
      <div className="space-y-8">
        {bareHeader}
        <EmptyState
          icon={PercentBadgeIcon}
          title="Skatteinställningar saknas"
          description="Momsdeklarationen bygger på företagets skatteinställningar, men inga är angivna ännu. Ange momsregistrering och redovisningsperiod (månad, kvartal eller helår) i inställningarna, så visas deklarationen för rätt period."
          actionLabel="Öppna skatteinställningar"
          actionHref="/settings/tax"
        />
      </div>
    )
  }

  if (notVatRegistered) {
    return (
      <div className="space-y-8">
        {bareHeader}
        <EmptyState
          icon={PercentBadgeIcon}
          title="Företaget är inte momsregistrerat"
          description="Momsdeklarationen bygger på företagets skatteinställningar. Om företaget är momsregistrerat anger du momsregistrering och redovisningsperiod i inställningarna, så visas deklarationen här."
          actionLabel="Öppna skatteinställningar"
          actionHref="/settings/tax"
        />
      </div>
    )
  }

  // Registered but no redovisningsperiod picked: block instead of guessing.
  // A declaration rendered (and submittable via panelen) for the wrong
  // period type is a compliance hazard, not a convenience. But the answer is
  // collected HERE, inline: until it exists the deadline engine generates no
  // VAT deadlines at all (silently), so bouncing the user to settings left a
  // compliance hole open longer than it needed to be. When vat_number is ALSO
  // missing, the inline save would 400 on the vat_number coherence rule in
  // PUT /api/settings (momsregistrerad requires a registreringsnummer), so
  // that (rarer) state keeps the settings bounce, which has both fields.
  if (momsPeriodMissing) {
    if (!settings?.vat_number) {
      return (
        <div className="space-y-8">
          {bareHeader}
          <EmptyState
            icon={PercentBadgeIcon}
            title="Redovisningsperiod för moms saknas"
            description="Företaget är momsregistrerat men momsregistreringsnummer och redovisningsperiod (månad, kvartal eller helår) saknas. Ange dem i skatteinställningarna så visas deklarationen för rätt period."
            actionLabel="Öppna skatteinställningar"
            actionHref="/settings/tax"
          />
        </div>
      )
    }
    return (
      <div className="space-y-8">
        {bareHeader}
        <EmptyState
          icon={PercentBadgeIcon}
          title="Välj redovisningsperiod för moms"
          description="Företaget är momsregistrerat men ingen redovisningsperiod är vald, så deklarationen och momsdeadlines kan inte visas. Perioden står i registreringsbeslutet från Skatteverket."
        >
          <div className="space-y-3">
            <MomsPeriodInlineSetup
              onSaved={async (value) => {
                await refetchSettings()
                // The first-settle seeding above only runs once per company,
                // so re-apply the fresh periodicity (and its most-recent-
                // ended default period) by hand.
                handlePeriodTypeChange(value)
              }}
            />
            <p className="text-xs text-muted-foreground">
              Du kan alltid ändra den i{' '}
              <Link href="/settings/tax" className="underline underline-offset-2 hover:text-foreground">
                skatteinställningarna
              </Link>
              .
            </p>
          </div>
        </EmptyState>
      </div>
    )
  }

  // Year and concrete period fused into ONE chip: reverse-chronological
  // "Kvartal 2 2026", "Kvartal 1 2026", ... across the last five years, so
  // switching period never needs two pickers. Yearly keeps the FyPicker,
  // which is already a fused räkenskapsår chip.
  const fusedPeriodItems: { id: string; label: string; annotation?: string }[] = []
  if (!isYearly) {
    for (let y = currentYear; y > currentYear - 5; y--) {
      // Filed periods carry an "inlämnad" note so the picker shows at a
      // glance which declarations are done (#2746).
      if (periodType === 'quarterly') {
        for (let q = 4; q >= 1; q--) {
          const filed = filedByPeriod?.has(vatFilingKey('quarterly', y, q)) === true
          fusedPeriodItems.push({
            id: `${y}:${q}`,
            label: `Kvartal ${q} ${y}`,
            annotation: filed ? `${QUARTER_SPANS[q - 1]} · inlämnad` : QUARTER_SPANS[q - 1],
          })
        }
      } else {
        for (let m = 12; m >= 1; m--) {
          const filed = filedByPeriod?.has(vatFilingKey('monthly', y, m)) === true
          fusedPeriodItems.push({
            id: `${y}:${m}`,
            label: `${MONTH_NAMES[m - 1]} ${y}`,
            annotation: filed ? 'inlämnad' : undefined,
          })
        }
      }
    }
  }
  const fusedLabel =
    periodType === 'quarterly' ? `Kvartal ${period} ${year}` : `${MONTH_NAMES[period - 1]} ${year}`
  // The selected period as the filing card names it. A räkenskapsår carries
  // the deadline's own label (2026, or 2025/2026 for a broken year).
  const filingPeriodLabel = isYearly
    ? tReports('vat_filing_period_yearly', {
        label: vatFilingTaxPeriod('yearly', year, period, fiscalYearEndMonth),
      })
    : fusedLabel

  // Cadence and period, side by side. The cadence chip is the only way to
  // view a period under another granularity than the Skatt setting (a
  // company that switched cadence and still files an older period); it is
  // never persisted (the mount-time seed re-applies the setting), and it
  // shows its value so it reads as the picker it is.
  const periodPickers = (
    <>
      <ContextPicker
        items={PERIOD_TYPE_ITEMS}
        value={periodType}
        onChange={(value) => handlePeriodTypeChange(value as VatPeriodType)}
        triggerLabel={PERIOD_TYPE_ITEMS.find((item) => item.id === periodType)?.label ?? 'Period'}
        ariaLabel="Periodicitet"
      />
      {isYearly ? (
        // Annual VAT covers a räkenskapsår: picked here, not a
        // calendar year.
        <FyPicker
          value={fiscalPeriodId || null}
          onChange={(id, fp) => {
            setPickedFiscalPeriodId(id || '')
            // The yearly key follows the pick: the year it ends in.
            if (fp) {
              setYear(Number(fp.period_end.slice(0, 4)))
              setPeriod(1)
            }
          }}
          includeAllOption={false}
          hideFuturePeriods
          preferLatestEnded
        />
      ) : (
        <ContextPicker
          items={fusedPeriodItems}
          value={`${year}:${period}`}
          onChange={(id) => {
            const [y, p] = id.split(':').map(Number)
            setYear(y)
            setPeriod(p)
          }}
          triggerLabel={fusedLabel}
          ariaLabel="Redovisningsperiod"
        />
      )}
    </>
  )

  return (
    <VatDrillContext.Provider value={{ fiscalPeriodId: isYearly ? fiscalPeriodId : undefined }}>
    <div className="space-y-8">
      {/* Standalone page: the top bar carries Exportera and the period
          pickers (convention 8: the context picker far right), so no row is
          spent on them. The primary action belongs to the step in front of
          the person (Korrigera alla, Bokför momsen, Lämna in), not to the
          spreadsheet (design decision 2026-09-09). XML and PDF live in "Lämna in":
          they are filing artifacts, not report exports. */}
      {pageTitle ? (
        <PageHeader
          title={pageTitle}
          action={
            // Three controls: on a phone Exportera folds into the bar's
            // "more" and the period pickers stay (PageHeaderActions).
            <div className="flex flex-wrap items-center justify-end gap-2">
              <ReportExportMenu
                variant="outline"
                items={[
                  { format: 'xlsx', href: `/api/reports/vat-declaration/xlsx?${vatQueryString()}` },
                ]}
              />
              {periodPickers}
            </div>
          }
        />
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {periodPickers}
          <ReportExportMenu
            variant="outline"
            items={[
              { format: 'xlsx', href: `/api/reports/vat-declaration/xlsx?${vatQueryString()}` },
            ]}
          />
        </div>
      )}

      {error && <LoadError title={error} onRetry={() => setRetryKey((k) => k + 1)} />}

      {filingsReady && filings.changed.length > 0 && (
        <VatFiledChangesLine
          changed={filings.changed}
          onOpen={(record) => {
            setPeriodType(record.period_type)
            setYear(record.year)
            setPeriod(record.period)
            setPickedFiscalPeriodId('')
          }}
        />
      )}

      {!error && (awaitingFiscalPeriod || (loading && !data)) && <ReportBodyLoading />}

      {data && !awaitingFiscalPeriod && (
        <div
          className={`space-y-8 transition-opacity duration-150 ${loading ? 'opacity-60' : ''}`}
        >
          {/* Stegen (concept): the filing pipeline as a horizontal stepper
              (kontrollera, granska, bokför, lämna in), showing one step's
              content at a time. Errors and a period with nothing in any ruta
              land on step 1, otherwise Granska. */}
          <VatStepper
            active={activeStep}
            onSelect={setChosenStep}
            errorCount={errorCount}
            warningCount={warningCount}
            ruta49={buildFiledAmounts(data.rutor).net}
            bookingStatus={bookingStatus}
            bookedVoucher={settlement.booked ? formatVoucher(settlement.booked) : null}
            partlySettled={settlement.proposal?.partly_settled === true}
            filed={filingRecord !== null}
          />

          {activeStep === 1 && (
            <section className="space-y-3">
              <VatChecksCard
              checks={checks}
              periodType={periodType}
              year={year}
              period={period}
              fiscalPeriodId={isYearly ? fiscalPeriodId : undefined}
              onCorrected={() => setRetryKey((k) => k + 1)}
              reviewInputs={reviewInputs}
              rcBasisAdvisory={rcBasisAdvisory}
              onReviewsChanged={() => setReviewsRefreshKey((k) => k + 1)}
            />
            </section>
          )}

          {activeStep === 2 && (
            <section className="space-y-3">
              <div>
            {/* The title and the period picker already name the declaration
                and its period; only the basis counts are new here. They
                count verifikat, not invoices: a paid invoice is two (its
                booking and its payment), so the label says verifikat. */}
            <p className="px-1 text-xs tabular-nums text-muted-foreground">
              {tReports('vat_entry_counts', { invoices: data.invoiceCount, transactions: data.transactionCount })}
            </p>
            <div className="mt-4 space-y-8">
              <div>
                {/* Utgående moms */}
                <div>
                  <h3 className="mb-3 font-sans text-xs font-medium text-muted-foreground">
                    Utgående moms (försäljning)
                  </h3>
                  <Table>
                    <TableBody>
                      {data.rutor.ruta05 !== 0 && (
                        <VatRutaRow
                          ruta="05"
                          label="Momspliktig försäljning"
                          amount={data.rutor.ruta05}
                          baseAmount={0}
                          periodType={periodType}
                          year={year}
                          period={period}
                        />
                      )}
                      {/* The other three bases in section A of SKV 4700. Shown
                          only when used, like ruta 05: most companies have
                          none, and an always-visible row of zeroes is noise.
                          Ruta 07 has no entry in ACCOUNT_RUTA at all, so it
                          can only arrive through the vmb treatment; ruta 08
                          comes from BAS 3913 or the rental_voluntary
                          treatment. */}
                      {data.rutor.ruta06 !== 0 && (
                        <VatRutaRow
                          ruta="06"
                          label="Momspliktiga uttag"
                          amount={data.rutor.ruta06}
                          baseAmount={0}
                          periodType={periodType}
                          year={year}
                          period={period}
                        />
                      )}
                      {data.rutor.ruta07 !== 0 && (
                        <VatRutaRow
                          ruta="07"
                          label="Vinstmarginalbeskattning"
                          amount={data.rutor.ruta07}
                          baseAmount={0}
                          periodType={periodType}
                          year={year}
                          period={period}
                        />
                      )}
                      {data.rutor.ruta08 !== 0 && (
                        <VatRutaRow
                          ruta="08"
                          label="Hyresinkomster (frivillig skattskyldighet)"
                          amount={data.rutor.ruta08}
                          baseAmount={0}
                          periodType={periodType}
                          year={year}
                          period={period}
                        />
                      )}
                      <VatRutaRow
                        ruta="10"
                        label="Utgående moms 25%"
                        amount={data.rutor.ruta10}
                        baseAmount={data.breakdown.invoices.base25}
                        periodType={periodType}
                        year={year}
                        period={period}
                      />
                      <VatRutaRow
                        ruta="11"
                        label="Utgående moms 12%"
                        amount={data.rutor.ruta11}
                        baseAmount={data.breakdown.invoices.base12}
                        periodType={periodType}
                        year={year}
                        period={period}
                      />
                      <VatRutaRow
                        ruta="12"
                        label="Utgående moms 6%"
                        amount={data.rutor.ruta12}
                        baseAmount={data.breakdown.invoices.base6}
                        periodType={periodType}
                        year={year}
                        period={period}
                      />
                    </TableBody>
                    <tfoot>
                      <tr className="border-t font-medium">
                        <td className="py-2">Summa utgående moms</td>
                        <td className="py-2 text-right tabular-nums">
                          {formatAmount(
                            data.rutor.ruta10 + data.rutor.ruta11 + data.rutor.ruta12 +
                            data.rutor.ruta30 + data.rutor.ruta31 + data.rutor.ruta32 +
                            data.rutor.ruta60 + data.rutor.ruta61 + data.rutor.ruta62
                          )} kr
                        </td>
                      </tr>
                    </tfoot>
                  </Table>

                  {/* Omvänd skattskyldighet (inköp) */}
                  {/* Non-zero, not positive, and the same test in all three
                      sections below: VatRutaRow hides itself only at exactly
                      zero, and a box legitimately goes negative in a period
                      dominated by credit notes. A section testing > 0 would
                      swallow the row the box most needs to show. */}
                  {(data.rutor.ruta20 !== 0 || data.rutor.ruta21 !== 0 || data.rutor.ruta22 !== 0 || data.rutor.ruta23 !== 0 || data.rutor.ruta24 !== 0 ||
                    data.rutor.ruta30 !== 0 || data.rutor.ruta31 !== 0 || data.rutor.ruta32 !== 0) && (
                    <>
                      <h3 className="mb-3 mt-6 font-sans text-xs font-medium text-muted-foreground">
                        Omvänd skattskyldighet (inköp)
                      </h3>
                      <Table>
                        <TableBody>
                          <VatRutaRow ruta="20" label="Inköp av varor från annat EU-land" amount={0} baseAmount={data.rutor.ruta20} noVat periodType={periodType} year={year} period={period} />
                          <VatRutaRow ruta="21" label="Inköp av tjänster från annat EU-land" amount={0} baseAmount={data.rutor.ruta21} noVat periodType={periodType} year={year} period={period} />
                          <VatRutaRow ruta="22" label="Inköp av tjänster utanför EU" amount={0} baseAmount={data.rutor.ruta22} noVat periodType={periodType} year={year} period={period} />
                          <VatRutaRow ruta="23" label="Inköp av varor i Sverige" amount={0} baseAmount={data.rutor.ruta23} noVat periodType={periodType} year={year} period={period} />
                          <VatRutaRow ruta="24" label="Övriga inköp av tjänster i Sverige" amount={0} baseAmount={data.rutor.ruta24} noVat periodType={periodType} year={year} period={period} />
                          <VatRutaRow ruta="30" label="Utgående moms 25% (omvänd)" amount={data.rutor.ruta30} baseAmount={0} periodType={periodType} year={year} period={period} />
                          <VatRutaRow ruta="31" label="Utgående moms 12% (omvänd)" amount={data.rutor.ruta31} baseAmount={0} periodType={periodType} year={year} period={period} />
                          <VatRutaRow ruta="32" label="Utgående moms 6% (omvänd)" amount={data.rutor.ruta32} baseAmount={0} periodType={periodType} year={year} period={period} />
                        </TableBody>
                      </Table>
                    </>
                  )}

                  {/* Försäljning undantagen från moms: section E of SKV 4700.
                      Eight boxes that carry a base and no VAT, and until now
                      the report drew two of them. Ruta 35 was the expensive
                      omission: EU goods sales are ordinary business, they were
                      computed correctly and filed correctly in the PDF and the
                      eSKD file, and the screen simply did not say so. Rutor 37
                      and 38 became reachable with triangulation_eu_goods and
                      would have landed in the same silence. */}
                  {(data.rutor.ruta35 !== 0 || data.rutor.ruta36 !== 0 || data.rutor.ruta37 !== 0 ||
                    data.rutor.ruta38 !== 0 || data.rutor.ruta39 !== 0 || data.rutor.ruta40 !== 0 ||
                    data.rutor.ruta41 !== 0 || data.rutor.ruta42 !== 0) && (
                    <>
                      <h3 className="mb-3 mt-6 font-sans text-xs font-medium text-muted-foreground">
                        Försäljning undantagen från moms
                      </h3>
                      <Table>
                        <TableBody>
                          <VatRutaRow ruta="35" label="Varuförsäljning till annat EU-land" amount={0} baseAmount={data.rutor.ruta35} noVat periodType={periodType} year={year} period={period} />
                          <VatRutaRow ruta="36" label="Varuförsäljning utanför EU (export)" amount={0} baseAmount={data.rutor.ruta36} noVat periodType={periodType} year={year} period={period} />
                          <VatRutaRow ruta="37" label="Mellanmans inköp vid trepartshandel" amount={0} baseAmount={data.rutor.ruta37} noVat periodType={periodType} year={year} period={period} />
                          <VatRutaRow ruta="38" label="Mellanmans försäljning vid trepartshandel" amount={0} baseAmount={data.rutor.ruta38} noVat periodType={periodType} year={year} period={period} />
                          <VatRutaRow ruta="39" label="Tjänster EU (omvänd skattskyldighet)" amount={0} baseAmount={data.rutor.ruta39} noVat periodType={periodType} year={year} period={period} />
                          {/* Not "Export utanför EU": that is ruta 36 one row
                              up, and this box is services, not goods. */}
                          <VatRutaRow ruta="40" label="Övrig försäljning av tjänster utomlands" amount={0} baseAmount={data.rutor.ruta40} noVat periodType={periodType} year={year} period={period} />
                          <VatRutaRow ruta="41" label="Försäljning med omvänd skattskyldighet i Sverige" amount={0} baseAmount={data.rutor.ruta41} noVat periodType={periodType} year={year} period={period} />
                          <VatRutaRow ruta="42" label="Övrig momsfri försäljning m.m." amount={0} baseAmount={data.rutor.ruta42} noVat periodType={periodType} year={year} period={period} />
                        </TableBody>
                      </Table>
                    </>
                  )}

                  {/* Moms vid import */}
                  {(data.rutor.ruta50 !== 0 || data.rutor.ruta60 !== 0 || data.rutor.ruta61 !== 0 || data.rutor.ruta62 !== 0) && (
                    <>
                      <h3 className="mb-3 mt-6 font-sans text-xs font-medium text-muted-foreground">
                        Moms vid import
                      </h3>
                      <Table>
                        <TableBody>
                          <VatRutaRow ruta="50" label="Beskattningsunderlag vid import" amount={0} baseAmount={data.rutor.ruta50} noVat periodType={periodType} year={year} period={period} />
                          <VatRutaRow ruta="60" label="Utgående moms 25% import" amount={data.rutor.ruta60} baseAmount={0} periodType={periodType} year={year} period={period} />
                          <VatRutaRow ruta="61" label="Utgående moms 12% import" amount={data.rutor.ruta61} baseAmount={0} periodType={periodType} year={year} period={period} />
                          <VatRutaRow ruta="62" label="Utgående moms 6% import" amount={data.rutor.ruta62} baseAmount={0} periodType={periodType} year={year} period={period} />
                        </TableBody>
                      </Table>
                    </>
                  )}
                </div>
              </div>
              <div>
                {/* Ingående moms */}
                <div>
                  <h3 className="mb-3 font-sans text-xs font-medium text-muted-foreground">
                    Ingående moms (avdragsgill)
                  </h3>
                  <Table>
                    <TableBody>
                      <VatRutaRow
                        ruta="48"
                        label="Ingående moms att dra av"
                        amount={data.rutor.ruta48}
                        baseAmount={0}
                        periodType={periodType}
                        year={year}
                        period={period}
                      />
                      {data.breakdown.transactions.ruta48 > 0 && (
                        <tr className="text-muted-foreground">
                          <td className="py-1 pl-6 text-xs">- från transaktioner</td>
                          <td className="py-1 text-right text-xs">
                            {formatAmount(data.breakdown.transactions.ruta48)} kr
                          </td>
                        </tr>
                      )}
                      {data.breakdown.receipts.ruta48 > 0 && (
                        <tr className="text-muted-foreground">
                          <td className="py-1 pl-6 text-xs">- från kvitton</td>
                          <td className="py-1 text-right text-xs">
                            {formatAmount(data.breakdown.receipts.ruta48)} kr
                          </td>
                        </tr>
                      )}
                    </TableBody>
                    <tfoot>
                      <tr className="border-t font-medium">
                        <td className="py-2">Summa ingående moms</td>
                        <td className="py-2 text-right tabular-nums">{formatAmount(data.rutor.ruta48)} kr</td>
                      </tr>
                    </tfoot>
                  </Table>
                </div>
              </div>
            </div>

            {/* Ruta 49 as the emphasized document foot (concept skv-foot),
                as filed: every ruta in whole kronor and 49 their net
                (buildFiledAmounts), the figure the PDF, the eSKD file, the
                Skatteverket integration and the momsverifikat all carry. */}
            <div className="mt-8 flex items-baseline gap-3 border-t-2 border-foreground/80 pt-3">
              <span className="font-mono text-xs text-muted-foreground">49</span>
              <span className="flex-1 text-sm font-medium">
                {buildFiledAmounts(data.rutor).net >= 0 ? 'Moms att betala' : 'Moms att återfå'}
              </span>
              <span className="text-sm font-semibold tabular-nums">
                {formatAmount(Math.abs(buildFiledAmounts(data.rutor).net))} kr
              </span>
            </div>
            {buildFiledAmounts(data.rutor).net !== data.rutor.ruta49 && (
              <p className="mt-1 text-xs text-muted-foreground">
                Varje ruta lämnas i hela kronor (öretal faller bort) och ruta 49 är
                summan av dem. Exakt i ören: {formatAmount(Math.abs(data.rutor.ruta49))} kr.
              </p>
            )}
          </div>
            </section>
          )}

          {activeStep === 3 && (
            <section className="space-y-3">
              <VatBookingCard
              checksBlocked={checksBlocked}
              proposal={settlement.proposal}
              failed={settlement.failed}
              upToDate={settlement.upToDate}
              booked={settlement.booked}
              draft={settlement.draft}
              onRetry={() => setSettlementRefreshKey((k) => k + 1)}
              onMarkChanged={() => {
                setRetryKey((k) => k + 1)
                setSettlementRefreshKey((k) => k + 1)
              }}
              periodQuery={
                periodType === null
                  ? ''
                  : new URLSearchParams({
                      period_type: periodType,
                      year: String(year),
                      period: String(period),
                      ...(periodType === 'yearly' ? { fiscal_period_id: fiscalPeriodId } : {}),
                    }).toString()
              }
              fiscalPeriodId={isYearly ? fiscalPeriodId : undefined}
            />
            </section>
          )}

          {activeStep === 4 && (
            <section className="space-y-4">
              {/* One action row: Skicka till Skatteverket (or Anslut med
                  BankID), Ladda ner, and Markera som inlämnad or the filed
                  line, with every explanation behind the step's one "?". The
                  panel owns the Skatteverket action and its state; the rest
                  rides along in its row. */}
              <SkatteverketPanel
                periodType={periodType}
                year={year}
                period={period}
                fiscalPeriodId={isYearly ? fiscalPeriodId : undefined}
                fiscalYearEnd={
                  isYearly && fiscalPeriodEnd
                    ? {
                        year: Number(fiscalPeriodEnd.slice(0, 4)),
                        month: Number(fiscalPeriodEnd.slice(5, 7)),
                      }
                    : undefined
                }
                hasData={data !== null}
                localBlocked={checksBlocked}
                onFilingConfirmed={() => setFilingsRefreshKey((k) => k + 1)}
                actions={
                  <>
                    <VatFilingDownloadMenu
                      xmlHref={`/api/reports/vat-declaration/eskd?${vatQueryString()}`}
                      pdfHref={`/api/reports/vat-declaration/pdf?${vatQueryString()}`}
                    />
                    {/* Filing record (#2746, #2786): what makes the page
                        open the next period once this one is done, for
                        every cadence. */}
                    {periodType && (
                      <VatFilingStatusCard
                        periodType={periodType}
                        year={year}
                        period={period}
                        fiscalYearEndMonth={fiscalYearEndMonth}
                        periodLabel={filingPeriodLabel}
                        record={filingRecord}
                        canWrite={canWrite}
                        onChanged={() => setFilingsRefreshKey((k) => k + 1)}
                      />
                    )}
                  </>
                }
                help={<VatFilingHelp markPrompt={tReports('vat_filing_prompt')} />}
              />
              {/* Filed with moms to pay: pay it in to the skattekonto from the
                  bank, where bank payments are switched on (crm#1260). */}
              {periodType && filingRecord && canWrite && buildFiledAmounts(data.rutor).net > 0 && (
                <PayDeclarationViaBankButton
                  source={{
                    source: 'vat_declaration',
                    period_type: periodType,
                    year,
                    period,
                    ...(isYearly && fiscalPeriodId ? { fiscal_period_id: fiscalPeriodId } : {}),
                  }}
                  sourceLabel={filingPeriodLabel}
                  prompt={tPay('vat_to_pay', { amount: formatAmount(buildFiledAmounts(data.rutor).net) })}
                  variant="outline"
                />
              )}
            </section>
          )}
          {/* The step's bar (V7 guided steps): fixed to the bottom, the way
              on as the one filled button. Each step's own action (Korrigera,
              Bokför momsen, Skicka) stays with its content above; on step 3
              the way on is quiet until the VAT is booked, so the booking
              stays the filled button there. Step 4 ends the sequence. */}
          {activeStep < 4 && (
            <StepBar note={tReports('step_of', { current: activeStep, total: 4 })}>
              <Button
                variant={activeStep === 3 && !settlement.booked ? 'outline' : 'default'}
                onClick={() => setChosenStep(activeStep + 1)}
              >
                {activeStep === 1
                  ? 'Nästa: Granska deklarationen'
                  : activeStep === 2
                    ? 'Nästa: Bokför momsen'
                    : 'Nästa: Lämna in'}
              </Button>
            </StepBar>
          )}
        </div>
      )}

      {/* Skatteverket integration panel for the no-data states (fetch error,
          empty period): with data it lives inside steg 4. Hidden while the
          räkenskapsår for helårsmoms is unresolved, so its actions can never
          target an unconfirmed period. Out of the stepper the row needs its
          own label, which the panel no longer draws. */}
      {!awaitingFiscalPeriod && !data && SKATTEVERKET_DIRECT_FILING && (
        <section className="space-y-3">
          <h3 className="px-1 font-sans text-xs font-medium text-muted-foreground">
            Skatteverket
          </h3>
          <SkatteverketPanel
            periodType={periodType}
            year={year}
            period={period}
            fiscalPeriodId={isYearly ? fiscalPeriodId : undefined}
            fiscalYearEnd={
              isYearly && fiscalPeriodEnd
                ? {
                    year: Number(fiscalPeriodEnd.slice(0, 4)),
                    month: Number(fiscalPeriodEnd.slice(5, 7)),
                  }
                : undefined
            }
            hasData={data !== null}
            localBlocked={checksBlocked}
            onFilingConfirmed={() => setFilingsRefreshKey((k) => k + 1)}
          />
        </section>
      )}
    </div>
    </VatDrillContext.Provider>
  )
}

function makeVatFetcher(
  ruta: string,
  periodType: VatPeriodType,
  year: number,
  period: number,
  fiscalPeriodId?: string,
): ReportSourceFetcher {
  return async () => {
    const params = new URLSearchParams({
      periodType,
      year: String(year),
      period: String(period),
    })
    // Yearly drill-down resolves against the räkenskapsår, matching the report.
    if (periodType === 'yearly' && fiscalPeriodId) {
      params.set('fiscal_period_id', fiscalPeriodId)
    }
    const res = await fetch(
      `/api/reports/vat-declaration/ruta/${encodeURIComponent(ruta)}/sources?${params.toString()}`
    )
    const json = await res.json()
    if (!res.ok) throw new Error(getErrorMessage(json, { fallback: 'Kunde inte hämta verifikat' }))
    const lines: ReportSourceLine[] = json.data?.lines || []
    return { lines, next_cursor: json.data?.next_cursor ?? null }
  }
}

function VatRutaRow({
  ruta,
  label,
  amount,
  baseAmount,
  noVat,
  periodType,
  year,
  period,
}: {
  ruta: string
  label: string
  amount: number
  baseAmount: number
  noVat?: boolean
  periodType?: VatPeriodType
  year?: number
  period?: number
}) {
  const { fiscalPeriodId } = React.useContext(VatDrillContext)
  const canDrill = periodType !== undefined && year !== undefined && period !== undefined
  const fetcher = React.useMemo(
    () => (canDrill ? makeVatFetcher(ruta, periodType!, year!, period!, fiscalPeriodId) : null),
    [canDrill, ruta, periodType, year, period, fiscalPeriodId]
  )
  // Hooks must be called unconditionally: provide a noop fetcher when drill
  // is disabled. The early-return for zero rows lives below the hooks.
  const expansion = useReportRowExpansion(
    fetcher ?? (async () => ({ lines: [], next_cursor: null })),
    `vat-${ruta}`
  )

  // Don't show rows with zero values
  if (baseAmount === 0 && amount === 0) return null

  return (
    <>
      <tr className="border-b">
        <td className="py-2">
          {canDrill && (
            <span className="inline-block align-middle mr-1">
              {expansion.toggle}
            </span>
          )}
          <span className="font-mono text-xs bg-muted px-1 rounded-sm mr-2">{ruta}</span>
          {label}
        </td>
        <td className="py-2 text-right tabular-nums">{noVat ? `${formatAmount(baseAmount)} kr` : `${formatAmount(amount)} kr`}</td>
      </tr>
      {!noVat && baseAmount > 0 && (
        <tr className="text-muted-foreground">
          <td className="py-1 pl-6 text-xs">Underlag</td>
          <td className="py-1 text-right text-xs tabular-nums">{formatAmount(baseAmount)} kr</td>
        </tr>
      )}
      {canDrill && expansion.panel(2)}
    </>
  )
}
