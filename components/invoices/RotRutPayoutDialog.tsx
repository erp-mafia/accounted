'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Download,
  ExternalLink,
  FileDown,
  Loader2,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ContextPicker } from '@/components/common/ContextPicker'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import { downloadFile, saveBlobToDisk } from '@/lib/browser/download-file'
import { failureDescription } from '@/lib/browser/action-failure'
import {
  getErrorMessage,
  getResponseErrorMessage,
  type ErrorLocale,
} from '@/lib/errors/get-error-message'
import { formatCurrency, formatDate } from '@/lib/utils'

type DeductionType = 'rot' | 'rut'
type RequestStatus =
  | 'generated'
  | 'submitted'
  | 'paid'
  | 'partially_paid'
  | 'rejected'
  | 'cancelled'

interface Candidate {
  invoice_id: string
  invoice_number: string | null
  customer_name: string | null
  personnummer_last4: string
  betalnings_datum: string
  pris_for_arbete: number
  begart_belopp: number
}

interface BlockedCandidate {
  invoice_id: string
  invoice_number: string | null
  customer_name: string | null
  code: string
  message: string
}

interface PayoutRequest {
  id: string
  name: string
  deduction_type: DeductionType
  status: RequestStatus
  requested_total: number | string
  decided_total: number | string | null
  file_name: string
  file_document_id: string | null
  created_at: string
  submitted_at: string | null
  decided_at: string | null
  items: Array<{
    id: string
    invoice_id: string
    requested_amount: number | string
    decided_amount: number | string | null
    invoice: { id: string; invoice_number: string | null } | null
  }>
}

interface RotRutPayoutDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  canWrite: boolean
}

const MAX_CASES_PER_FILE = 100
const SKATTEVERKET_SERVICE_URL =
  'https://www.skatteverket.se/foretag/etjansterochblanketter/allaetjanster/tjanster/rotochrutforetag.4.361dc8c15312eff6fdfca4.html'

const STATUS_VARIANT: Record<
  RequestStatus,
  'secondary' | 'outline' | 'success' | 'warning' | 'destructive'
> = {
  generated: 'warning',
  submitted: 'outline',
  paid: 'success',
  partially_paid: 'warning',
  rejected: 'destructive',
  cancelled: 'secondary',
}

export default function RotRutPayoutDialog({
  open,
  onOpenChange,
  canWrite,
}: RotRutPayoutDialogProps) {
  const t = useTranslations('invoices')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const loadSequence = useRef(0)
  const [type, setType] = useState<DeductionType>('rot')
  const [eligible, setEligible] = useState<Candidate[]>([])
  const [blocked, setBlocked] = useState<BlockedCandidate[]>([])
  const [requests, setRequests] = useState<PayoutRequest[]>([])
  const [selectedYear, setSelectedYear] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [updatingId, setUpdatingId] = useState<string | null>(null)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)

  const load = useCallback(
    async (nextType: DeductionType) => {
      const sequence = ++loadSequence.current
      setLoading(true)
      setSelectedIds(new Set())
      try {
        const [eligibleResponse, requestsResponse] = await Promise.all([
          fetch(`/api/rot-rut/eligible?type=${nextType}`),
          fetch(`/api/rot-rut/payout-requests?type=${nextType}`),
        ])
        const failedResponse = !eligibleResponse.ok
          ? eligibleResponse
          : !requestsResponse.ok
            ? requestsResponse
            : null
        if (failedResponse) {
          const description = await getResponseErrorMessage(failedResponse, 'invoice', locale)
          if (sequence !== loadSequence.current) return
          setEligible([])
          setBlocked([])
          setRequests([])
          setSelectedYear('')
          toast({ title: t('rot_rut_load_failed_title'), description, variant: 'destructive' })
          return
        }

        const eligibleBody = (await eligibleResponse.json()) as {
          data: { eligible: Candidate[]; blocked: BlockedCandidate[] }
        }
        const requestsBody = (await requestsResponse.json()) as { data: PayoutRequest[] }
        if (sequence !== loadSequence.current) return

        const nextEligible = eligibleBody.data.eligible
        const years = Array.from(
          new Set(nextEligible.map((candidate) => candidate.betalnings_datum.slice(0, 4))),
        ).sort((a, b) => b.localeCompare(a))
        setEligible(nextEligible)
        setBlocked(eligibleBody.data.blocked)
        setRequests(requestsBody.data)
        setSelectedYear(years[0] ?? '')
      } catch (error) {
        if (sequence !== loadSequence.current) return
        setEligible([])
        setBlocked([])
        setRequests([])
        setSelectedYear('')
        toast({
          title: t('rot_rut_load_failed_title'),
          description: getErrorMessage(error, { context: 'invoice', locale }),
          variant: 'destructive',
        })
      } finally {
        if (sequence === loadSequence.current) setLoading(false)
      }
    },
    [locale, t, toast],
  )

  useEffect(() => {
    if (open) void load(type)
  }, [load, open, type])

  const years = useMemo(
    () =>
      Array.from(
        new Set(eligible.map((candidate) => candidate.betalnings_datum.slice(0, 4))),
      ).sort((a, b) => b.localeCompare(a)),
    [eligible],
  )
  const visibleCandidates = useMemo(
    () =>
      eligible.filter((candidate) => candidate.betalnings_datum.startsWith(selectedYear)),
    [eligible, selectedYear],
  )
  const selectedTotal = visibleCandidates
    .filter((candidate) => selectedIds.has(candidate.invoice_id))
    .reduce((sum, candidate) => sum + Number(candidate.begart_belopp), 0)

  function changeType(nextType: DeductionType) {
    setType(nextType)
  }

  function changeYear(year: string) {
    setSelectedYear(year)
    setSelectedIds(new Set())
  }

  function toggleCandidate(invoiceId: string, checked: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (checked) {
        if (next.size >= MAX_CASES_PER_FILE) return current
        next.add(invoiceId)
      } else {
        next.delete(invoiceId)
      }
      return next
    })
  }

  function selectAllVisible() {
    const visibleIds = visibleCandidates
      .slice(0, MAX_CASES_PER_FILE)
      .map((candidate) => candidate.invoice_id)
    const allSelected = visibleIds.every((id) => selectedIds.has(id))
    setSelectedIds(allSelected ? new Set() : new Set(visibleIds))
  }

  async function generateFile() {
    if (!canWrite || generating || selectedIds.size === 0) return
    setGenerating(true)
    try {
      const response = await fetch('/api/rot-rut/payout-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deduction_type: type,
          invoice_ids: Array.from(selectedIds),
        }),
      })
      if (!response.ok) {
        toast({
          title: t('rot_rut_generate_failed_title'),
          description: await getResponseErrorMessage(response, 'invoice', locale),
          variant: 'destructive',
        })
        return
      }
      const body = (await response.json()) as {
        data: { xml: string; file_name: string; warnings: string[] }
      }
      saveBlobToDisk(
        new Blob([body.data.xml], { type: 'application/xml;charset=utf-8' }),
        body.data.file_name,
      )
      toast({
        title: t('rot_rut_generated_title'),
        description:
          body.data.warnings.length > 0
            ? body.data.warnings.join(' ')
            : t('rot_rut_generated_description'),
      })
      await load(type)
    } catch (error) {
      toast({
        title: t('rot_rut_generate_failed_title'),
        description: getErrorMessage(error, { context: 'invoice', locale }),
        variant: 'destructive',
      })
    } finally {
      setGenerating(false)
    }
  }

  async function updateRequest(requestId: string, status: 'submitted' | 'cancelled') {
    if (!canWrite || updatingId) return
    setUpdatingId(requestId)
    try {
      const response = await fetch(`/api/rot-rut/payout-requests/${requestId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      if (!response.ok) {
        toast({
          title: t('rot_rut_update_failed_title'),
          description: await getResponseErrorMessage(response, 'invoice', locale),
          variant: 'destructive',
        })
        return
      }
      toast({ title: t(status === 'submitted' ? 'rot_rut_uploaded_title' : 'rot_rut_cancelled_title') })
      await load(type)
    } catch (error) {
      toast({
        title: t('rot_rut_update_failed_title'),
        description: getErrorMessage(error, { context: 'invoice', locale }),
        variant: 'destructive',
      })
    } finally {
      setUpdatingId(null)
    }
  }

  async function downloadArchivedFile(request: PayoutRequest) {
    if (!request.file_document_id || downloadingId) return
    setDownloadingId(request.id)
    try {
      const result = await downloadFile({
        url: `/api/documents/${request.file_document_id}/inline`,
        filename: request.file_name,
        locale,
      })
      if (!result.ok) {
        toast({
          title: t('rot_rut_download_failed_title'),
          description: failureDescription(result, {
            timeout: t('rot_rut_download_timeout'),
            network: t('rot_rut_download_network'),
          }),
          variant: 'destructive',
        })
      }
    } finally {
      setDownloadingId(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader className="pr-8">
          <DialogTitle>{t('rot_rut_payout_title')}</DialogTitle>
          <DialogDescription>{t('rot_rut_payout_description')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <ContextPicker
            value={type}
            onChange={(id) => changeType(id as DeductionType)}
            triggerLabel={t(type === 'rot' ? 'rot_rut_type_rot' : 'rot_rut_type_rut')}
            ariaLabel={t('rot_rut_type_aria')}
            items={[
              { id: 'rot', label: t('rot_rut_type_rot') },
              { id: 'rut', label: t('rot_rut_type_rut') },
            ]}
            disabled={loading || generating}
          />
          {years.length > 0 && (
            <ContextPicker
              value={selectedYear}
              onChange={changeYear}
              triggerLabel={selectedYear}
              ariaLabel={t('rot_rut_year_aria')}
              items={years.map((year) => ({ id: year, label: year }))}
              disabled={loading || generating}
            />
          )}
        </div>

        {loading ? (
          <div className="space-y-3 py-2" role="status" aria-label={t('rot_rut_loading')}>
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : (
          <div className="space-y-6">
            <section className="space-y-3" aria-labelledby="rot-rut-candidates-title">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 id="rot-rut-candidates-title" className="text-sm font-medium">
                    {t('rot_rut_eligible_title')}
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    {t('rot_rut_selected_count', {
                      selected: selectedIds.size,
                      amount: formatCurrency(selectedTotal),
                    })}
                  </p>
                </div>
                {visibleCandidates.length > 0 && (
                  <Button type="button" variant="ghost" size="sm" onClick={selectAllVisible}>
                    {visibleCandidates
                      .slice(0, MAX_CASES_PER_FILE)
                      .every((candidate) => selectedIds.has(candidate.invoice_id))
                      ? t('rot_rut_clear_selection')
                      : t('rot_rut_select_all')}
                  </Button>
                )}
              </div>

              {visibleCandidates.length === 0 ? (
                <div className="rounded-lg border border-dashed p-5 text-center">
                  <p className="text-sm font-medium">{t('rot_rut_no_eligible_title')}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t('rot_rut_no_eligible_description')}
                  </p>
                </div>
              ) : (
                <div className="max-h-64 divide-y overflow-y-auto rounded-lg border">
                  {visibleCandidates.map((candidate) => {
                    const checkboxId = `rot-rut-${candidate.invoice_id}`
                    const checked = selectedIds.has(candidate.invoice_id)
                    const atLimit = selectedIds.size >= MAX_CASES_PER_FILE && !checked
                    return (
                      <label
                        key={candidate.invoice_id}
                        htmlFor={checkboxId}
                        className="flex min-h-14 cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-secondary/35"
                      >
                        <Checkbox
                          id={checkboxId}
                          checked={checked}
                          disabled={atLimit || generating || !canWrite}
                          onCheckedChange={(value) =>
                            toggleCandidate(candidate.invoice_id, value === true)
                          }
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">
                            {candidate.invoice_number ?? '-'} · {candidate.customer_name ?? '-'}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {t('rot_rut_paid_at', { date: formatDate(candidate.betalnings_datum) })}
                            {' · ****'}{candidate.personnummer_last4}
                          </span>
                        </span>
                        <span className="shrink-0 text-sm tabular-nums">
                          {formatCurrency(Number(candidate.begart_belopp))}
                        </span>
                      </label>
                    )
                  })}
                </div>
              )}

              {visibleCandidates.length > MAX_CASES_PER_FILE && (
                <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 p-3 text-xs text-muted-foreground">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning-foreground" />
                  <span>{t('rot_rut_max_cases_help', { count: MAX_CASES_PER_FILE })}</span>
                </div>
              )}

              <div className="flex justify-end">
                <Button
                  type="button"
                  onClick={generateFile}
                  disabled={!canWrite || generating || selectedIds.size === 0}
                  title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
                >
                  {generating ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <FileDown className="mr-2 h-4 w-4" />
                  )}
                  {t(generating ? 'rot_rut_generating_file' : 'rot_rut_generate_file')}
                </Button>
              </div>
            </section>

            {blocked.length > 0 && (
              <details className="rounded-lg border border-dashed px-3 py-2.5">
                <summary className="cursor-pointer text-sm font-medium">
                  {t('rot_rut_blocked_title', { count: blocked.length })}
                </summary>
                <div className="mt-3 space-y-2">
                  {blocked.map((candidate) => (
                    <div key={candidate.invoice_id} className="flex items-start gap-2 text-xs">
                      <Ban className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span>
                        <span className="font-medium text-foreground">
                          {candidate.invoice_number ?? '-'} · {candidate.customer_name ?? '-'}
                        </span>
                        <span className="block text-muted-foreground">{candidate.message}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </details>
            )}

            <section className="space-y-3 border-t pt-5" aria-labelledby="rot-rut-history-title">
              <div>
                <h2 id="rot-rut-history-title" className="text-sm font-medium">
                  {t('rot_rut_history_title')}
                </h2>
                <p className="text-xs text-muted-foreground">{t('rot_rut_upload_help')}</p>
              </div>
              {requests.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('rot_rut_history_empty')}</p>
              ) : (
                <div className="space-y-2">
                  {requests.map((request) => {
                    const isUpdating = updatingId === request.id
                    const isDownloading = downloadingId === request.id
                    return (
                      <div key={request.id} className="rounded-lg border p-3">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="truncate text-sm font-medium">{request.name}</span>
                              <Badge variant={STATUS_VARIANT[request.status]} className="font-normal">
                                {t(`rot_rut_status_${request.status}`)}
                              </Badge>
                            </div>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {t('rot_rut_history_meta', {
                                date: formatDate(request.created_at),
                                count: request.items.length,
                                amount: formatCurrency(Number(request.requested_total)),
                              })}
                            </p>
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {request.file_document_id && (
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                disabled={isDownloading}
                                onClick={() => void downloadArchivedFile(request)}
                              >
                                {isDownloading ? (
                                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Download className="mr-1.5 h-3.5 w-3.5" />
                                )}
                                {t('rot_rut_download_again')}
                              </Button>
                            )}
                            {request.status === 'generated' && canWrite && (
                              <>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  disabled={isUpdating}
                                  onClick={() => void updateRequest(request.id, 'cancelled')}
                                >
                                  {t('rot_rut_cancel_request')}
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  disabled={isUpdating}
                                  onClick={() => void updateRequest(request.id, 'submitted')}
                                >
                                  {isUpdating ? (
                                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                                  ) : (
                                    <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
                                  )}
                                  {t('rot_rut_mark_uploaded')}
                                </Button>
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
              <Button asChild type="button" variant="outline" className="w-full sm:w-auto">
                <a href={SKATTEVERKET_SERVICE_URL} target="_blank" rel="noopener noreferrer">
                  {t('rot_rut_skatteverket_link')}
                  <ExternalLink className="ml-2 h-3.5 w-3.5" />
                </a>
              </Button>
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
