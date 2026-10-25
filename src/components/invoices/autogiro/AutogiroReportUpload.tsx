'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { AlertCircle, Download, FileUp } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { FileDropzone } from '@/components/ui/file-dropzone'
import { HelpPopover } from '@/components/ui/help-popover'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { QUIET_LINK_CLASS, TD_CLASS, TH_CLASS } from '@/components/ui/dry-table'
import type { ErrorLocale } from '@/lib/errors/get-error-message'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { AutogiroSection } from './AutogiroSection'
import { requestAutogiro, saveAnswerFile } from './client'
import { fileKindLabel, MANDATE_STATUS_VARIANT, REPORT_OUTCOME_VARIANT, type AutogiroT } from './labels'
import type { ReportDebitLine, ReportMandateLine, ReportResponse } from './types'

type Decision = 'approve' | 'reject'

/**
 * Ladda upp fil från Bankgirot: one drop zone for every report the bank
 * hands over (payment specification, rejected payments, mandate notices, the
 * mandate register, mandates signed in the internet bank). The route reads
 * the file first and changes nothing; "Läs in" writes it. For mandates signed
 * in the internet bank the person approves or rejects each one, and the
 * answer file for the bank is downloaded at once (it carries personal data
 * and is never stored).
 */
export function AutogiroReportUpload({ canWrite, onApplied }: { canWrite: boolean; onApplied: () => void }) {
  const t = useTranslations('autogiro')
  const locale = useLocale() as ErrorLocale
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<ReportResponse | null>(null)
  const [result, setResult] = useState<ReportResponse | null>(null)
  const [decisions, setDecisions] = useState<Record<string, Decision>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function reset() {
    setFile(null)
    setPreview(null)
    setResult(null)
    setDecisions({})
    setError(null)
  }

  async function send(target: File, apply: boolean, chosen: Record<string, Decision>) {
    setBusy(true)
    setError(null)
    const form = new FormData()
    form.append('file', target)
    form.append('apply', String(apply))
    if (apply && Object.keys(chosen).length > 0) form.append('decisions', JSON.stringify(chosen))
    const response = await requestAutogiro<ReportResponse>('/api/invoices/autogiro/reports', { method: 'POST', body: form }, locale)
    setBusy(false)
    if (!response.ok) {
      setError(response.message)
      return
    }
    if (!apply) {
      setPreview(response.data)
      setDecisions(defaultDecisions(response.data))
      return
    }
    setResult(response.data)
    if (response.data.answer_file) saveAnswerFile(response.data.answer_file)
    onApplied()
  }

  function pick(next: File) {
    reset()
    setFile(next)
    void send(next, false, {})
  }

  const shown = result ?? preview
  const hasErrors = !!preview?.issues.some((issue) => issue.severity === 'error')

  return (
    <AutogiroSection
      title={t('upload_title')}
      help={
        <HelpPopover>
          <div className="space-y-2">
            <p>{t('upload_help_kinds')}</p>
            <p>{t('upload_help_preview')}</p>
          </div>
        </HelpPopover>
      }
    >
      {!file ? (
        <FileDropzone onFile={pick} disabled={!canWrite} label={t('upload_drop_label')}>
          <div className="flex flex-col items-center gap-2 px-6 py-8 text-center text-[13px]">
            <FileUp className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
            <p>{t('upload_drop')}</p>
            <p className="max-w-xl text-[12.5px] text-muted-foreground">{t('upload_or_settle')}</p>
          </div>
        </FileDropzone>
      ) : (
        <div className="space-y-4 rounded-lg border border-border p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="font-display text-xl">
              {shown ? fileKindLabel(shown.kind, t) : t('upload_reading')}
              {result && <span className="ml-2 text-[13px] text-muted-foreground">{t('upload_applied')}</span>}
            </p>
            <p data-ph-mask="" className="text-[12.5px] text-muted-foreground">
              {file.name}
            </p>
          </div>

          {busy && !shown && (
            <div className="space-y-2" role="status" aria-label={t('upload_reading')}>
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          )}

          {error && (
            <div className="flex gap-3 rounded-lg border border-destructive/20 bg-destructive/10 p-4">
              <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-destructive" aria-hidden="true" />
              <div>
                <p className="font-medium text-destructive">{t('upload_failed')}</p>
                <p className="text-sm text-muted-foreground">{error}</p>
              </div>
            </div>
          )}

          {shown && (
            <>
              {shown.repeat && !result && <p className="text-[13px] text-muted-foreground">{t('upload_repeat')}</p>}
              <Issues issues={shown.issues} t={t} />
              {shown.debits.length > 0 && <DebitLines lines={shown.debits} t={t} />}
              {shown.mandates.length > 0 && (
                <MandateLines
                  lines={shown.mandates}
                  internetBank={shown.kind === 'internet_bank_mandates'}
                  applied={!!result}
                  decisions={decisions}
                  onDecide={(payer, decision) => setDecisions((current) => ({ ...current, [payer]: decision }))}
                  t={t}
                />
              )}
              {shown.debits.length === 0 && shown.mandates.length === 0 && (
                <p className="text-[13px] text-muted-foreground">{t('upload_nothing')}</p>
              )}
              {result && <ResultNotes result={result} t={t} />}
            </>
          )}

          <div className="flex flex-wrap gap-2">
            {preview && !result && (
              <Button
                type="button"
                loading={busy}
                disabled={hasErrors}
                title={hasErrors ? t('upload_has_errors') : undefined}
                onClick={() => void send(file, true, decisions)}
              >
                {t('upload_apply')}
              </Button>
            )}
            <Button type="button" variant="outline" disabled={busy} onClick={reset}>
              {result ? t('upload_next') : t('upload_other')}
            </Button>
          </div>
        </div>
      )}
    </AutogiroSection>
  )
}

/** The answer each internet-bank mandate gets by default: what the route offers, for those the file can answer. */
function defaultDecisions(report: ReportResponse): Record<string, Decision> {
  if (report.kind !== 'internet_bank_mandates') return {}
  const out: Record<string, Decision> = {}
  for (const line of report.mandates) {
    if (line.payer_number && line.decision && line.answerable !== false) out[line.payer_number] = line.decision
  }
  return out
}

function Issues({ issues, t }: { issues: ReportResponse['issues']; t: AutogiroT }) {
  if (issues.length === 0) return null
  const shown = issues.slice(0, 8)
  return (
    <ul className="space-y-1 text-[13px]">
      {shown.map((issue, index) => (
        <li key={`${issue.line}-${index}`} className={issue.severity === 'error' ? 'text-destructive' : 'text-attn'}>
          {issue.line > 0 ? t('upload_issue_line', { line: issue.line, message: issue.message }) : issue.message}
        </li>
      ))}
      {issues.length > shown.length && (
        <li className="text-muted-foreground">{t('upload_issue_more', { count: issues.length - shown.length })}</li>
      )}
    </ul>
  )
}

function DebitLines({ lines, t }: { lines: ReportDebitLine[]; t: AutogiroT }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            <th className={TH_CLASS}>{t('col_payer_number')}</th>
            <th className={TH_CLASS}>{t('col_invoice')}</th>
            <th className={TH_CLASS}>{t('col_date')}</th>
            <th className={cn(TH_CLASS, 'text-right')}>{t('col_amount')}</th>
            <th className={cn(TH_CLASS, 'w-full')}>{t('col_outcome')}</th>
          </tr>
        </thead>
        <tbody className="stagger-enter">
          {lines.map((line, index) => {
            const variant = REPORT_OUTCOME_VARIANT[line.outcome]
            const label = t(`outcome_${line.outcome}`)
            return (
              <tr key={`${line.payer_number}-${line.reference}-${index}`} className="transition-colors duration-150 hover:bg-secondary/35">
                <td className={cn(TD_CLASS, 'whitespace-nowrap tabular-nums')}>{line.payer_number ?? '-'}</td>
                <td className={cn(TD_CLASS, 'whitespace-nowrap tabular-nums')}>{line.invoice_number ?? '-'}</td>
                <td className={cn(TD_CLASS, 'whitespace-nowrap tabular-nums')}>{line.date ? formatDate(line.date) : '-'}</td>
                <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums')}>{formatCurrency(line.amount)}</td>
                <td className={cn(TD_CLASS, 'max-w-0')}>
                  <span className="flex min-w-0 items-baseline gap-2">
                    {variant ? (
                      <Badge variant={variant} className="shrink-0 font-normal">
                        {label}
                      </Badge>
                    ) : (
                      <span className="shrink-0 text-muted-foreground">{label}</span>
                    )}
                    {(line.status_text || line.outcome === 'unknown') && (
                      <span className="truncate text-[12.5px] text-muted-foreground" title={line.status_text ?? t('outcome_unknown_hint')}>
                        {line.status_text ?? t('outcome_unknown_hint')}
                      </span>
                    )}
                  </span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function MandateLines({
  lines,
  internetBank,
  applied,
  decisions,
  onDecide,
  t,
}: {
  lines: ReportMandateLine[]
  internetBank: boolean
  applied: boolean
  decisions: Record<string, Decision>
  onDecide: (payer: string, decision: Decision) => void
  t: AutogiroT
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            <th className={TH_CLASS}>{t('col_payer_number')}</th>
            <th className={TH_CLASS}>{t('col_payer_name')}</th>
            <th className={TH_CLASS}>{t('col_customer')}</th>
            <th className={cn(TH_CLASS, 'w-full')}>{internetBank ? t('col_answer') : t('col_status')}</th>
          </tr>
        </thead>
        <tbody className="stagger-enter">
          {lines.map((line, index) => (
            <tr key={`${line.payer_number}-${index}`} className="transition-colors duration-150 hover:bg-secondary/35">
              <td className={cn(TD_CLASS, 'whitespace-nowrap tabular-nums')}>{line.payer_number ?? '-'}</td>
              <td data-ph-mask="" className={cn(TD_CLASS, 'whitespace-nowrap')}>
                {line.payer_name ?? '-'}
              </td>
              <td className={cn(TD_CLASS, 'whitespace-nowrap')}>
                {line.customer_id ? (
                  <Link href={`/customers/${line.customer_id}`} className="hover:underline">
                    {line.customer_name ?? t('customer_unnamed')}
                  </Link>
                ) : (
                  <span className="text-attn">{t('customer_not_linked')}</span>
                )}
                {line.linked && <span className="ml-2 text-[12.5px] text-muted-foreground">{applied ? t('linked_done') : t('linked_will')}</span>}
              </td>
              <td className={cn(TD_CLASS, 'max-w-0')}>
                {internetBank ? (
                  <InternetBankAnswer line={line} applied={applied} decisions={decisions} onDecide={onDecide} t={t} />
                ) : (
                  <span className="flex min-w-0 items-baseline gap-2">
                    <MandateStatusLabel status={line.status} t={t} />
                    {line.status_text && (
                      <span className="truncate text-[12.5px] text-muted-foreground" title={line.status_text}>
                        {line.status_text}
                      </span>
                    )}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function MandateStatusLabel({ status, t }: { status: ReportMandateLine['status']; t: AutogiroT }) {
  if (!status) return <span className="shrink-0 text-muted-foreground">{t('mandate_unchanged')}</span>
  const variant = MANDATE_STATUS_VARIANT[status]
  return variant ? (
    <Badge variant={variant} className="shrink-0 font-normal">
      {t(`mandate_status_${status}`)}
    </Badge>
  ) : (
    <span className="shrink-0 text-muted-foreground">{t(`mandate_status_${status}`)}</span>
  )
}

function InternetBankAnswer({
  line,
  applied,
  decisions,
  onDecide,
  t,
}: {
  line: ReportMandateLine
  applied: boolean
  decisions: Record<string, Decision>
  onDecide: (payer: string, decision: Decision) => void
  t: AutogiroT
}) {
  const payer = line.payer_number
  // Already active here: nothing to answer.
  if (!payer || line.decision === undefined) {
    return <span className="text-muted-foreground">{t('answer_already_active')}</span>
  }
  if (line.answerable === false) {
    return <span className="text-attn">{t('answer_not_answerable')}</span>
  }
  if (applied) {
    return <span className="text-muted-foreground">{line.decision === 'approve' ? t('answer_approved') : t('answer_rejected')}</span>
  }
  const approve = (decisions[payer] ?? line.decision) === 'approve'
  return (
    <label className="inline-flex items-center gap-2">
      <Switch
        checked={approve}
        onCheckedChange={(next) => onDecide(payer, next ? 'approve' : 'reject')}
        aria-label={t('answer_approve_aria', { payer })}
      />
      <span className={approve ? undefined : 'text-destructive'}>{approve ? t('answer_approve') : t('answer_reject')}</span>
    </label>
  )
}

function ResultNotes({ result, t }: { result: ReportResponse; t: AutogiroT }) {
  const settlement = result.settlement
  return (
    <div className="space-y-2 text-[13px]">
      {settlement && settlement.matched_deposits > 0 && (
        <p>
          {t('settlement_matched', { count: settlement.matched_deposits })}
          {settlement.ready_rows > 0 && (
            <>
              {' '}
              <Link href="/transactions" className={QUIET_LINK_CLASS}>
                {t('settlement_confirm')}
              </Link>
            </>
          )}
        </p>
      )}
      {settlement && settlement.no_row > 0 && <p className="text-attn">{t('settlement_no_row', { count: settlement.no_row })}</p>}
      {settlement && settlement.ambiguous > 0 && (
        <p className="text-attn">{t('settlement_ambiguous', { count: settlement.ambiguous })}</p>
      )}
      {result.answer_file && (
        <div className="flex flex-wrap items-center gap-3">
          <p>{t('answer_file_saved')}</p>
          <Button type="button" size="sm" variant="ghost" onClick={() => saveAnswerFile(result.answer_file!)}>
            <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            {t('answer_file_again')}
          </Button>
        </div>
      )}
    </div>
  )
}
