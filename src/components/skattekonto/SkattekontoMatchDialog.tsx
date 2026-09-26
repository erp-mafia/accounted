'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useToast } from '@/components/ui/use-toast'
import { formatCurrency, formatDate } from '@/lib/utils'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import type { StoredSkattekontoTransaction } from '@/types/skatteverket'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

interface MatchCandidate {
  journal_entry_id: string
  voucher_number: number | null
  voucher_series: string | null
  entry_date: string
  description: string
  status: 'draft' | 'posted' | 'reversed'
  matched_amount: number
  matched_side: 'debit' | 'credit'
  /** Other open rows that settle this verifikat together with this one (crm#128). */
  combined_with?: Array<{
    id: string
    transaktionsdatum: string
    transaktionstext: string
    belopp_skatteverket: number
  }>
  combined_total?: number
  /** Rows already linked to the verifikat that this row joins (crm#104). */
  joins_linked_count?: number
}

function candidateKey(c: MatchCandidate): string {
  return [c.journal_entry_id, ...(c.combined_with ?? []).map((o) => o.id)].join(':')
}

/**
 * Shared dialog for linking a skattekonto_transactions row to an existing
 * journal entry. Used by both /skattekonto and /transactions so we don't
 * have two copies of the same dialog drifting apart.
 *
 * The dialog owns its own data fetch: pass the row + open flag and it
 * handles the rest. On successful match it calls onMatched(), letting the
 * caller refresh its data.
 */
export function SkattekontoMatchDialog({
  row,
  open,
  onClose,
  onMatched,
}: {
  row: StoredSkattekontoTransaction | null
  open: boolean
  onClose: () => void
  onMatched: () => void
}) {
  const t = useTranslations('tx_skattekonto_match')
  const { toast } = useToast()
  const [candidates, setCandidates] = useState<MatchCandidate[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [submittingId, setSubmittingId] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !row) {
      setCandidates(null)
      return
    }
    let cancelled = false
    setLoading(true)
    ;(async () => {
      try {
        const res = await fetch(
          `/api/extensions/ext/skatteverket/skattekonto/transaktioner/${row.id}/match-candidates`,
        )
        const json = await res.json()
        if (cancelled) return
        if (!res.ok) {
          // Map the parsed body plus the status, never `new Error(json.error)`:
          // the Error constructor stringifies a non-string body field, and the
          // mapper would discard the route's own Swedish reason.
          toast({
            title: t('fetch_candidates_failed_title'),
            description: getUserErrorMessage(json, { statusCode: res.status }),
            variant: 'destructive',
          })
          onClose()
          return
        }
        setCandidates(json.data.candidates as MatchCandidate[])
      } catch (err) {
        if (cancelled) return
        toast({
          title: t('fetch_candidates_failed_title'),
          description: err instanceof Error ? getUserErrorMessage(err) : undefined,
          variant: 'destructive',
        })
        onClose()
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, row, toast, onClose, t])

  async function confirmMatch(candidate: MatchCandidate) {
    if (!row) return
    setSubmittingId(candidateKey(candidate))
    try {
      const res = await fetch(
        `/api/extensions/ext/skatteverket/skattekonto/transaktioner/${row.id}/match`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            journal_entry_id: candidate.journal_entry_id,
            ...(candidate.combined_with?.length
              ? { also_transaction_ids: candidate.combined_with.map((o) => o.id) }
              : {}),
          }),
        },
      )
      const json = await res.json()
      if (!res.ok) {
        toast({
          title: t('match_failed_title'),
          description: getUserErrorMessage(json, { statusCode: res.status }),
          variant: 'destructive',
        })
        return
      }
      toast({ title: t('match_success_title') })
      onMatched()
      onClose()
    } catch (err) {
      toast({
        title: t('match_failed_title'),
        description: err instanceof Error ? getUserErrorMessage(err) : undefined,
        variant: 'destructive',
      })
    } finally {
      setSubmittingId(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          {/* data-ph-mask: transaction text and amount are user data */}
          <DialogDescription data-ph-mask="">
            {row && (
              <>
                {formatDate(row.transaktionsdatum)} • {row.transaktionstext} •{' '}
                <span className="tabular-nums">
                  {formatCurrency(Number(row.belopp_skatteverket))}
                </span>
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {t('searching')}
          </p>
        )}

        {!loading && candidates && candidates.length === 0 && (
          <div className="space-y-2 py-4 text-sm">
            <p>{t('no_candidates_title')}</p>
            <p className="text-muted-foreground">
              {t.rich('no_candidates_help', {
                strong: (chunks) => <strong>{chunks}</strong>,
              })}
            </p>
          </div>
        )}

        {!loading && candidates && candidates.length > 0 && (
          <div className="max-h-[420px] overflow-y-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('th_date')}</TableHead>
                  <TableHead>{t('th_voucher')}</TableHead>
                  <TableHead>{t('th_description')}</TableHead>
                  <TableHead>{t('th_status')}</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {candidates.map(c => (
                  <TableRow key={candidateKey(c)}>
                    <TableCell className="tabular-nums">{formatDate(c.entry_date)}</TableCell>
                    <TableCell className="tabular-nums">
                      {formatVoucher(c)}
                    </TableCell>
                    <TableCell className="max-w-[260px]">
                      <span className="block truncate">{c.description}</span>
                      {c.combined_with && c.combined_with.length > 0 && (
                        /* data-ph-mask: event texts and amounts are user data */
                        <span className="mt-1 block text-xs text-muted-foreground" data-ph-mask="">
                          {t('combined_note', {
                            count: c.combined_with.length,
                            total: formatCurrency(c.combined_total ?? 0),
                          })}
                          {c.combined_with.map((o) => (
                            <span key={o.id} className="block truncate tabular-nums">
                              {formatDate(o.transaktionsdatum)} {o.transaktionstext}{' '}
                              {formatCurrency(o.belopp_skatteverket)}
                            </span>
                          ))}
                        </span>
                      )}
                      {!!c.joins_linked_count && (
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {t('joins_linked_note', { count: c.joins_linked_count })}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      {/* Chips mark exceptions: posted is the normal case. */}
                      {c.status === 'posted' ? (
                        <span className="text-muted-foreground">{t('status_posted')}</span>
                      ) : c.status === 'draft' ? (
                        <Badge variant="outline">{t('status_draft')}</Badge>
                      ) : (
                        <Badge variant="destructive">{t('status_reversed')}</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        onClick={() => confirmMatch(c)}
                        disabled={submittingId === candidateKey(c)}
                      >
                        {submittingId === candidateKey(c)
                          ? t('linking')
                          : c.combined_with?.length
                            ? t('link_group', { count: c.combined_with.length + 1 })
                            : t('link')}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t('cancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
