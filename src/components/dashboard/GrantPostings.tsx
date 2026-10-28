'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { BoltIcon } from '@/components/icons'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { formatCurrency, formatDate } from '@/lib/utils'
import type { GrantPosting, GrantReview } from '@/lib/grants/types'
import { useAttribution } from '@/lib/attribution/use-attribution'

/**
 * "Bokfört enligt regel" in Att göra: what the company's rules for automatic
 * booking (lib/grants) let an agent book without asking, since someone last
 * looked. The same records the customer's agent finds in its briefing.
 *
 * Per posting: the date, the counterparty, the verifikat, the amount, and
 * Ångra, which is the bank line's own undo (a storno through the engine,
 * the row goes back to Att bokföra; nothing is deleted). A supplier invoice
 * a rule registered and booked (grants slice 2) opens instead: a booked
 * leverantörsfaktura is corrected or credited on the invoice itself (BFL 5
 * kap. 5 §), never undone by deleting it. Per rule: what it
 * permits and Återkalla, which stages revoke_grant and approves it through
 * the commit door every staged operation has (an owner or admin decides; for
 * anyone else it waits in Granskning). For the whole section: Markera som
 * granskat, and the company's switch that pauses every rule at once.
 */

interface RuleSummary {
  grant_id: string
  grant_version: number
  operation_type: GrantPosting['operation_type']
  counterparty_label: string
  amount_limit_sek: number
  account_number: string
  item_lines: string[]
  grant_accepted_at: string
  revoked: boolean
}

/** "6211, 6212": the accounts a supplier-invoice rule books its lines on. */
function itemAccounts(itemLines: string[]): string {
  return [...new Set(itemLines.map((l) => l.split(':')[0]))].join(', ')
}

function rulesOf(postings: GrantPosting[]): RuleSummary[] {
  const byId = new Map<string, RuleSummary>()
  for (const p of postings) {
    if (byId.has(p.grant_id)) continue
    byId.set(p.grant_id, {
      grant_id: p.grant_id,
      grant_version: p.grant_version,
      operation_type: p.operation_type,
      counterparty_label: p.counterparty_label,
      amount_limit_sek: p.amount_limit_sek,
      account_number: p.account_number,
      item_lines: p.item_lines,
      grant_accepted_at: p.grant_accepted_at,
      revoked: !!p.grant_revoked_at,
    })
  }
  return [...byId.values()]
}

async function post(url: string, body?: unknown): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: 'POST',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { ok: res.ok && !json.error, status: res.status, json }
}

export function GrantPostings({ review, onChanged }: { review: GrantReview; onChanged?: () => void }) {
  const t = useTranslations('dashboard')
  const router = useRouter()
  const { toast } = useToast()
  const { format: attribute } = useAttribution()
  const [postings, setPostings] = useState(review.postings)
  const [paused, setPaused] = useState(review.paused)
  const [undoing, setUndoing] = useState<GrantPosting | null>(null)
  const [revoking, setRevoking] = useState<RuleSummary | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const rules = useMemo(() => rulesOf(postings), [postings])

  function fail(json: Record<string, unknown>, status: number) {
    toast({ title: t('grant_action_failed'), description: getErrorMessage(json, { statusCode: status }), variant: 'destructive' })
  }

  async function undo(p: GrantPosting) {
    if (!p.transaction_id) return
    const res = await post(`/api/transactions/${p.transaction_id}/uncategorize`)
    if (!res.ok) return fail(res.json, res.status)
    setPostings((prev) => prev.map((x) => (x.use_id === p.use_id ? { ...x, entry_status: 'reversed' } : x)))
    toast({ title: t('grant_undone_toast') })
    router.refresh()
  }

  async function revoke(rule: RuleSummary) {
    const staged = await post(`/api/grants/${rule.grant_id}/revoke`)
    if (!staged.ok) return fail(staged.json, staged.status)
    const operationId = (staged.json.data as { operation_id?: string } | undefined)?.operation_id
    if (!operationId) return fail(staged.json, 500)
    const committed = await post(`/api/pending-operations/${operationId}/commit`)
    if (committed.status === 403) {
      toast({ title: t('grant_revoke_waits_toast') })
      return
    }
    if (!committed.ok) return fail(committed.json, committed.status)
    setPostings((prev) =>
      prev.map((x) => (x.grant_id === rule.grant_id ? { ...x, grant_revoked_at: new Date().toISOString() } : x)),
    )
    toast({ title: t('grant_revoked_toast', { counterparty: rule.counterparty_label }) })
    onChanged?.()
  }

  async function markReviewed() {
    setBusy('review')
    try {
      const res = await post('/api/grants/review', { use_ids: postings.map((p) => p.use_id) })
      if (!res.ok) return fail(res.json, res.status)
      setPostings([])
      toast({ title: t('grant_reviewed_toast') })
      onChanged?.()
    } finally {
      setBusy(null)
    }
  }

  async function togglePause() {
    setBusy('pause')
    try {
      const res = await post('/api/grants/pause', { paused: !paused })
      if (!res.ok) return fail(res.json, res.status)
      setPaused(!paused)
      toast({ title: paused ? t('grant_resumed_toast') : t('grant_paused_toast') })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div>
      {paused && <p className="px-1 pt-2 text-xs text-muted-foreground">{t('grant_paused_note')}</p>}
      <div className="stagger-enter">
        {postings.map((p) => {
          const undone = p.entry_status === 'reversed'
          return (
            <div key={p.use_id} className="flex items-center gap-3 border-b border-border px-1 py-3 text-[13px]">
              <span className="w-[18px] shrink-0 text-muted-foreground" aria-hidden>
                <BoltIcon className="h-[15px] w-[15px]" />
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">{formatDate(p.entry_date)}</span>
              <span className="min-w-0 flex-1 truncate">
                {p.counterparty_label}
                {p.journal_entry_id && p.voucher && (
                  <>
                    {' · '}
                    <Link href={`/bookkeeping/${p.journal_entry_id}`} className="underline-offset-2 hover:underline">
                      {p.voucher}
                    </Link>
                  </>
                )}
                {/* Which agent booked under the rule, and for whom. */}
                {p.agent && (
                  <span className="text-muted-foreground">
                    {` · ${attribute({ actorType: p.agent.actor_type, actorLabel: p.agent.actor_label, userId: p.agent.user_id })}`}
                  </span>
                )}
              </span>
              {undone && <Badge variant="secondary">{t('grant_undone_chip')}</Badge>}
              {p.pattern_verified === false && <Badge variant="warning">{t('grant_mismatch_chip')}</Badge>}
              <span className="shrink-0 text-right tabular-nums">{formatCurrency(p.amount_sek)}</span>
              {!undone && p.transaction_id && (
                <Button size="sm" variant="outline" onClick={() => setUndoing(p)}>
                  {t('grant_undo')}
                </Button>
              )}
              {p.supplier_invoice_id && (
                <Button size="sm" variant="outline" asChild>
                  <Link href={`/supplier-invoices/${p.supplier_invoice_id}`}>{t('grant_open_invoice')}</Link>
                </Button>
              )}
            </div>
          )
        })}
      </div>
      {rules.length > 0 && (
        <div className="px-1 pt-3">
          {rules.map((rule) => (
            <div key={rule.grant_id} className="flex flex-wrap items-center gap-2 py-1 text-xs text-muted-foreground">
              <span className="min-w-0 flex-1">
                {rule.operation_type === 'create_supplier_invoice_from_inbox'
                  ? t('grant_rule_line_supplier', {
                      counterparty: rule.counterparty_label,
                      limit: formatCurrency(rule.amount_limit_sek),
                      accounts: itemAccounts(rule.item_lines),
                      version: rule.grant_version,
                      date: formatDate(rule.grant_accepted_at),
                    })
                  : t('grant_rule_line', {
                      counterparty: rule.counterparty_label,
                      limit: formatCurrency(rule.amount_limit_sek),
                      account: rule.account_number,
                      version: rule.grant_version,
                      date: formatDate(rule.grant_accepted_at),
                    })}
                {rule.revoked && ` ${t('grant_rule_revoked')}`}
              </span>
              {!rule.revoked && (
                <Button size="sm" variant="ghost" onClick={() => setRevoking(rule)}>
                  {t('grant_revoke')}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 px-1 pt-3">
        {postings.length > 0 && (
          <Button size="sm" variant="outline" loading={busy === 'review'} disabled={busy !== null} onClick={() => void markReviewed()}>
            {t('grant_mark_reviewed')}
          </Button>
        )}
        <Button size="sm" variant="ghost" loading={busy === 'pause'} disabled={busy !== null} onClick={() => void togglePause()}>
          {paused ? t('grant_resume_all') : t('grant_pause_all')}
        </Button>
      </div>

      <ConfirmDialog
        open={undoing !== null}
        onOpenChange={(open) => !open && setUndoing(null)}
        title={t('grant_undo_title')}
        description={undoing ? t('grant_undo_description', { voucher: undoing.voucher ?? '', counterparty: undoing.counterparty_label }) : undefined}
        confirmLabel={t('grant_undo')}
        onConfirm={async () => {
          if (undoing) await undo(undoing)
        }}
      />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={t('grant_revoke_title')}
        description={revoking ? t('grant_revoke_description', { counterparty: revoking.counterparty_label }) : undefined}
        confirmLabel={t('grant_revoke')}
        destructive
        onConfirm={async () => {
          if (revoking) await revoke(revoking)
        }}
      />
    </div>
  )
}
