'use client'

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { VoucherLinesTable, type VoucherTableLine } from '@/components/bookkeeping/VoucherLinesTable'
import { voucherLineViews, type PostingLineLike, type VoucherLineView } from '@/lib/bookkeeping/voucher-line-view'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { REMEASURE_AVGIFTER_LINE_TEXT, REMEASURE_LINE_TEXT } from '@/lib/salary/vacation-liability-plan'
import { formatCurrency, formatDate } from '@/lib/utils'

/**
 * The cost lines split per dimensions bag, so the same account can stand
 * twice: the bag's codes after the account tell the two apart. The line
 * texts only repeat the verifikat's subject and are left out.
 */
function withDimensionTags(lines: VoucherLineView[]): VoucherTableLine[] {
  return lines.map((line) => {
    const codes = Object.values(line.dimensions ?? {}).filter(Boolean)
    return codes.length > 0
      ? { ...line, extra: <span className="text-muted-foreground">{codes.join(' · ')}</span> }
      : line
  })
}

/** What the dialog body shows: the preview it confirms, or why it cannot. */
export type VacationLiabilityConfirmState =
  | { kind: 'loading' }
  | { kind: 'refused'; message: string }
  | {
      kind: 'ready'
      description: ReactNode
      lines: readonly PostingLineLike[]
      confirmLabel: string
      /** A refusal of the last confirm (a lock set meanwhile), shown above the buttons. */
      error?: string | null
    }

interface VacationLiabilityConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  state: VacationLiabilityConfirmState
  confirming: boolean
  onConfirm: () => void
}

/**
 * The semesterlöneskuld's confirm (UI conventions 10 and 13): a centered
 * dialog stating the outcome up front, the verifikat's lines in the shared
 * read-only kontering table, and one primary button. A refusal (a locked
 * period) is the engine's own sentence and nothing else. Presentational: the
 * containers below fetch and post.
 */
export function VacationLiabilityConfirmDialog({
  open,
  onOpenChange,
  title,
  state,
  confirming,
  onConfirm,
}: VacationLiabilityConfirmDialogProps) {
  const tCommon = useTranslations('common')
  return (
    <Dialog open={open} onOpenChange={(next) => !confirming && onOpenChange(next)}>
      <DialogContent className="sm:min-w-[460px] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-display text-lg tracking-tight">{title}</DialogTitle>
          {state.kind === 'ready' && (
            <DialogDescription data-ph-mask="" className="text-[13px] leading-relaxed">
              {state.description}
            </DialogDescription>
          )}
          {state.kind === 'refused' && (
            <DialogDescription className="text-[13px] leading-relaxed text-destructive">{state.message}</DialogDescription>
          )}
        </DialogHeader>
        {state.kind === 'loading' && (
          <div className="space-y-2" aria-busy="true">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-4 w-full" />
            ))}
          </div>
        )}
        {state.kind === 'ready' && state.lines.length > 0 && (
          <div className="overflow-x-auto" data-ph-mask="">
            <VoucherLinesTable
              withCurrency
              showTotals
              lines={withDimensionTags(voucherLineViews(state.lines))}
              redundantTexts={[REMEASURE_LINE_TEXT, REMEASURE_AVGIFTER_LINE_TEXT]}
            />
          </div>
        )}
        {state.kind === 'ready' && state.error && (
          <p className="text-[13px] text-destructive" role="alert">
            {state.error}
          </p>
        )}
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={confirming}>
            {tCommon('cancel')}
          </Button>
          {state.kind === 'ready' && (
            <Button onClick={onConfirm} loading={confirming}>
              {state.confirmLabel}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The dry run's preview of a remeasurement (lib/salary/vacation-liability-reconcile.ts reconcilePreview). */
export interface RemeasurePreview {
  as_of: string
  would_post: boolean
  computed_liability: number
  computed_avgifter: number
  difference_2920: number
  difference_2940: number
  lines: PostingLineLike[]
}

type ApiResult = { data?: { preview?: Record<string, unknown>; preview_token?: string }; error?: unknown }

async function postJson(url: string, body: Record<string, unknown>): Promise<{ ok: boolean; json: ApiResult }> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const json = (await res.json().catch(() => ({}))) as ApiResult
  return { ok: res.ok && !json.error, json }
}

/**
 * The fetch-preview-then-commit cycle both containers share: on open, the
 * dry run; on confirm, the commit with the preview's token (refused with
 * PREVIEW_STALE when the books moved, which shows the fresh preview).
 */
function usePinnedConfirm<P>(args: {
  open: boolean
  url: string
  body: Record<string, unknown>
  toState: (preview: P) => VacationLiabilityConfirmState
  onDone: () => void
  onOpenChange: (open: boolean) => void
}) {
  const locale = useLocale() as ErrorLocale
  const tReports = useTranslations('reports')
  const [state, setState] = useState<VacationLiabilityConfirmState>({ kind: 'loading' })
  const [token, setToken] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const { open, url, body, toState, onDone, onOpenChange } = args
  const bodyKey = JSON.stringify(body)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setState({ kind: 'loading' })
    setToken(null)
    void postJson(url, { ...JSON.parse(bodyKey), dry_run: true })
      .then(({ ok, json }) => {
        if (cancelled) return
        if (!ok || !json.data?.preview) {
          setState({ kind: 'refused', message: getErrorMessage(json, { locale }) })
          return
        }
        setToken(json.data.preview_token ?? null)
        setState(toState(json.data.preview as P))
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'refused', message: tReports('ss_reconcile_error') })
      })
    return () => {
      cancelled = true
    }
    // toState and the translators are stable for the open dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, url, bodyKey])

  const confirm = useCallback(async () => {
    if (state.kind !== 'ready' || !token) return
    setConfirming(true)
    try {
      const { ok, json } = await postJson(url, { ...JSON.parse(bodyKey), preview_token: token })
      if (ok) {
        onOpenChange(false)
        onDone()
        return
      }
      const details = (json.error as { details?: { preview?: P; preview_token?: string } } | undefined)?.details
      if ((json.error as { code?: string } | undefined)?.code === 'PREVIEW_STALE' && details?.preview && details.preview_token) {
        setToken(details.preview_token)
        setState({ ...(toState(details.preview) as Extract<VacationLiabilityConfirmState, { kind: 'ready' }>), error: tReports('ss_reconcile_stale') })
        return
      }
      setState({ ...state, error: getErrorMessage(json, { locale }) })
    } catch {
      setState({ ...state, error: tReports('ss_reconcile_error') })
    } finally {
      setConfirming(false)
    }
  }, [state, token, url, bodyKey, onOpenChange, onDone, toState, locale, tReports])

  return { state, confirming, confirm }
}

/**
 * "Stäm av" from the Semesterskuld report: books the difference between the
 * computed liability and 2920/2940 as one verifikat per `asOf`.
 */
export function ReconcileVacationLiabilityDialog({
  open,
  onOpenChange,
  asOf,
  onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  asOf: string
  onDone: () => void
}) {
  const tReports = useTranslations('reports')
  const toState = useCallback(
    (preview: RemeasurePreview): VacationLiabilityConfirmState =>
      preview.would_post
        ? {
            kind: 'ready',
            description: tReports('ss_reconcile_outcome', {
              date: formatDate(preview.as_of),
              amount: formatCurrency(preview.computed_liability + preview.computed_avgifter),
            }),
            lines: preview.lines,
            confirmLabel: tReports('ss_reconcile_confirm'),
          }
        : { kind: 'refused', message: tReports('ss_reconcile_nothing') },
    [tReports],
  )
  const { state, confirming, confirm } = usePinnedConfirm<RemeasurePreview>({
    open,
    url: '/api/salary/vacation-liability/reconcile',
    body: { as_of: asOf },
    toState,
    onDone,
    onOpenChange,
  })
  return (
    <VacationLiabilityConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={tReports('ss_reconcile_title')}
      state={state}
      confirming={confirming}
      onConfirm={() => void confirm()}
    />
  )
}

/** The method switch's dry run (setVacationLiabilityMethod). */
interface MethodPreview {
  method: 'accrual' | 'remeasure'
  catch_up: RemeasurePreview | null
}

/**
 * The salary settings row's confirm: switching to booking the liability at
 * every run first books the catch-up (shown with its amount, date and
 * lines); switching back books nothing.
 */
export function VacationLiabilityMethodDialog({
  open,
  onOpenChange,
  method,
  onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  method: 'accrual' | 'remeasure'
  onDone: (method: 'accrual' | 'remeasure') => void
}) {
  const tSettings = useTranslations('settings_salary')
  const toState = useCallback(
    (preview: MethodPreview): VacationLiabilityConfirmState => {
      if (preview.method === 'accrual') {
        return { kind: 'ready', description: tSettings('vacation_liability_to_accrual'), lines: [], confirmLabel: tSettings('vacation_liability_switch') }
      }
      const catchUp = preview.catch_up
      if (!catchUp?.would_post) {
        return { kind: 'ready', description: tSettings('vacation_liability_to_remeasure_nothing'), lines: [], confirmLabel: tSettings('vacation_liability_switch') }
      }
      return {
        kind: 'ready',
        description: tSettings('vacation_liability_to_remeasure', {
          date: formatDate(catchUp.as_of),
          amount: formatCurrency(catchUp.computed_liability + catchUp.computed_avgifter),
        }),
        lines: catchUp.lines,
        confirmLabel: tSettings('vacation_liability_book_and_switch'),
      }
    },
    [tSettings],
  )
  const { state, confirming, confirm } = usePinnedConfirm<MethodPreview>({
    open,
    url: '/api/salary/vacation-liability/method',
    body: { method },
    toState,
    onDone: () => onDone(method),
    onOpenChange,
  })
  return (
    <VacationLiabilityConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={method === 'remeasure' ? tSettings('vacation_liability_title_remeasure') : tSettings('vacation_liability_title_accrual')}
      state={state}
      confirming={confirming}
      onConfirm={() => void confirm()}
    />
  )
}
