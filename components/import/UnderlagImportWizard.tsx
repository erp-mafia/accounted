'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Card, CardContent } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { AttnLine } from '@/components/ui/attn-line'
import { EmptyState } from '@/components/ui/empty-state'
import { TD_CLASS, TH_CLASS } from '@/components/ui/dry-table'
import { useToast } from '@/components/ui/use-toast'
import {
  DestructiveConfirmDialog,
  useDestructiveConfirm,
} from '@/components/ui/destructive-confirm-dialog'
import { FyPicker } from '@/components/common/FyPicker'
import { mapWithConcurrency } from '@/lib/concurrency'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { cn, formatDate } from '@/lib/utils'
import { FileUp, FolderUp, Loader2 } from 'lucide-react'
import type { FiscalPeriod } from '@/types'
import type {
  UnderlagPlan,
  UnderlagPlanCandidate,
  UnderlagPlanRow,
  UnderlagPlanStatus,
} from '@/lib/documents/underlag-import'

// UnderlagImportWizard
//
// Attaches a folder of receipt files to verifikat that a SIE import already
// created, by reading the source voucher reference out of each filename
// (`A31_<id>.pdf`). Deliberately NOT a step inside the SIE wizard: the receipts
// usually arrive later, from a different export, and a migration must not be
// blocked on having them ready.
//
// The plan is built from filenames alone and shown in full before anything is
// uploaded. Attaching a document to a posted verifikat makes it
// räkenskapsinformation, which cannot be re-pointed afterwards (BFL 7 kap), so
// nothing is ever attached without the user seeing exactly where it lands.
//
// The fiscal year is chosen first and every row resolves inside it. A filename
// carries no year and source systems restart voucher numbering annually, so
// `A31` names a verifikat only within a year. The year is the one piece of the
// mapping the files cannot supply, which is why the user supplies it.

type Step = 'select' | 'review' | 'result'

const ACCEPTED_TYPES = 'application/pdf,image/jpeg,image/png,image/webp'
const ACCEPTED_MIME = new Set(ACCEPTED_TYPES.split(','))

/**
 * Parallel attach requests during the final step. Same size as the
 * transactions page's batch actions: enough that a 300-file migration
 * finishes in a few minutes instead of a coffee break, small enough that a
 * laptop on hotel wifi does not choke on in-flight uploads.
 */
const ATTACH_CONCURRENCY = 4

/** Message keys per status, spelled out so next-intl keeps checking them. */
const STATUS_KEY: Record<UnderlagPlanStatus, string> = {
  matched: 'underlag_status_matched',
  needs_confirmation: 'underlag_status_needs_confirmation',
  ambiguous: 'underlag_status_ambiguous',
  period_locked: 'underlag_status_period_locked',
  no_match: 'underlag_status_no_match',
  unparsed: 'underlag_status_unparsed',
}

type Translate = (key: string, values?: Record<string, string | number>) => string

interface ReviewRow extends UnderlagPlanRow {
  /** Position in the batch: two folders can contribute the same filename. */
  id: string
  file: File
  selected: boolean
  targetId: string | null
  /** The user picked this target by hand, so the server skips the name check. */
  manual: boolean
  /** Free-text reference the user typed for a row the filename could not resolve. */
  manualRef: string
  resolving: boolean
}

interface AttachOutcome {
  file_name: string
  ok: boolean
  message?: string
}

/** Statuses whose single resolved target is safe to pre-select. */
function isPreselected(status: UnderlagPlanStatus): boolean {
  return status === 'matched'
}

function badgeVariant(status: UnderlagPlanStatus): 'secondary' | 'warning' | 'destructive' {
  if (status === 'ambiguous' || status === 'needs_confirmation') return 'warning'
  if (status === 'period_locked') return 'destructive'
  return 'secondary'
}

export default function UnderlagImportWizard() {
  const t = useTranslations('import')
  const { toast } = useToast()
  const { dialogProps, confirm } = useDestructiveConfirm()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)

  const [step, setStep] = useState<Step>('select')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fiscalPeriodId, setFiscalPeriodId] = useState<string | null>(null)
  const [fiscalPeriod, setFiscalPeriod] = useState<FiscalPeriod | null>(null)
  /**
   * The year the CURRENT plan was resolved against, snapshotted when the plan
   * was requested. Everything downstream (summary, confirm text, manual
   * re-resolution, the attach requests) reads this, never the live picker: the
   * picker can move while a preview of 2000 filenames is in flight, and a
   * confirm dialog that reads back a different year than the plan was built
   * from is worse than no confirm dialog at all.
   */
  const [planPeriod, setPlanPeriod] = useState<FiscalPeriod | null>(null)
  const [plan, setPlan] = useState<UnderlagPlan | null>(null)
  const [rows, setRows] = useState<ReviewRow[]>([])
  const [attached, setAttached] = useState(0)
  const [outcomes, setOutcomes] = useState<AttachOutcome[]>([])

  const steps: Step[] = ['select', 'review', 'result']
  const stepLabels: Record<Step, string> = {
    select: t('underlag_step_select'),
    review: t('underlag_step_review'),
    result: t('underlag_step_result'),
  }
  const currentStepIndex = steps.indexOf(step)
  const progress = ((currentStepIndex + 1) / steps.length) * 100

  const selectedRows = useMemo(
    () => rows.filter((row) => row.selected && row.targetId),
    [rows],
  )

  /**
   * Resolve filenames server-side. Only names travel: the bytes stay here.
   * The year is an explicit argument rather than read from state, so a caller
   * cannot accidentally resolve against a year the user has since changed.
   */
  const fetchPlan = useCallback(
    async (fileNames: string[], periodId: string): Promise<UnderlagPlan | null> => {
      const res = await fetch('/api/import/documents/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_names: fileNames, fiscal_period_id: periodId }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(getErrorMessage(data, { statusCode: res.status }))
        return null
      }
      return data.data as UnderlagPlan
    },
    [],
  )

  const handleFilesSelected = useCallback(
    async (fileList: FileList | File[] | null) => {
      if (!fileList || fileList.length === 0) return
      if (!fiscalPeriodId) return
      const files = Array.from(fileList)
      // Snapshot the year for this batch up front. The picker stays on screen
      // while the request is in flight, so state read afterwards may not be
      // the year the plan was built from.
      const batchPeriodId = fiscalPeriodId
      const batchPeriod = fiscalPeriod

      setError(null)
      setIsLoading(true)
      try {
        const nextPlan = await fetchPlan(
          files.map((f) => f.name),
          batchPeriodId,
        )
        if (!nextPlan) return

        setPlan(nextPlan)
        setPlanPeriod(batchPeriod)
        setRows(
          nextPlan.rows.map((row, index) => ({
            ...row,
            id: `${index}:${row.file_name}`,
            file: files[index],
            selected: isPreselected(row.status),
            // A resolved-but-locked target stays unselectable: the DB trigger
            // would refuse it, so offering the checkbox would only mislead.
            targetId: row.status === 'period_locked' ? null : row.journal_entry_id,
            manual: false,
            manualRef: '',
            resolving: false,
          })),
        )
        setStep('review')
      } catch (err) {
        setError(getErrorMessage(err))
      } finally {
        setIsLoading(false)
      }
    },
    [fetchPlan, fiscalPeriod, fiscalPeriodId],
  )

  // Folder pick (#2189): a migration's underlag arrives as one folder, and
  // Ctrl+A in the file picker is not obvious to everyone. A directory pick
  // ignores `accept` and includes every file in the tree (Thumbs.db,
  // .DS_Store, the export tool's own CSV), so keep only the document types
  // the attach route takes before planning; the plan keys on file.name, so
  // subfolders flatten harmlessly.
  const handleFolderSelected = useCallback(
    (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return
      const files = Array.from(fileList).filter(
        (f) => ACCEPTED_MIME.has(f.type) && !f.name.startsWith('.'),
      )
      if (files.length === 0) {
        setError(t('underlag_folder_no_documents'))
        return
      }
      void handleFilesSelected(files)
    },
    [handleFilesSelected, t],
  )

  const updateRow = useCallback((id: string, patch: Partial<ReviewRow>) => {
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)))
  }, [])

  /**
   * Resolve a reference the user typed for a row whose filename said nothing.
   * Goes through the same resolver as the automatic path: the user supplies the
   * verifikat reference, never a free-choice target.
   */
  const resolveManualRef = useCallback(
    async (row: ReviewRow) => {
      const ref = row.manualRef.trim()
      if (!ref || !plan) return

      updateRow(row.id, { resolving: true })
      try {
        // Resolve inside the year THIS PLAN was built against, straight from
        // the server's own echo. Reading live state here would let a row join
        // the batch from a different year than every other row in it.
        const refPlan = await fetchPlan([ref], plan.fiscal_period_id)
        const resolved = refPlan?.rows[0]
        const candidates = resolved?.candidates ?? []

        if (candidates.length === 0) {
          toast({
            title: t('underlag_manual_not_found_title'),
            description: t('underlag_manual_not_found_body', { ref }),
            variant: 'destructive',
          })
          updateRow(row.id, { resolving: false })
          return
        }

        const single = candidates.length === 1 ? candidates[0] : null
        updateRow(row.id, {
          candidates,
          resolving: false,
          // Hand-resolved: the filename itself still says nothing, so the
          // server cannot re-derive this target and the row carries an override.
          manual: true,
          targetId: single && !single.period_locked ? single.journal_entry_id : null,
          selected: Boolean(single && !single.period_locked),
          // Without this the row keeps rendering "Kan inte tolkas" while
          // sitting checked and queued for an irreversible write.
          status: single
            ? single.period_locked
              ? 'period_locked'
              : 'needs_confirmation'
            : 'ambiguous',
        })
      } catch (err) {
        updateRow(row.id, { resolving: false })
        toast({ title: t('underlag_manual_not_found_title'), description: getErrorMessage(err) })
      }
    },
    [fetchPlan, plan, t, toast, updateRow],
  )

  const runAttach = useCallback(async () => {
    if (!plan) return
    // The year is named in the confirm text on purpose: it is the one input
    // the files cannot corroborate, so it is the one worth reading back.
    const ok = await confirm({
      title: t('underlag_confirm_title'),
      description: t('underlag_confirm_body', {
        count: selectedRows.length,
        year: planPeriod?.name ?? '',
      }),
      confirmLabel: t('underlag_confirm_action'),
      variant: 'warning',
    })
    if (!ok) return

    setIsLoading(true)
    setAttached(0)
    let results: AttachOutcome[] = []

    try {
      // A small worker pool, not one-after-another: each attach is a handful
      // of serialized round trips (auth, company, plan, storage, insert), so
      // a few hundred files took ten-plus minutes in sequence (#2188). The
      // pool keeps the storage bucket and the browser bounded, the per-file
      // counter still ticks, and mapWithConcurrency preserves plan order.
      results = await mapWithConcurrency(selectedRows, ATTACH_CONCURRENCY, async (row) => {
        const formData = new FormData()
        formData.append('file', row.file)
        formData.append('journal_entry_id', row.targetId as string)
        // The year the plan was built against, echoed from the server. The
        // route refuses any target outside it, overrides included.
        formData.append('fiscal_period_id', plan.fiscal_period_id)
        if (row.manual) formData.append('override', 'true')

        let outcome: AttachOutcome
        try {
          const res = await fetch('/api/import/documents/attach', {
            method: 'POST',
            body: formData,
          })
          if (!res.ok) {
            const data = await res.json().catch(() => null)
            outcome = {
              file_name: row.file_name,
              ok: false,
              message: getErrorMessage(data, { statusCode: res.status }),
            }
          } else {
            outcome = { file_name: row.file_name, ok: true }
          }
        } catch (err) {
          outcome = { file_name: row.file_name, ok: false, message: getErrorMessage(err) }
        }

        setAttached((n) => n + 1)
        return outcome
      })
    } finally {
      // Whatever happens above, the wizard must not stay stuck "loading":
      // that state also freezes the year picker.
      setIsLoading(false)
    }

    setOutcomes(results)
    setStep('result')

    const failed = results.filter((r) => !r.ok).length
    toast({
      title: t('underlag_done_title'),
      description: t('underlag_done_body', {
        linked: results.length - failed,
        failed,
      }),
      variant: failed > 0 ? 'destructive' : 'default',
    })
  }, [confirm, plan, planPeriod, selectedRows, t, toast])

  // The fiscal year survives a reset but never a session: within one sitting
  // a migration is several batches from the same year's export, so in-state
  // carry-over is the convenience. Cross-session persistence is the hazard
  // (last-used is the wrong default for a user moving year by year), which is
  // why the picker neither restores nor writes localStorage on this surface.
  const reset = () => {
    setStep('select')
    setPlan(null)
    setPlanPeriod(null)
    setRows([])
    setOutcomes([])
    setAttached(0)
    setError(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="pt-6">
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="sm:hidden text-primary font-medium">
                {t('underlag_step_counter', {
                  current: currentStepIndex + 1,
                  total: steps.length,
                  label: stepLabels[step],
                })}
              </span>
              {steps.map((s, i) => (
                <span
                  key={s}
                  className={cn(
                    'hidden sm:inline',
                    i <= currentStepIndex ? 'text-primary font-medium' : 'text-muted-foreground',
                  )}
                >
                  {stepLabels[s]}
                </span>
              ))}
            </div>
            <Progress value={progress} className="h-2" />
          </div>
        </CardContent>
      </Card>

      {error && <AttnLine>{error}</AttnLine>}

      {step === 'select' && (
        <Card>
          <CardContent className="space-y-6 pt-6">
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>{t('underlag_intro')}</p>
              <p>{t('underlag_intro_formats')}</p>
            </div>

            <div className="space-y-2">
              <p className="text-sm">{t('underlag_year_label')}</p>
              <FyPicker
                value={fiscalPeriodId}
                onChange={(id, period) => {
                  // Ignored while a preview is in flight: that request already
                  // captured a year and the plan must not disagree with the
                  // control the user is looking at.
                  if (isLoading) return
                  setFiscalPeriodId(id)
                  setFiscalPeriod(period ?? null)
                }}
                includeAllOption={false}
                // The year is the user's assertion, so it must be the user who
                // makes it, EVERY session. Defaulting to the newest year lets
                // a 2023 batch resolve against 2026; restoring last-used is
                // aimed even worse, since a multi-year migration by definition
                // moves to a different year each round. Within one sitting,
                // reset() carries the choice across batches; nothing else does.
                requireExplicitChoice
                className={isLoading ? 'pointer-events-none opacity-60' : undefined}
              />
              <p className="text-[12.5px] leading-5 text-muted-foreground">
                {t('underlag_year_help')}
              </p>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ACCEPTED_TYPES}
              className="hidden"
              onChange={(e) => handleFilesSelected(e.target.files)}
            />
            {/* webkitdirectory is not in React's input typings but is what
                every current browser honours for a folder pick; spread so
                the attribute reaches the DOM without a type escape hatch. */}
            <input
              ref={folderInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => handleFolderSelected(e.target.files)}
              {...({ webkitdirectory: '' } as Record<string, string>)}
            />

            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={() => fileInputRef.current?.click()}
                disabled={isLoading || !fiscalPeriodId}
              >
                {isLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <FileUp className="h-4 w-4" />
                )}
                {t('underlag_pick_files')}
              </Button>
              <Button
                variant="outline"
                onClick={() => folderInputRef.current?.click()}
                disabled={isLoading || !fiscalPeriodId}
              >
                <FolderUp className="h-4 w-4" />
                {t('underlag_pick_folder')}
              </Button>
            </div>

            {/* Both the picker and the button are disabled until a year is
                chosen, and if the company has no fiscal years at all the
                picker never becomes usable. Say why rather than leave two
                dead controls on screen. */}
            {!fiscalPeriodId && (
              <p className="text-[12.5px] leading-5 text-muted-foreground">
                {t('underlag_year_required')}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {step === 'review' && plan && (
        <div className="space-y-4">
          {plan.no_source_refs && <AttnLine>{t('underlag_no_source_refs')}</AttnLine>}
          {!plan.no_source_refs && plan.summary.period_locked > 0 && (
            <AttnLine>
              {t('underlag_locked_warning', { count: plan.summary.period_locked })}
            </AttnLine>
          )}

          <p className="text-sm text-muted-foreground">
            {t('underlag_summary', {
              matched: plan.summary.matched,
              total: plan.summary.total,
              year: planPeriod?.name ?? '',
            })}
          </p>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className={cn(TH_CLASS, 'w-10')}>
                    <span className="sr-only">{t('underlag_col_include')}</span>
                  </th>
                  <th className={TH_CLASS}>{t('underlag_col_file')}</th>
                  <th className={TH_CLASS}>{t('underlag_col_ref')}</th>
                  <th className={TH_CLASS}>{t('underlag_col_target')}</th>
                </tr>
              </thead>
              <tbody className="stagger-enter">
                {rows.map((row) => (
                  <tr key={row.id} className="hover:bg-secondary/35">
                    <td className={TD_CLASS}>
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded-sm border-border"
                        checked={row.selected}
                        disabled={!row.targetId}
                        aria-label={t('underlag_col_include')}
                        onChange={(e) =>
                          updateRow(row.id, { selected: e.target.checked })
                        }
                      />
                    </td>
                    <td className={cn(TD_CLASS, 'max-w-[22rem] truncate')} title={row.file_name}>
                      {row.file_name}
                    </td>
                    <td className={cn(TD_CLASS, 'tabular-nums')}>
                      {row.parsed_ref
                        ? `${row.parsed_ref.series ?? ''}${row.parsed_ref.number}`
                        : <span className="text-muted-foreground">{t('underlag_ref_none')}</span>}
                    </td>
                    <td className={TD_CLASS}>
                      <TargetCell
                        row={row}
                        onPick={(candidate) =>
                          updateRow(row.id, {
                            targetId: candidate.journal_entry_id,
                            selected: !candidate.period_locked,
                            // Deliberately NOT `manual`: the server proposed
                            // this candidate itself, so it can re-derive it.
                            // Flagging it would switch the filename check off
                            // on exactly the rows it exists to protect.
                          })
                        }
                        onManualRefChange={(value) =>
                          updateRow(row.id, { manualRef: value })
                        }
                        onManualRefSubmit={() => resolveManualRef(row)}
                        t={t}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center gap-3">
            <Button onClick={runAttach} disabled={isLoading || selectedRows.length === 0}>
              {isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
              {isLoading
                ? t('underlag_running', { done: attached, total: selectedRows.length })
                : t('underlag_run', { count: selectedRows.length })}
            </Button>
            <Button variant="outline" onClick={reset} disabled={isLoading}>
              {t('underlag_back')}
            </Button>
          </div>
        </div>
      )}

      {step === 'result' && (
        <Card>
          <CardContent className="space-y-6 pt-6">
            <p className="text-sm">
              {t('underlag_done_body', {
                linked: outcomes.filter((o) => o.ok).length,
                failed: outcomes.filter((o) => !o.ok).length,
              })}
            </p>

            {outcomes.some((o) => !o.ok) ? (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[13px]">
                  <thead>
                    <tr>
                      <th className={TH_CLASS}>{t('underlag_col_file')}</th>
                      <th className={TH_CLASS}>{t('underlag_col_error')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {outcomes
                      .filter((o) => !o.ok)
                      .map((o, index) => (
                        <tr key={`${index}:${o.file_name}`}>
                          <td className={TD_CLASS}>{o.file_name}</td>
                          <td className={cn(TD_CLASS, 'text-muted-foreground')}>{o.message}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState
                title={t('underlag_all_ok_title')}
                description={t('underlag_all_ok_body')}
              />
            )}

            <Button onClick={reset}>{t('underlag_new_import')}</Button>
          </CardContent>
        </Card>
      )}

      <DestructiveConfirmDialog {...dialogProps} />
    </div>
  )
}

function TargetCell({
  row,
  onPick,
  onManualRefChange,
  onManualRefSubmit,
  t,
}: {
  row: ReviewRow
  onPick: (candidate: UnderlagPlanCandidate) => void
  onManualRefChange: (value: string) => void
  onManualRefSubmit: () => void
  t: Translate
}) {
  // A single candidate is shown even when it is not selectable (locked period):
  // the user needs to see WHICH verifikat the file wanted before deciding
  // whether to unlock the year.
  if (row.candidates.length === 1) {
    const only = row.candidates[0]
    return (
      <div className="flex items-center gap-2">
        <span className="tabular-nums">{only.voucher_label}</span>
        <span className="text-muted-foreground">{formatDate(only.entry_date)}</span>
        {row.status !== 'matched' && (
          <Badge variant={badgeVariant(row.status)} className="font-normal">
            {t(STATUS_KEY[row.status])}
          </Badge>
        )}
      </div>
    )
  }

  if (row.candidates.length > 1) {
    return (
      <div className="flex items-center gap-2">
        <select
          className="h-8 rounded-lg border border-border bg-background px-2 text-[13px]"
          value={row.targetId ?? ''}
          aria-label={t('underlag_col_target')}
          onChange={(e) => {
            const candidate = row.candidates.find((c) => c.journal_entry_id === e.target.value)
            if (candidate) onPick(candidate)
          }}
        >
          <option value="">{t('underlag_pick_candidate')}</option>
          {row.candidates.map((candidate) => (
            <option
              key={candidate.journal_entry_id}
              value={candidate.journal_entry_id}
              disabled={candidate.period_locked}
            >
              {candidate.voucher_label} {formatDate(candidate.entry_date)}
              {candidate.period_locked ? ` (${t('underlag_status_period_locked')})` : ''}
            </option>
          ))}
        </select>
        <Badge variant="warning" className="font-normal">
          {t('underlag_status_ambiguous')}
        </Badge>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <Input
        value={row.manualRef}
        placeholder={t('underlag_manual_placeholder')}
        aria-label={t('underlag_manual_placeholder')}
        className="h-8 w-32 text-[13px]"
        onChange={(e) => onManualRefChange(e.target.value)}
        onBlur={onManualRefSubmit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onManualRefSubmit()
          }
        }}
      />
      {row.resolving ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : (
        <Badge variant={badgeVariant(row.status)} className="font-normal">
          {t(STATUS_KEY[row.status])}
        </Badge>
      )}
    </div>
  )
}
