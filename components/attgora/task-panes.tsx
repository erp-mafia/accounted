'use client'

import { useState, type ReactNode, createContext, useContext } from 'react'
import Link from 'next/link'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/components/ui/use-toast'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import type { AttGoraTask } from '@/lib/worklist/tasks-v2'
import type { ExpensePayoutDue, SuggestedMatch } from '@/lib/worklist/types'

/**
 * Middle pane of Att göra v2: one list per task, read from the same APIs the
 * full pages use. Lists that can act (attest, approve, confirm a match) do so
 * here; the rest show the rows and open the page that owns the work. What is
 * still link-only is listed in dev_docs/ui_v2_build_plan.md under PR 3.
 */

export interface ExpiringBankConnection {
  id: string
  bank_name: string
  days_left: number
}

export interface TaskPaneContext {
  matches: SuggestedMatch[]
  confirmingId: string | null
  onConfirmMatch: (match: SuggestedMatch) => void
  expensePayouts: ExpensePayoutDue[]
  expiringBankConnections: ExpiringBankConnection[]
  checklist: ReactNode
  /** Re-read every count from lib/worklist after an action changed the world. */
  refreshCounts: () => void
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} ${res.status}`)
  const json = (await res.json()) as { data?: T }
  return json.data as T
}

function useList<T>(url: string | null) {
  const { data, error, isLoading, mutate } = useSWR<T>(url, fetchJson)
  return { data, error, isLoading, mutate }
}

/* ---------- primitives ---------- */

/** The assistant action the pane header shows beside "Öppna …", set once by TaskPane. */
const PaneAssistantContext = createContext<ReactNode>(null)

export function PaneHeader({ title, sub, action }: { title: string; sub?: ReactNode; action?: ReactNode }) {
  const assistant = useContext(PaneAssistantContext)
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 px-6 pt-5 pb-3">
      <div>
        <h2 className="font-display text-lg leading-6">{title}</h2>
        {sub && <p className="mt-1 text-[12.5px] text-muted-foreground">{sub}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {assistant}
        {action}
      </div>
    </div>
  )
}

function Row({
  href,
  children,
  className,
}: {
  href?: string
  children: ReactNode
  className?: string
}) {
  const base = cn(
    'flex items-center gap-4 border-b border-border/60 px-6 py-[9px] text-[13px]',
    href && 'transition-colors duration-150 hover:bg-secondary/40',
    className,
  )
  return href ? (
    <Link href={href} className={base}>
      {children}
    </Link>
  ) : (
    <div className={base}>{children}</div>
  )
}

function Cell({ children, className, muted, num }: { children: ReactNode; className?: string; muted?: boolean; num?: boolean }) {
  return (
    <span
      className={cn(
        'min-w-0 truncate',
        muted && 'text-muted-foreground',
        num && 'ml-auto shrink-0 tabular-nums text-right',
        className,
      )}
    >
      {children}
    </span>
  )
}

function Loading({ label }: { label: string }) {
  return (
    <p className="px-6 py-4 text-[12.5px] text-muted-foreground" role="status">
      <Loader2 className="mr-1.5 inline h-3.5 w-3.5 animate-spin" aria-hidden />
      {label}
    </p>
  )
}

function Empty({ label }: { label: string }) {
  return <p className="px-6 py-6 text-[13px] text-muted-foreground">{label}</p>
}

function OpenPage({ href, label }: { href: string; label: string }) {
  return (
    <Button asChild variant="outline" size="sm">
      <Link href={href}>{label}</Link>
    </Button>
  )
}

const LIST_LIMIT = 40

/* ---------- lists ---------- */

interface TxRow {
  id: string
  date: string
  description: string
  amount: number
  currency: string
  amount_sek: number | null
}

function TransactionsPane({ task }: { task: AttGoraTask }) {
  const t = useTranslations('att_gora_v2')
  const { data, isLoading } = useList<TxRow[]>(task.count > 0 ? '/api/transactions?unmatched=true' : null)
  const rows = (data ?? []).slice(0, LIST_LIMIT)
  return (
    <>
      <PaneHeader
        title={t('task_book_transaction')}
        sub={task.count > 0 ? t('sub_open', { count: task.count }) : t('sub_done')}
        action={<OpenPage href={task.href} label={t('open_in', { page: t('page_transactions') })} />}
      />
      {isLoading ? (
        <Loading label={t('loading')} />
      ) : rows.length === 0 ? (
        <Empty label={t('empty')} />
      ) : (
        rows.map((r) => (
          <Row key={r.id} href={`/transactions?highlight=${r.id}`}>
            <Cell muted className="w-20 shrink-0 tabular-nums">
              {formatDate(r.date)}
            </Cell>
            <Cell>{r.description}</Cell>
            <Cell num className={r.amount < 0 ? '' : 'text-success'}>
              {formatCurrency(r.amount_sek ?? r.amount, 'SEK')}
            </Cell>
          </Row>
        ))
      )}
      {task.count > rows.length && rows.length > 0 && (
        <p className="px-6 py-3 text-[12.5px] text-muted-foreground">
          <Link href={task.href} className="underline underline-offset-2">
            {t('show_all', { count: task.count })}
          </Link>
        </p>
      )}
    </>
  )
}

function MatchesPane({ task, ctx }: { task: AttGoraTask; ctx: TaskPaneContext }) {
  const t = useTranslations('att_gora_v2')
  const tDash = useTranslations('dashboard')
  return (
    <>
      <PaneHeader
        title={t('task_suggested_match')}
        sub={ctx.matches.length > 0 ? t('sub_open', { count: ctx.matches.length }) : t('sub_done')}
        action={<OpenPage href={task.href} label={t('open_in', { page: t('page_transactions') })} />}
      />
      {ctx.matches.length === 0 ? (
        <Empty label={t('empty')} />
      ) : (
        ctx.matches.map((m) => {
          const busy = ctx.confirmingId === m.transaction_id
          return (
            <Row key={m.transaction_id}>
              <Cell muted className="w-20 shrink-0 tabular-nums">
                {formatDate(m.transaction_date)}
              </Cell>
              <Cell>
                {m.transaction_description}
                <span className="text-muted-foreground">
                  {' '}
                  →{' '}
                  {m.kind === 'invoice'
                    ? tDash('suggested_kind_invoice')
                    : m.kind === 'rot_rut_payout'
                      ? tDash('suggested_kind_rot_rut_payout')
                      : m.kind === 'expense_payout'
                        ? tDash('suggested_kind_expense_payout')
                        : tDash('suggested_kind_supplier_invoice')}
                  {m.candidate_number ? ` ${m.candidate_number}` : ''}
                  {m.counterparty_name ? ` · ${m.counterparty_name}` : ''}
                </span>
              </Cell>
              <Cell num>{formatCurrency(Math.abs(m.transaction_amount), m.transaction_currency)}</Cell>
              <Button
                size="sm"
                className="shrink-0"
                disabled={!!ctx.confirmingId}
                onClick={() => ctx.onConfirmMatch(m)}
              >
                {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                {t('confirm')}
              </Button>
            </Row>
          )
        })
      )}
    </>
  )
}

interface InboxRow {
  id: string
  document_id: string | null
  source: string | null
  created_at: string
  extracted_data: Record<string, unknown> | null
  file_name?: string | null
}

const INBOX_SOURCES = new Set(['mail_hunt', 'email', 'upload', 'whatsapp', 'peppol'])

function InboxPane({ task }: { task: AttGoraTask }) {
  const t = useTranslations('att_gora_v2')
  const { data, isLoading } = useList<InboxRow[]>(task.count > 0 ? '/api/documents/inbox-available' : null)
  const rows = (data ?? []).slice(0, LIST_LIMIT)
  const name = (r: InboxRow) => {
    const d = r.extracted_data ?? {}
    return (
      (d.supplier_name as string | undefined) ??
      (d.vendor as string | undefined) ??
      (d.counterparty as string | undefined) ??
      // A document nobody has read yet: its file name says more than the
      // channel it came through.
      r.file_name ??
      t('inbox_unknown')
    )
  }
  const sourceLabel = (r: InboxRow) => (r.source && INBOX_SOURCES.has(r.source) ? t(`source_${r.source}`) : (r.source ?? ''))
  const amount = (r: InboxRow) => {
    const d = r.extracted_data ?? {}
    const v = (d.total_amount ?? d.amount ?? d.total) as number | string | undefined
    const n = typeof v === 'string' ? Number(v) : v
    return typeof n === 'number' && Number.isFinite(n) ? formatCurrency(n, 'SEK') : ''
  }
  return (
    <>
      <PaneHeader
        title={t('task_inbox_document')}
        sub={task.count > 0 ? t('sub_open', { count: task.count }) : t('sub_done')}
        action={<OpenPage href={task.href} label={t('open_in', { page: t('page_inbox') })} />}
      />
      {isLoading ? (
        <Loading label={t('loading')} />
      ) : rows.length === 0 ? (
        <Empty label={t('empty')} />
      ) : (
        rows.map((r) => (
          <Row key={r.id} href={task.href}>
            <Cell muted className="w-20 shrink-0 tabular-nums">
              {formatDate(r.created_at)}
            </Cell>
            <Cell muted className="w-20 shrink-0">
              {sourceLabel(r)}
            </Cell>
            <Cell>{name(r)}</Cell>
            <Cell num>{amount(r)}</Cell>
          </Row>
        ))
      )}
    </>
  )
}

interface SupplierInvoiceRow {
  id: string
  supplier_invoice_number: string
  due_date: string
  total: number
  total_sek: number | null
  currency: string
  supplier: { id: string; name: string } | null
}

function SupplierApprovalPane({ task, ctx }: { task: AttGoraTask; ctx: TaskPaneContext }) {
  const t = useTranslations('att_gora_v2')
  const { toast } = useToast()
  const { data, isLoading, mutate } = useList<SupplierInvoiceRow[]>(
    task.count > 0 ? '/api/supplier-invoices?status=registered' : null,
  )
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [allBusy, setAllBusy] = useState(false)
  const rows = data ?? []

  async function approve(id: string): Promise<boolean> {
    const res = await fetch(`/api/supplier-invoices/${id}/approve`, { method: 'POST' })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || body.error) {
      toast({
        title: t('toast_failed'),
        description: getErrorMessage(body, { context: 'supplier_invoice', statusCode: res.status }),
        variant: 'destructive',
      })
      return false
    }
    return true
  }

  async function approveOne(id: string) {
    setBusy((s) => new Set(s).add(id))
    const ok = await approve(id)
    setBusy((s) => {
      const n = new Set(s)
      n.delete(id)
      return n
    })
    if (ok) {
      toast({ title: t('toast_attested') })
      await mutate()
      ctx.refreshCounts()
    }
  }

  async function approveAll() {
    setAllBusy(true)
    let done = 0
    for (const r of rows) {
      if (await approve(r.id)) done += 1
    }
    setAllBusy(false)
    if (done > 0) toast({ title: t('toast_attested_n', { count: done }) })
    await mutate()
    ctx.refreshCounts()
  }

  return (
    <>
      <PaneHeader
        title={t('task_supplier_invoice_approval')}
        sub={task.count > 0 ? t('sub_open', { count: task.count }) : t('sub_done')}
        action={
          rows.length > 0 ? (
            <div className="flex items-center gap-2">
              <OpenPage href={task.href} label={t('open_in', { page: t('page_supplier_invoices') })} />
              <Button size="sm" disabled={allBusy || busy.size > 0} onClick={() => void approveAll()}>
                {allBusy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                {t('attest_all', { count: rows.length })}
              </Button>
            </div>
          ) : (
            <OpenPage href={task.href} label={t('open_in', { page: t('page_supplier_invoices') })} />
          )
        }
      />
      {isLoading ? (
        <Loading label={t('loading')} />
      ) : rows.length === 0 ? (
        <Empty label={t('empty')} />
      ) : (
        rows.map((r) => (
          <Row key={r.id}>
            <Cell className="w-40 shrink-0">
              <Link href={`/supplier-invoices/${r.id}`} className="hover:underline underline-offset-2">
                {r.supplier?.name ?? '–'}
              </Link>
            </Cell>
            <Cell muted>{r.supplier_invoice_number}</Cell>
            <Cell muted className="w-24 shrink-0">
              {t('due', { date: formatDate(r.due_date) })}
            </Cell>
            <Cell num>{formatCurrency(r.total_sek ?? r.total, r.total_sek != null ? 'SEK' : r.currency)}</Cell>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0"
              disabled={allBusy || busy.has(r.id)}
              onClick={() => void approveOne(r.id)}
            >
              {busy.has(r.id) ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              {t('attest')}
            </Button>
          </Row>
        ))
      )}
    </>
  )
}

function ExpensePayoutPane({ task, ctx }: { task: AttGoraTask; ctx: TaskPaneContext }) {
  const t = useTranslations('att_gora_v2')
  const tDash = useTranslations('dashboard')
  return (
    <>
      <PaneHeader
        title={t('task_expense_payout')}
        sub={ctx.expensePayouts.length > 0 ? t('sub_open', { count: ctx.expensePayouts.length }) : t('sub_done')}
        action={<OpenPage href={task.href} label={t('open_in', { page: t('page_expenses') })} />}
      />
      {ctx.expensePayouts.length === 0 ? (
        <Empty label={t('empty')} />
      ) : (
        ctx.expensePayouts.map((p) => (
          <Row key={p.key} href="/expenses">
            <Cell>{tDash('row_expense_payout', { name: p.claimant_name })}</Cell>
            <Cell muted>
              {p.claim_count === 1
                ? tDash('row_expense_payout_detail_one', { date: formatDate(p.oldest_expense_date) })
                : tDash('row_expense_payout_detail_other', { count: p.claim_count, date: formatDate(p.oldest_expense_date) })}
            </Cell>
            <Cell num>{formatCurrency(p.total_sek)}</Cell>
          </Row>
        ))
      )}
    </>
  )
}

interface PendingOpRow {
  id: string
  title: string
  actor_label: string | null
  actor_type: string
  risk_level: string
  created_at: string
}

function PendingOpsPane({ task, ctx }: { task: AttGoraTask; ctx: TaskPaneContext }) {
  const t = useTranslations('att_gora_v2')
  const { toast } = useToast()
  const { data, isLoading, mutate } = useList<PendingOpRow[]>(
    task.count > 0 ? '/api/pending-operations?status=pending&limit=50' : null,
  )
  const [busy, setBusy] = useState<string | null>(null)
  const rows = data ?? []

  async function act(id: string, action: 'commit' | 'reject') {
    setBusy(id)
    try {
      const res = await fetch(`/api/pending-operations/${id}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || body.error) {
        toast({
          title: t('toast_failed'),
          description: getErrorMessage(body, { statusCode: res.status }),
          variant: 'destructive',
        })
        return
      }
      toast({ title: action === 'commit' ? t('toast_approved') : t('toast_rejected') })
      await mutate()
      ctx.refreshCounts()
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <PaneHeader
        title={t('task_pending_operations')}
        sub={task.count > 0 ? t('sub_open', { count: task.count }) : t('sub_done')}
        action={<OpenPage href={task.href} label={t('open_in', { page: t('page_pending') })} />}
      />
      {isLoading ? (
        <Loading label={t('loading')} />
      ) : rows.length === 0 ? (
        <Empty label={t('empty')} />
      ) : (
        rows.map((r) => (
          <Row key={r.id}>
            <Cell muted className="w-20 shrink-0 tabular-nums">
              {formatDate(r.created_at)}
            </Cell>
            <Cell>
              <Link href={`/pending?highlight=${r.id}`} className="hover:underline underline-offset-2">
                {r.title}
              </Link>
            </Cell>
            <Cell muted className="w-32 shrink-0">
              {r.actor_label ?? r.actor_type}
            </Cell>
            {r.risk_level !== 'low' && (
              <Badge variant="outline" className="shrink-0 capitalize">
                {r.risk_level}
              </Badge>
            )}
            <div className="ml-auto flex shrink-0 gap-2">
              <Button size="sm" variant="ghost" disabled={busy === r.id} onClick={() => void act(r.id, 'reject')}>
                {t('reject')}
              </Button>
              <Button size="sm" disabled={busy === r.id} onClick={() => void act(r.id, 'commit')}>
                {busy === r.id ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                {t('approve')}
              </Button>
            </div>
          </Row>
        ))
      )}
    </>
  )
}

interface InvoiceRow {
  id: string
  invoice_number: string | null
  due_date: string
  total: number
  total_sek: number | null
  currency?: string
  customer: { id: string; name: string } | null
}

function OverdueInvoicesPane({ task }: { task: AttGoraTask }) {
  const t = useTranslations('att_gora_v2')
  const { data, isLoading } = useList<InvoiceRow[]>(task.count > 0 ? '/api/invoices?status=overdue' : null)
  const rows = (data ?? []).slice(0, LIST_LIMIT)
  return (
    <>
      <PaneHeader
        title={t('task_overdue_invoice')}
        sub={task.count > 0 ? t('sub_open', { count: task.count }) : t('sub_done')}
        action={<OpenPage href={task.href} label={t('open_in', { page: t('page_invoices') })} />}
      />
      {isLoading ? (
        <Loading label={t('loading')} />
      ) : rows.length === 0 ? (
        <Empty label={t('empty')} />
      ) : (
        rows.map((r) => (
          <Row key={r.id} href={`/invoices/${r.id}`}>
            <Cell muted className="w-14 shrink-0">
              {r.invoice_number ?? '–'}
            </Cell>
            <Cell>{r.customer?.name ?? '–'}</Cell>
            <Cell muted className="w-28 shrink-0">
              {t('due', { date: formatDate(r.due_date) })}
            </Cell>
            <Cell num>{formatCurrency(r.total_sek ?? r.total, r.total_sek != null ? 'SEK' : r.currency ?? 'SEK')}</Cell>
          </Row>
        ))
      )}
    </>
  )
}

interface DeadlineRow {
  id: string
  title: string
  due_date: string
  status: string
  is_completed: boolean
}

const ATTENTION = new Set(['action_needed', 'overdue'])

function DeadlinesPane({ task }: { task: AttGoraTask }) {
  const t = useTranslations('att_gora_v2')
  const { data, isLoading } = useList<DeadlineRow[]>(task.count > 0 ? '/api/deadlines?status=pending' : null)
  const rows = (data ?? []).filter((d) => !d.is_completed && ATTENTION.has(d.status)).slice(0, LIST_LIMIT)
  return (
    <>
      <PaneHeader
        title={t('task_deadline_action')}
        sub={task.count > 0 ? t('sub_open', { count: task.count }) : t('sub_done')}
        action={<OpenPage href={task.href} label={t('open_in', { page: t('page_deadlines') })} />}
      />
      {isLoading ? (
        <Loading label={t('loading')} />
      ) : rows.length === 0 ? (
        <Empty label={t('empty')} />
      ) : (
        rows.map((r) => (
          <Row key={r.id} href="/deadlines">
            <Cell muted className="w-24 shrink-0">
              {formatDate(r.due_date)}
            </Cell>
            <Cell>{r.title}</Cell>
            {r.status === 'overdue' && (
              <Badge variant="outline" className="ml-auto shrink-0 text-destructive">
                {t('overdue')}
              </Badge>
            )}
          </Row>
        ))
      )}
    </>
  )
}

function BankConsentPane({ task, ctx }: { task: AttGoraTask; ctx: TaskPaneContext }) {
  const t = useTranslations('att_gora_v2')
  const tDash = useTranslations('dashboard')
  return (
    <>
      <PaneHeader
        title={t('task_bank_consent')}
        sub={t('sub_open', { count: ctx.expiringBankConnections.length })}
        action={<OpenPage href={task.href} label={t('open_in', { page: t('page_banking') })} />}
      />
      {ctx.expiringBankConnections.map((c) => (
        <Row key={c.id} href="/settings/banking">
          <Cell>{c.bank_name}</Cell>
          <Cell muted>
            {c.days_left === 1
              ? tDash('bank_consent_detail_one', { bank: c.bank_name, days: c.days_left })
              : tDash('bank_consent_detail_other', { bank: c.bank_name, days: c.days_left })}
          </Cell>
        </Row>
      ))}
    </>
  )
}

/** Tasks whose rows live on their own page for now: count, explanation, one button. */
function LinkOnlyPane({ task, titleKey, pageKey, bodyKey }: { task: AttGoraTask; titleKey: string; pageKey: string; bodyKey: string }) {
  const t = useTranslations('att_gora_v2')
  return (
    <>
      <PaneHeader
        title={t(titleKey)}
        sub={task.count > 0 ? t('sub_open', { count: task.count }) : t('sub_done')}
        action={<OpenPage href={task.href} label={t('open_in', { page: t(pageKey) })} />}
      />
      <p className="max-w-[62ch] px-6 py-4 text-[13px] leading-relaxed text-muted-foreground">{t(bodyKey)}</p>
    </>
  )
}

function SetupPane({ task, ctx }: { task: AttGoraTask; ctx: TaskPaneContext }) {
  const t = useTranslations('att_gora_v2')
  return (
    <>
      <PaneHeader title={t(`task_${task.id}`)} sub={task.state === 'done' ? t('sub_done') : t('setup_sub')} />
      <div className="px-6 pb-6">{ctx.checklist}</div>
    </>
  )
}

export function TaskPane({ task, ctx, assistant }: { task: AttGoraTask; ctx: TaskPaneContext; assistant?: ReactNode }) {
  return <PaneAssistantContext.Provider value={assistant ?? null}>{paneFor(task, ctx)}</PaneAssistantContext.Provider>
}

function paneFor(task: AttGoraTask, ctx: TaskPaneContext) {
  switch (task.id) {
    case 'setup_bank':
    case 'setup_import':
    case 'setup_skatteverket':
    case 'setup_receipts':
    case 'setup_claude':
      return <SetupPane task={task} ctx={ctx} />
    case 'book_transaction':
      return <TransactionsPane task={task} />
    case 'suggested_match':
      return <MatchesPane task={task} ctx={ctx} />
    case 'inbox_document':
      return <InboxPane task={task} />
    case 'supplier_invoice_approval':
      return <SupplierApprovalPane task={task} ctx={ctx} />
    case 'expense_payout':
      return <ExpensePayoutPane task={task} ctx={ctx} />
    case 'pending_operations':
      return <PendingOpsPane task={task} ctx={ctx} />
    case 'overdue_invoice':
      return <OverdueInvoicesPane task={task} />
    case 'deadline_action':
      return <DeadlinesPane task={task} />
    case 'bank_consent':
      return <BankConsentPane task={task} ctx={ctx} />
    case 'book_skattekonto':
      return <LinkOnlyPane task={task} titleKey="task_book_skattekonto" pageKey="page_transactions" bodyKey="body_book_skattekonto" />
    case 'verifikat_missing_document':
      return <LinkOnlyPane task={task} titleKey="task_verifikat_missing_document" pageKey="page_bookkeeping" bodyKey="body_verifikat_missing_document" />
    case 'reconciliation_due':
      return <LinkOnlyPane task={task} titleKey="task_reconciliation_due" pageKey="page_reconciliation" bodyKey="body_reconciliation_due" />
  }
}
