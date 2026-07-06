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

interface MatchCandidate {
  journal_entry_id: string
  voucher_number: number | null
  voucher_series: string | null
  entry_date: string
  description: string
  status: 'draft' | 'posted' | 'reversed'
  matched_amount: number
  matched_side: 'debit' | 'credit'
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
          throw new Error(json.error || t('search_failed_default'))
        }
        setCandidates(json.data.candidates as MatchCandidate[])
      } catch (err) {
        if (cancelled) return
        toast({
          title: t('fetch_candidates_failed_title'),
          description: err instanceof Error ? err.message : undefined,
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

  async function confirmMatch(journalEntryId: string) {
    if (!row) return
    setSubmittingId(journalEntryId)
    try {
      const res = await fetch(
        `/api/extensions/ext/skatteverket/skattekonto/transaktioner/${row.id}/match`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ journal_entry_id: journalEntryId }),
        },
      )
      const json = await res.json()
      if (!res.ok) {
        throw new Error(json.error || t('match_failed_default'))
      }
      toast({ title: t('match_success_title') })
      onMatched()
      onClose()
    } catch (err) {
      toast({
        title: t('match_failed_title'),
        description: err instanceof Error ? err.message : undefined,
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
          <DialogDescription>
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
          <div className="max-h-[420px] overflow-y-auto rounded-md border">
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
                  <TableRow key={c.journal_entry_id}>
                    <TableCell className="tabular-nums">{formatDate(c.entry_date)}</TableCell>
                    <TableCell className="tabular-nums">
                      {formatVoucher(c)}
                    </TableCell>
                    <TableCell className="max-w-[260px] truncate">
                      {c.description}
                    </TableCell>
                    <TableCell>
                      {c.status === 'posted' ? (
                        <Badge variant="secondary">{t('status_posted')}</Badge>
                      ) : c.status === 'draft' ? (
                        <Badge variant="outline">{t('status_draft')}</Badge>
                      ) : (
                        <Badge variant="destructive">{t('status_reversed')}</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        onClick={() => confirmMatch(c.journal_entry_id)}
                        disabled={submittingId === c.journal_entry_id}
                      >
                        {submittingId === c.journal_entry_id ? t('linking') : t('link')}
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
