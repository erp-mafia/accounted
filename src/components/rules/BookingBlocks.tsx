'use client'

import { useMemo, useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { EllipsisHorizontalIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { TH_CLASS, TD_CLASS, HOVER_REVEAL_CLASS } from '@/components/ui/dry-table'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import { useToast } from '@/components/ui/use-toast'
import { useFormat } from '@/lib/hooks/use-format'
import { cn, formatCurrency } from '@/lib/utils'
import { parseAmountInput } from '@/lib/money'
import { isAccountNumber } from '@/lib/invariants'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { BOOKING_REVIEW_VAT_CLASSES, type BookingReviewRule, type BookingReviewVatClass } from '@/lib/booking-review/match'

export interface BlocksPayload {
  rules: BookingReviewRule[]
  canManage: boolean
}

export async function fetchBlocks(url: string): Promise<BlocksPayload> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} ${res.status}`)
  const json = (await res.json()) as { data?: BookingReviewRule[]; can_manage?: boolean }
  return { rules: json.data ?? [], canManage: json.can_manage === true }
}

type Translate = ReturnType<typeof useTranslations>

/** A block's criteria in plain words: "konto 6250 · Google Cloud · från 5 000 kr · utan moms". */
export function blockCriteria(t: Translate, rule: BookingReviewRule): string {
  const parts: string[] = []
  if (rule.accounts && rule.accounts.length > 0) {
    parts.push(t('accounts', { count: rule.accounts.length, accounts: rule.accounts.join(', ') }))
  }
  if (rule.counterparty_label) parts.push(rule.counterparty_label)
  if (rule.amount_from_sek !== null && rule.amount_from_sek !== undefined) {
    parts.push(t('amount_from', { amount: formatCurrency(Number(rule.amount_from_sek)) }))
  }
  if (rule.vat_treatment) parts.push(t(`vat_${rule.vat_treatment}`))
  return parts.join(' · ')
}

interface Draft {
  accounts: string
  counterparty: string
  amount: string
  vat: BookingReviewVatClass | 'any'
  note: string
}

const EMPTY_DRAFT: Draft = { accounts: '', counterparty: '', amount: '', vat: 'any', note: '' }

/** The body POST /api/rules/blocks takes, or the message key of what is wrong. */
export function draftToBody(draft: Draft): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  const accounts = draft.accounts.split(/[\s,;]+/).filter(Boolean)
  if (!accounts.every(isAccountNumber)) return { ok: false, error: 'error_accounts' }
  let amount: number | undefined
  if (draft.amount.trim()) {
    const parsed = parseAmountInput(draft.amount)
    if (parsed === null || parsed <= 0) return { ok: false, error: 'error_amount' }
    amount = parsed
  }
  const counterparty = draft.counterparty.trim()
  const note = draft.note.trim()
  if (accounts.length === 0 && !counterparty && amount === undefined && draft.vat === 'any') {
    return { ok: false, error: 'error_empty' }
  }
  return {
    ok: true,
    body: {
      ...(accounts.length > 0 ? { accounts: [...new Set(accounts)] } : {}),
      ...(counterparty ? { counterparty } : {}),
      ...(amount !== undefined ? { amount_from_sek: amount } : {}),
      ...(draft.vat !== 'any' ? { vat_treatment: draft.vat } : {}),
      ...(note ? { note } : {}),
    },
  }
}

/**
 * Spärrar (accounted#130 step 2): the company's hard blocks. A booking a
 * block matches is never booked with one click, in bulk, by a rule for
 * automatic booking or by an agent; a person books it from its review.
 * Owners and admins add and archive them; everyone else reads. Archived
 * versions stay listed behind a toggle: a block is a dated processing rule
 * (BFNAR 2013:2 p. 9.16).
 */
export default function BookingBlocks() {
  const t = useTranslations('rules.blocks')
  const { toast } = useToast()
  const { formatDateLong } = useFormat()
  const { data: payload, error, isLoading, mutate } = useSWR<BlocksPayload>('/api/rules/blocks', fetchBlocks)
  const { dialogProps, confirm } = useDestructiveConfirm()
  const [showArchived, setShowArchived] = useState(false)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const canManage = payload?.canManage ?? false
  const active = useMemo(() => (payload?.rules ?? []).filter((r) => !r.revoked_at), [payload])
  const archived = useMemo(() => (payload?.rules ?? []).filter((r) => r.revoked_reason === 'archived'), [payload])
  const rows = showArchived ? [...active, ...archived] : active

  function openForm() {
    setDraft(EMPTY_DRAFT)
    setFormError(null)
    setAdding(true)
  }

  async function save() {
    const built = draftToBody(draft)
    if (!built.ok) {
      setFormError(t(built.error))
      return
    }
    setSaving(true)
    try {
      const res = await fetch('/api/rules/blocks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(built.body),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setFormError(getErrorMessage(body, { statusCode: res.status }))
        return
      }
      setAdding(false)
      toast({ title: t('toast_added') })
      await mutate()
    } finally {
      setSaving(false)
    }
  }

  async function archive(rule: BookingReviewRule) {
    await confirm(
      {
        title: t('archive_title'),
        description: t('archive_description', { block: blockCriteria(t, rule) }),
        confirmLabel: t('archive_confirm'),
      },
      async () => {
        const res = await fetch(`/api/rules/blocks/${rule.rule_id}`, { method: 'DELETE' })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) {
          toast({ title: t('toast_failed'), description: getErrorMessage(body, { statusCode: res.status }), variant: 'destructive' })
          throw new Error('archive failed')
        }
        toast({ title: t('toast_archived') })
        await mutate()
      },
    )
  }

  return (
    <section className="stagger-enter" aria-labelledby="booking-blocks-title">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 id="booking-blocks-title" className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          {t('title')}
        </h2>
        {canManage && (
          <Button size="sm" variant="secondary" className="ml-auto" onClick={openForm}>
            {t('add')}
          </Button>
        )}
      </div>

      <div className="-mx-4 overflow-x-auto px-4 md:-mx-6 md:px-6">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <th className={cn(TH_CLASS, '!pl-0 w-full')}>{t('th_block')}</th>
              <th className={TH_CLASS}>{t('th_added')}</th>
              <th className={cn(TH_CLASS, '!pr-0')} aria-hidden="true"></th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              [1, 2].map((i) => (
                <tr key={i} aria-busy>
                  <td colSpan={3} className={cn(TD_CLASS, '!pl-0')}>
                    <Skeleton className="h-4 w-56" />
                  </td>
                </tr>
              ))
            ) : error ? (
              <tr>
                <td colSpan={3} className={cn(TD_CLASS, '!pl-0 py-8 text-muted-foreground')}>
                  {t('load_failed')}
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={3} className={cn(TD_CLASS, '!pl-0 py-8 text-muted-foreground')}>
                  {canManage ? t('empty') : t('empty_read_only')}
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr
                  key={r.id}
                  className={cn('group transition-colors duration-150 hover:bg-secondary/35', r.revoked_at && 'text-muted-foreground')}
                >
                  <td className={cn(TD_CLASS, '!pl-0 max-w-0')}>
                    <span className="block truncate" title={r.note ?? undefined}>
                      {blockCriteria(t, r)}
                      {r.note ? <span className="text-muted-foreground"> · {r.note}</span> : null}
                    </span>
                  </td>
                  <td className={cn(TD_CLASS, 'whitespace-nowrap text-muted-foreground')}>
                    {r.revoked_at ? t('archived_on', { date: formatDateLong(r.revoked_at) }) : formatDateLong(r.valid_from)}
                  </td>
                  <td className={cn(TD_CLASS, '!pr-0 text-right')}>
                    {canManage && !r.revoked_at ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className={cn('text-muted-foreground hover:text-foreground data-[state=open]:opacity-100', HOVER_REVEAL_CLASS)}
                            aria-label={t('more')}
                          >
                            <EllipsisHorizontalIcon className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => void archive(r)}>{t('archive')}</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {archived.length > 0 && (
        <Button variant="link" size="sm" className="h-auto px-0 text-muted-foreground" onClick={() => setShowArchived((v) => !v)}>
          {showArchived ? t('hide_archived') : t('show_archived', { count: archived.length })}
        </Button>
      )}
      {!canManage && !isLoading && !error && <p className="mt-2 text-[12.5px] text-muted-foreground">{t('read_only')}</p>}

      <Dialog open={adding} onOpenChange={(open) => !saving && setAdding(open)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display text-lg tracking-tight">{t('form_title')}</DialogTitle>
            <DialogDescription className="text-[13px] leading-relaxed">
              {t('lead')} {t('form_description')}
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault()
              void save()
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="block-accounts">{t('field_accounts')}</Label>
              <Input
                id="block-accounts"
                inputMode="numeric"
                placeholder={t('field_accounts_placeholder')}
                value={draft.accounts}
                onChange={(e) => setDraft({ ...draft, accounts: e.target.value })}
              />
              <p className="text-[12.5px] text-muted-foreground">{t('field_accounts_hint')}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="block-counterparty">{t('field_counterparty')}</Label>
              <Input
                id="block-counterparty"
                placeholder={t('field_counterparty_placeholder')}
                value={draft.counterparty}
                maxLength={200}
                onChange={(e) => setDraft({ ...draft, counterparty: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="block-amount">{t('field_amount')}</Label>
                <Input
                  id="block-amount"
                  inputMode="decimal"
                  className="tabular-nums"
                  placeholder={t('field_amount_placeholder')}
                  value={draft.amount}
                  onChange={(e) => setDraft({ ...draft, amount: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="block-vat">{t('field_vat')}</Label>
                <Select value={draft.vat} onValueChange={(v) => setDraft({ ...draft, vat: v as Draft['vat'] })}>
                  <SelectTrigger id="block-vat">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="any">{t('vat_any')}</SelectItem>
                    {BOOKING_REVIEW_VAT_CLASSES.map((v) => (
                      <SelectItem key={v} value={v}>
                        {t(`vat_${v}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="block-note">{t('field_note')}</Label>
              <Input
                id="block-note"
                placeholder={t('field_note_placeholder')}
                value={draft.note}
                maxLength={500}
                onChange={(e) => setDraft({ ...draft, note: e.target.value })}
              />
            </div>
            {formError && (
              <p role="alert" className="text-[12.5px] text-destructive">
                {formError}
              </p>
            )}
            <DialogFooter className="gap-2 sm:gap-2">
              <Button type="button" variant="outline" onClick={() => setAdding(false)} disabled={saving}>
                {t('cancel')}
              </Button>
              <Button type="submit" loading={saving}>
                {t('save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <DestructiveConfirmDialog {...dialogProps} />
    </section>
  )
}
