'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import dynamic from 'next/dynamic'
import { AlertTriangle, Download, FileDown, FileUp, Loader2, Receipt } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/ui/page-header'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { TH_CLASS, TD_CLASS, QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import {
  DestructiveConfirmDialog,
  useDestructiveConfirm,
} from '@/components/ui/destructive-confirm-dialog'
import { useToast } from '@/components/ui/use-toast'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { downloadFile } from '@/lib/browser/download-file'
import { failureDescription } from '@/lib/browser/action-failure'
import {
  getErrorMessage,
  getResponseErrorMessage,
  type ErrorLocale,
} from '@/lib/errors/get-error-message'
import { computeRefusedShares } from '@/lib/invoices/rot-rut-reclaim'
import { expectedRotRutPayoutAmount } from '@/lib/invoices/rot-rut-payout-matching'
import { formatCurrency, formatDate } from '@/lib/utils'
import { todayIsoStockholm } from '@/lib/dates/iso'

const RotRutPayoutDialog = dynamic(() => import('@/components/invoices/RotRutPayoutDialog'), {
  ssr: false,
})

type RequestStatus = 'generated' | 'submitted' | 'paid' | 'partially_paid' | 'rejected' | 'cancelled'

interface RequestItem {
  id: string
  invoice_id: string
  requested_amount: number | string
  decided_amount: number | string | null
  reclaimed_amount: number | string | null
  invoice: { id: string; invoice_number: string | null; status: string; remaining_amount: number | string } | null
}

interface PayoutRequest {
  id: string
  name: string
  deduction_type: 'rot' | 'rut'
  status: RequestStatus
  requested_total: number | string
  decided_total: number | string | null
  file_name: string
  file_document_id: string | null
  created_at: string
  submitted_at: string | null
  decided_at: string | null
  settlement_journal_entry_id: string | null
  reclaim_journal_entry_id: string | null
  reclaimed_at: string | null
  skv_referensnummer: string | null
  items: RequestItem[]
}

interface BeslutImportResult {
  imported: number
  already_imported: number
  errors: number
  results: Array<{ namn: string; status: string; error?: string }>
}

const STATUS_VARIANT: Record<RequestStatus, 'secondary' | 'outline' | 'success' | 'warning' | 'destructive'> = {
  generated: 'warning',
  submitted: 'outline',
  paid: 'success',
  partially_paid: 'warning',
  rejected: 'destructive',
  cancelled: 'secondary',
}

/** Days between an ISO timestamp and now, floored at 0. */
function daysSince(iso: string): number {
  const ms = Date.now() - new Date(iso).getTime()
  return Math.max(0, Math.floor(ms / 86_400_000))
}


/**
 * Refused share and whether it still needs its reclaim voucher. An invoice
 * re-requested in a later live begäran (avslag → new file) is being reviewed
 * again, so its refused share stays at Skatteverket: no reclaim offered, the
 * same rule the reclaim route enforces.
 */
function refusedState(
  request: PayoutRequest,
  allRequests: PayoutRequest[],
): { refused: number; needsReclaim: boolean; splitUnknown: boolean; rerequested: boolean } {
  const computed = computeRefusedShares(request, request.items)
  if (!computed.ok) {
    return {
      refused: 0,
      needsReclaim: false,
      splitUnknown: computed.code === 'ROT_RUT_RECLAIM_SPLIT_UNKNOWN',
      rerequested: false,
    }
  }
  const ownInvoices = new Set(request.items.map((item) => item.invoice_id))
  const rerequested = allRequests.some(
    (other) =>
      other.id !== request.id &&
      other.status !== 'cancelled' &&
      other.status !== 'rejected' &&
      other.items.some((item) => ownInvoices.has(item.invoice_id)),
  )
  return {
    refused: computed.total,
    needsReclaim: computed.total > 0 && !request.reclaim_journal_entry_id && !rerequested,
    splitUnknown: false,
    rerequested,
  }
}

export default function RotRutOverviewPage() {
  const t = useTranslations('rot_rut_overview')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const { canWrite } = useCanWrite()
  const router = useRouter()
  const searchParams = useSearchParams()
  const { dialogProps, confirm } = useDestructiveConfirm()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const loadSequence = useRef(0)

  const [requests, setRequests] = useState<PayoutRequest[]>([])
  const [eligibleCounts, setEligibleCounts] = useState<{ rot: number; rut: number }>({ rot: 0, rut: 0 })
  const [isLoading, setIsLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)

  // The file dialog is driven by ?new=1 so the browser back button closes it
  // (same pattern as /invoices and /invoices/recurring).
  const showNewRequest = searchParams.has('new')
  const openNewRequest = () => router.push('/invoices/rot-rut?new=1', { scroll: false })
  const closeNewRequest = () => router.replace('/invoices/rot-rut', { scroll: false })

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current
    setIsLoading(true)
    try {
      const [requestsRes, rotRes, rutRes] = await Promise.all([
        fetch('/api/rot-rut/payout-requests'),
        fetch('/api/rot-rut/eligible?type=rot'),
        fetch('/api/rot-rut/eligible?type=rut'),
      ])
      if (!requestsRes.ok) {
        const description = await getResponseErrorMessage(requestsRes, 'invoice', locale)
        if (sequence !== loadSequence.current) return
        toast({ title: t('load_failed_title'), description, variant: 'destructive' })
        setRequests([])
        return
      }
      const body = (await requestsRes.json()) as { data: PayoutRequest[] }
      const rot = rotRes.ok ? ((await rotRes.json()) as { data: { eligible: unknown[] } }).data.eligible.length : 0
      const rut = rutRes.ok ? ((await rutRes.json()) as { data: { eligible: unknown[] } }).data.eligible.length : 0
      if (sequence !== loadSequence.current) return
      setRequests(body.data)
      setEligibleCounts({ rot, rut })
    } catch (error) {
      if (sequence !== loadSequence.current) return
      toast({
        title: t('load_failed_title'),
        description: getErrorMessage(error, { context: 'invoice', locale }),
        variant: 'destructive',
      })
    } finally {
      if (sequence === loadSequence.current) setIsLoading(false)
    }
  }, [locale, t, toast])

  useEffect(() => {
    void load()
  }, [load])

  const summary = useMemo(() => {
    let atSkv = 0
    let awaitingDecision = 0
    let refusedOpen = 0
    let refusedOpenCount = 0
    for (const request of requests) {
      if (request.status === 'cancelled') continue
      const state = refusedState(request, requests)
      if (state.needsReclaim) {
        refusedOpen += state.refused
        refusedOpenCount += 1
      }
      if (request.status === 'rejected') continue
      if (!request.settlement_journal_entry_id) {
        atSkv += expectedRotRutPayoutAmount(request)
        if (!request.decided_at) awaitingDecision += 1
      }
    }
    return { atSkv: Math.round(atSkv * 100) / 100, awaitingDecision, refusedOpen: Math.round(refusedOpen * 100) / 100, refusedOpenCount }
  }, [requests])

  async function patchRequest(request: PayoutRequest, status: 'submitted' | 'cancelled') {
    if (!canWrite || busyId) return
    setBusyId(request.id)
    try {
      const response = await fetch(`/api/rot-rut/payout-requests/${request.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      if (!response.ok) {
        toast({
          title: t('update_failed_title'),
          description: await getResponseErrorMessage(response, 'invoice', locale),
          variant: 'destructive',
        })
        return
      }
      toast({ title: t(status === 'submitted' ? 'uploaded_title' : 'cancelled_title') })
      await load()
    } catch (error) {
      toast({
        title: t('update_failed_title'),
        description: getErrorMessage(error, { context: 'invoice', locale }),
        variant: 'destructive',
      })
    } finally {
      setBusyId(null)
    }
  }

  async function reclaim(request: PayoutRequest) {
    if (!canWrite || busyId) return
    const state = refusedState(request, requests)
    const confirmed = await confirm({
      title: t('reclaim_confirm_title'),
      description: t('reclaim_confirm_description', {
        amount: formatCurrency(state.refused),
        count: request.items.length,
        name: request.name,
      }),
      confirmLabel: t('reclaim_confirm_action'),
      variant: 'warning',
    })
    if (!confirmed) return
    setBusyId(request.id)
    try {
      const response = await fetch(`/api/rot-rut/payout-requests/${request.id}/reclaim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The booking date is a Swedish calendar day (fiscal periods are), not
        // the browser's UTC date.
        body: JSON.stringify({ booking_date: todayIsoStockholm() }),
      })
      if (!response.ok) {
        toast({
          title: t('reclaim_failed_title'),
          description: await getResponseErrorMessage(response, 'invoice', locale),
          variant: 'destructive',
        })
        return
      }
      const body = (await response.json()) as {
        data: { reclaimed_total: number; invoices: Array<{ invoice_id: string }> }
      }
      toast({
        title: t('reclaim_done_title'),
        description: t('reclaim_done_description', {
          amount: formatCurrency(body.data.reclaimed_total),
          count: body.data.invoices.length,
        }),
      })
      await load()
    } catch (error) {
      toast({
        title: t('reclaim_failed_title'),
        description: getErrorMessage(error, { context: 'invoice', locale }),
        variant: 'destructive',
      })
    } finally {
      setBusyId(null)
    }
  }

  async function importBeslut(file: File) {
    if (!canWrite || importing) return
    setImporting(true)
    try {
      let parsed: unknown
      try {
        parsed = JSON.parse(await file.text())
      } catch {
        toast({ title: t('import_failed_title'), description: t('import_invalid_json'), variant: 'destructive' })
        return
      }
      const response = await fetch('/api/rot-rut/beslut/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed),
      })
      if (!response.ok) {
        toast({
          title: t('import_failed_title'),
          description: await getResponseErrorMessage(response, 'invoice', locale),
          variant: 'destructive',
        })
        return
      }
      const body = (await response.json()) as { data: BeslutImportResult }
      const failed = body.data.results.filter((r) => r.status === 'error')
      toast({
        title: t('import_done_title'),
        description:
          t('import_done_description', {
            imported: body.data.imported,
            already: body.data.already_imported,
            errors: body.data.errors,
          }) + (failed.length > 0 ? ' ' + failed.map((r) => `${r.namn}: ${r.error ?? ''}`).join(' ') : ''),
        variant: body.data.errors > 0 && body.data.imported === 0 ? 'destructive' : undefined,
      })
      await load()
    } catch (error) {
      toast({
        title: t('import_failed_title'),
        description: getErrorMessage(error, { context: 'invoice', locale }),
        variant: 'destructive',
      })
    } finally {
      setImporting(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  async function downloadArchivedFile(request: PayoutRequest) {
    if (!request.file_document_id || busyId) return
    setBusyId(request.id)
    try {
      const result = await downloadFile({
        url: `/api/documents/${request.file_document_id}/inline`,
        filename: request.file_name,
        locale,
      })
      if (!result.ok) {
        toast({
          title: t('download_failed_title'),
          description: failureDescription(result, {
            timeout: t('download_timeout'),
            network: t('download_network'),
          }),
          variant: 'destructive',
        })
      }
    } finally {
      setBusyId(null)
    }
  }

  const readyCount = eligibleCounts.rot + eligibleCounts.rut

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('title')}
        description={t('description')}
        action={
          <div className="flex flex-wrap gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void importBeslut(file)
              }}
            />
            <Button
              type="button"
              variant="outline"
              disabled={!canWrite || importing}
              onClick={() => fileInputRef.current?.click()}
              title={!canWrite ? t('viewer_disabled_tooltip') : t('import_beslut_help')}
            >
              {importing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileUp className="mr-2 h-4 w-4" />}
              {t('import_beslut')}
            </Button>
            <Button type="button" onClick={openNewRequest} disabled={!canWrite}>
              <FileDown className="mr-2 h-4 w-4" />
              {t('new_request')}
            </Button>
          </div>
        }
      />

      {/* Summary tiles: what sits at Skatteverket, what waits, what came back refused. */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border p-4">
          <p className="text-xs text-muted-foreground">{t('tile_at_skv')}</p>
          <p className="mt-1 font-display text-2xl tabular-nums">{formatCurrency(summary.atSkv)}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('tile_at_skv_help')}</p>
        </div>
        <div className="rounded-lg border p-4">
          <p className="text-xs text-muted-foreground">{t('tile_awaiting')}</p>
          <p className="mt-1 font-display text-2xl tabular-nums">{summary.awaitingDecision}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('tile_awaiting_help')}</p>
        </div>
        <div className="rounded-lg border p-4">
          <p className="text-xs text-muted-foreground">{t('tile_refused')}</p>
          <p className="mt-1 font-display text-2xl tabular-nums">{formatCurrency(summary.refusedOpen)}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('tile_refused_help', { count: summary.refusedOpenCount })}
          </p>
        </div>
        <div className="rounded-lg border p-4">
          <p className="text-xs text-muted-foreground">{t('tile_ready')}</p>
          <p className="mt-1 font-display text-2xl tabular-nums">{readyCount}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('tile_ready_help', { rot: eligibleCounts.rot, rut: eligibleCounts.rut })}
          </p>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-3" role="status" aria-label={t('loading')}>
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : requests.length === 0 ? (
        <EmptyState
          icon={Receipt}
          title={t('empty_title')}
          description={t('empty_description')}
          actionLabel={canWrite ? t('new_request') : undefined}
          onAction={canWrite ? openNewRequest : undefined}
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className={TH_CLASS}>{t('col_name')}</th>
                <th className={TH_CLASS}>{t('col_status')}</th>
                <th className={TH_CLASS}>{t('col_created')}</th>
                <th className={`${TH_CLASS} text-right`}>{t('col_requested')}</th>
                <th className={`${TH_CLASS} text-right`}>{t('col_decided')}</th>
                <th className={`${TH_CLASS} text-right`}>{t('col_refused')}</th>
                <th className={TH_CLASS}>{t('col_waiting')}</th>
                <th className={`${TH_CLASS} text-right`}>{t('col_actions')}</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((request) => {
                const state = refusedState(request, requests)
                const isBusy = busyId === request.id
                // Waiting = at Skatteverket without a beslut. A decided begäran
                // (beslutsfil imported, status may still read submitted) is
                // waiting for money, not for a decision: no counter.
                const waitingSince =
                  !request.settlement_journal_entry_id &&
                  !request.decided_at &&
                  request.status !== 'cancelled' &&
                  request.status !== 'rejected'
                    ? request.submitted_at ?? request.created_at
                    : null
                return (
                  <tr key={request.id}>
                    <td className={TD_CLASS}>
                      <details>
                        <summary className="cursor-pointer list-none">
                          <span className="font-medium">{request.name}</span>
                          <span className="ml-2 text-xs text-muted-foreground">
                            {request.deduction_type.toUpperCase()} · {t('cases', { count: request.items.length })}
                          </span>
                        </summary>
                        <ul className="mt-2 space-y-1 text-xs">
                          {request.items.map((item) => (
                            <li key={item.id} className="flex flex-wrap justify-between gap-2">
                              <Link href={`/invoices/${item.invoice_id}`} className={QUIET_LINK_CLASS}>
                                {item.invoice?.invoice_number ?? item.invoice_id.slice(0, 8)}
                              </Link>
                              <span className="tabular-nums text-muted-foreground">
                                {formatCurrency(Number(item.requested_amount))}
                                {item.decided_amount != null && ` · ${t('item_decided', { amount: formatCurrency(Number(item.decided_amount)) })}`}
                                {item.reclaimed_amount != null && Number(item.reclaimed_amount) > 0 && ` · ${t('item_reclaimed', { amount: formatCurrency(Number(item.reclaimed_amount)) })}`}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </details>
                    </td>
                    <td className={TD_CLASS}>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant={STATUS_VARIANT[request.status]} className="font-normal">
                          {t(`status_${request.status}`)}
                        </Badge>
                        {request.settlement_journal_entry_id && (
                          <Link href={`/bookkeeping/${request.settlement_journal_entry_id}`} className={`${QUIET_LINK_CLASS} text-xs`}>
                            {t('settled_link')}
                          </Link>
                        )}
                        {request.reclaim_journal_entry_id && (
                          <Link href={`/bookkeeping/${request.reclaim_journal_entry_id}`} className={`${QUIET_LINK_CLASS} text-xs`}>
                            {t('reclaimed_link')}
                          </Link>
                        )}
                      </div>
                    </td>
                    <td className={`${TD_CLASS} whitespace-nowrap`}>{formatDate(request.created_at)}</td>
                    <td className={`${TD_CLASS} text-right tabular-nums`}>{formatCurrency(Number(request.requested_total))}</td>
                    <td className={`${TD_CLASS} text-right tabular-nums`}>
                      {request.decided_total == null ? <span className="text-muted-foreground">-</span> : formatCurrency(Number(request.decided_total))}
                    </td>
                    <td className={`${TD_CLASS} text-right tabular-nums`}>
                      {state.splitUnknown ? (
                        <span className="inline-flex items-center gap-1 text-attn" title={t('split_unknown_hint')}>
                          <AlertTriangle className="h-3.5 w-3.5" />
                          {t('split_unknown')}
                        </span>
                      ) : state.refused > 0 ? (
                        <span
                          className={state.needsReclaim ? 'text-attn' : undefined}
                          title={state.rerequested ? t('rerequested_hint') : undefined}
                        >
                          {formatCurrency(state.refused)}
                          {state.rerequested && (
                            <span className="ml-1 text-xs text-muted-foreground">{t('rerequested')}</span>
                          )}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </td>
                    <td className={`${TD_CLASS} whitespace-nowrap`}>
                      {waitingSince ? t('waiting_days', { days: daysSince(waitingSince) }) : <span className="text-muted-foreground">-</span>}
                    </td>
                    <td className={`${TD_CLASS} text-right`}>
                      <div className="flex flex-wrap justify-end gap-1.5">
                        {request.file_document_id && (
                          <Button type="button" size="sm" variant="ghost" disabled={isBusy} onClick={() => void downloadArchivedFile(request)}>
                            <Download className="mr-1.5 h-3.5 w-3.5" />
                            {t('download')}
                          </Button>
                        )}
                        {request.status === 'generated' && canWrite && (
                          <>
                            <Button type="button" size="sm" variant="outline" disabled={isBusy} onClick={() => void patchRequest(request, 'cancelled')}>
                              {t('cancel_request')}
                            </Button>
                            <Button type="button" size="sm" disabled={isBusy} onClick={() => void patchRequest(request, 'submitted')}>
                              {isBusy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                              {t('mark_uploaded')}
                            </Button>
                          </>
                        )}
                        {state.needsReclaim && canWrite && (
                          <Button type="button" size="sm" disabled={isBusy} onClick={() => void reclaim(request)}>
                            {isBusy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                            {t('book_refused')}
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <DestructiveConfirmDialog {...dialogProps} />

      {showNewRequest && (
        <RotRutPayoutDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              closeNewRequest()
              void load()
            }
          }}
          canWrite={canWrite}
        />
      )}
    </div>
  )
}
