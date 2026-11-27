'use client'

import { useEffect, useState } from 'react'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import { MagnifyingGlassIcon } from '@/components/icons'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { cn, formatDate } from '@/lib/utils'

// StrikeUnderlagDialog: "Fel verifikation" on an underlag of a posted
// verifikat. The person names the verifikat the underlag belongs to and says
// why; POST /api/documents/:id/strike then gives that verifikat a
// byte-identical copy and strikes the link here with who, when and why.
// Nothing moves and nothing is deleted: the struck underlag stays on this
// verifikat, struck through, and in the archive (lib/documents/strike-link.ts).

interface Candidate {
  id: string
  voucher_series: string | null
  voucher_number: number | null
  entry_date: string
  description: string | null
}

interface Props {
  open: boolean
  onClose: () => void
  /** The underlag whose link is struck. */
  document: { id: string; file_name: string } | null
  /** The verifikat it is wrongly attached to: never offered as the right one. */
  journalEntryId: string
  /** After the strike, so the parent reads its underlag again. */
  onStruck: () => void
}

const REASON_MAX = 500

export default function StrikeUnderlagDialog({ open, onClose, document, journalEntryId, onStruck }: Props) {
  const t = useTranslations('journal_attachments')
  const errorLocale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const [search, setSearch] = useState('')
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [loading, setLoading] = useState(false)
  const [target, setTarget] = useState<Candidate | null>(null)
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open) return
    setSearch('')
    setCandidates([])
    setLoading(false)
    setTarget(null)
    setReason('')
  }, [open])

  // Posted verifikat matching the needle (a voucher label, text, an account),
  // the list's own search; nothing until one character is typed.
  const needle = search.trim()
  useEffect(() => {
    if (!open || !needle) {
      setCandidates([])
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const params = new URLSearchParams({
            status: 'posted',
            search: needle,
            limit: '8',
            include_related: 'false',
          })
          const res = await fetch(`/api/bookkeeping/journal-entries?${params.toString()}`)
          const json = (await res.json().catch(() => ({}))) as { data?: Candidate[] }
          if (cancelled) return
          setCandidates((json.data ?? []).filter((entry) => entry.id !== journalEntryId))
        } catch {
          // A failed search shows no candidates; typing again searches again.
          if (!cancelled) setCandidates([])
        } finally {
          if (!cancelled) setLoading(false)
        }
      })()
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
      // The next search (or none) decides what shows: never a spinner left
      // by one that was cancelled.
      setLoading(false)
    }
  }, [open, needle, journalEntryId])

  const canSubmit = Boolean(document && target && reason.trim()) && !submitting

  async function handleSubmit() {
    if (!document || !target || !reason.trim()) return
    setSubmitting(true)
    try {
      const res = await fetch(`/api/documents/${document.id}/strike`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ journal_entry_id: target.id, reason: reason.trim() }),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => null)
        toast({
          title: t('strike_failed'),
          description: getErrorMessage(json, { statusCode: res.status, locale: errorLocale }),
          variant: 'destructive',
        })
        return
      }
      toast({ title: t('strike_done', { voucher: formatVoucher(target) }) })
      onStruck()
      onClose()
    } catch {
      toast({ title: t('strike_failed'), variant: 'destructive' })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !submitting && onClose()}>
      <DialogContent size="wide">
        <DialogHeader>
          <DialogTitle>{t('strike_title')}</DialogTitle>
          <DialogDescription>
            {/* data-ph-mask: the file name is user data */}
            <span data-ph-mask="">{document?.file_name}</span>: {t('strike_body')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="strike-target-search">{t('strike_target_label')}</Label>
          <div className="relative">
            <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              id="strike-target-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('strike_target_placeholder')}
              className="pl-9"
              autoComplete="off"
            />
          </div>
          <div className="max-h-[35vh] overflow-y-auto divide-y" role="listbox" aria-label={t('strike_target_label')}>
            {loading ? (
              <LateReveal className="space-y-2 py-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </LateReveal>
            ) : needle && candidates.length === 0 ? (
              <p className="py-2 text-[13px] text-muted-foreground">{t('strike_target_none')}</p>
            ) : (
              candidates.map((entry) => {
                const selected = target?.id === entry.id
                return (
                  <button
                    key={entry.id}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => setTarget(entry)}
                    className={cn(
                      'w-full text-left flex items-center gap-3 py-2.5 px-2 rounded-sm transition-colors hover:bg-secondary/60',
                      selected && 'bg-secondary/60',
                    )}
                  >
                    <span className="text-sm font-medium tabular-nums shrink-0">{formatVoucher(entry)}</span>
                    <span className="text-xs text-muted-foreground tabular-nums shrink-0">{formatDate(entry.entry_date)}</span>
                    <span data-ph-mask="" className="text-sm truncate flex-1">{entry.description}</span>
                  </button>
                )
              })
            )}
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="strike-reason">{t('strike_reason_label')}</Label>
          <Textarea
            id="strike-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('strike_reason_placeholder')}
            maxLength={REASON_MAX}
            className="min-h-[72px]"
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            {t('picker_close')}
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={!canSubmit} loading={submitting}>
            {target ? t('strike_submit', { voucher: formatVoucher(target) }) : t('strike_submit_pick')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
