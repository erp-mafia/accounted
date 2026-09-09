'use client'

import { useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Check, Minus, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { useAgentSheet } from '@/components/agent/AgentSheetProvider'
import { useCapability } from '@/contexts/CompanyContext'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { cn } from '@/lib/utils'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import {
  buildAttGoraTasks,
  firstOpenTask,
  openTaskTotal,
  ATT_GORA_TASK_HREF,
  type AttGoraGroup,
  type AttGoraSetupFlags,
  type AttGoraTask,
  type AttGoraTaskId,
} from '@/lib/worklist/tasks-v2'
import type { ExpensePayoutDue, SuggestedMatch, WorklistCounts } from '@/lib/worklist/types'
import { TaskPane, type ExpiringBankConnection, type TaskPaneContext } from './task-panes'

interface AttGoraV2Props {
  worklist: WorklistCounts
  suggestedMatches: SuggestedMatch[]
  expensePayouts: ExpensePayoutDue[]
  expiringBankConnections: ExpiringBankConnection[]
  hasActiveBankConnection: boolean
  setup: AttGoraSetupFlags | null
  /** The first-run checklist (server component), shown in the middle pane for Kom igång tasks. */
  checklist: ReactNode
  /** Degraded-state notice line (server component), shown above the panes. */
  notices: ReactNode
}

/**
 * Att göra in shell v2 (dev_docs/ui_v2_build_plan.md, PR 3): three panes on
 * the worklist. Left: the task tree from lib/worklist/tasks-v2. Middle: the
 * selected task's rows and actions (task-panes.tsx). Right: deadline, lagrum,
 * dependencies and a task-scoped assistant line. Every number is a worklist
 * count and refreshes from /api/worklist/counts after an action, so this
 * pane can never disagree with the sidebar badge.
 */
export default function AttGoraV2({
  worklist,
  suggestedMatches,
  expensePayouts,
  expiringBankConnections,
  hasActiveBankConnection,
  setup,
  checklist,
  notices,
}: AttGoraV2Props) {
  const t = useTranslations('att_gora_v2')
  const { toast } = useToast()
  const hasAi = useCapability(CAPABILITY.ai)
  const { openAgentSheet } = useAgentSheet()
  const params = useSearchParams()

  const [counts, setCounts] = useState(worklist.counts)
  const [matches, setMatches] = useState(suggestedMatches)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)

  const groups: AttGoraGroup[] = useMemo(
    () =>
      buildAttGoraTasks({
        counts: { ...counts, suggested_match: matches.length },
        hasAi,
        expensePayoutPeople: expensePayouts.length,
        expiringBankConnections: expiringBankConnections.length,
        hasActiveBankConnection,
        setup,
      }),
    [counts, matches.length, hasAi, expensePayouts.length, expiringBankConnections.length, hasActiveBankConnection, setup],
  )
  const allTasks = useMemo(() => groups.flatMap((g) => g.tasks), [groups])

  const requested = params.get('task') as AttGoraTaskId | null
  const [selectedId, setSelectedId] = useState<AttGoraTaskId | null>(
    requested && allTasks.some((x) => x.id === requested) ? requested : (firstOpenTask(groups)?.id ?? null),
  )
  const selected: AttGoraTask | null =
    allTasks.find((x) => x.id === selectedId) ?? firstOpenTask(groups) ?? allTasks[0] ?? null

  async function refreshCounts() {
    try {
      const res = await fetch('/api/worklist/counts')
      if (!res.ok) return
      const json = (await res.json().catch(() => ({}))) as { data?: WorklistCounts }
      if (json.data) setCounts(json.data.counts)
    } catch {
      // Stale counts self-correct on the next load; never block the flow.
    }
  }

  async function confirmMatch(match: SuggestedMatch) {
    setConfirmingId(match.transaction_id)
    try {
      const url =
        match.kind === 'invoice'
          ? `/api/transactions/${match.transaction_id}/match-invoice`
          : match.kind === 'rot_rut_payout'
            ? `/api/transactions/${match.transaction_id}/match-rot-rut-payout`
            : match.kind === 'expense_payout'
              ? `/api/transactions/${match.transaction_id}/match-expense-payout`
              : `/api/transactions/${match.transaction_id}/match-supplier-invoice`
      const body =
        match.kind === 'invoice'
          ? { invoice_id: match.candidate_id }
          : match.kind === 'rot_rut_payout'
            ? { request_ids: match.request_ids ?? [match.candidate_id] }
            : match.kind === 'expense_payout'
              ? { claim_ids: match.claim_ids ?? [] }
              : { supplier_invoice_id: match.candidate_id }
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const result = await res.json().catch(() => ({}))
      if (!res.ok || result.error) {
        toast({
          title: t('toast_failed'),
          description: getErrorMessage(result, { context: 'transaction', statusCode: res.status }),
          variant: 'destructive',
        })
        return
      }
      toast({ title: t('toast_match_confirmed') })
      setMatches((prev) => prev.filter((m) => m.transaction_id !== match.transaction_id))
      void refreshCounts()
    } catch {
      toast({ title: t('toast_failed'), variant: 'destructive' })
    } finally {
      setConfirmingId(null)
    }
  }

  const ctx: TaskPaneContext = {
    matches,
    confirmingId,
    onConfirmMatch: (m) => void confirmMatch(m),
    expensePayouts,
    expiringBankConnections,
    checklist,
    refreshCounts: () => void refreshCounts(),
  }

  const total = openTaskTotal(groups)

  const depDone = (id: AttGoraTaskId) => allTasks.find((x) => x.id === id)?.state === 'done'

  const assistantLine = (task: AttGoraTask) =>
    t(`assist_${task.id}`, { count: task.count })

  return (
    <div className="stagger-enter">
      {notices}
      {/* The panes draw a top line only when a notice sits between them and
          the top bar; otherwise they butt against the bar and its border is
          the only line. The notices slot is always an element, so the DOM
          decides (first-child), not the prop: an empty notices section
          renders nothing and must not leave a second line 16px below. */}
      <div
        className={cn(
          '-mx-4 -mb-8 grid md:-mx-6 md:grid-cols-[250px_minmax(0,1fr)] xl:grid-cols-[250px_minmax(0,1fr)_256px]',
          'first:-mt-4 md:first:h-[calc(100vh-108px)]',
          '[&:not(:first-child)]:border-t [&:not(:first-child)]:border-border/60 md:[&:not(:first-child)]:h-[calc(100vh-124px)]',
        )}
      >
        {/* Tree */}
        <aside
          aria-label={t('tree_label')}
          className="border-b border-border/60 px-2 py-3 md:overflow-y-auto md:border-b-0 md:border-r"
        >
          <div className="flex items-center justify-between px-3 pb-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            <span>{t('tree_heading')}</span>
            <span className="tabular-nums" data-ph-mask>
              {total > 0 ? t('sub_open', { count: total }) : t('sub_done')}
            </span>
          </div>
          {groups.map((g) => (
            <div key={g.id} className="mb-3">
              <div className="px-3 py-1 text-[12.5px] font-medium">
                {t(`group_${g.id}`)}
                <span className="ml-2 text-[11px] font-normal tabular-nums text-muted-foreground" data-ph-mask>
                  {g.tasks.filter((x) => x.state === 'open').length || ''}
                </span>
              </div>
              <div className="space-y-px">
                {g.tasks.map((task) => {
                  const active = selected?.id === task.id
                  return (
                    <button
                      key={task.id}
                      type="button"
                      onClick={() => setSelectedId(task.id)}
                      aria-current={active ? 'true' : undefined}
                      className={cn(
                        'group flex w-full items-center gap-2.5 rounded-lg px-3 py-[6px] text-left text-[13px] transition-colors duration-150',
                        active ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
                      )}
                    >
                      <span
                        className={cn(
                          'flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-full border',
                          task.state === 'done' ? 'border-success/60 text-success' : 'border-border',
                        )}
                        aria-hidden
                      >
                        {task.state === 'done' ? (
                          <Check className="h-2.5 w-2.5" />
                        ) : task.deps.some((d) => !depDone(d)) ? (
                          <Minus className="h-2.5 w-2.5 text-muted-foreground" />
                        ) : null}
                      </span>
                      <span className={cn('flex-1 truncate', task.state === 'done' && 'text-muted-foreground')}>
                        {t(`task_${task.id}`)}
                      </span>
                      {task.state === 'open' && task.count > 0 && (
                        <span className="shrink-0 text-[11.5px] tabular-nums text-muted-foreground" data-ph-mask>
                          {task.count}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </aside>

        {/* Detail */}
        <section className="min-w-0 md:overflow-y-auto" aria-live="polite">
          {selected ? <TaskPane task={selected} ctx={ctx} /> : null}
        </section>

        {/* Right pane */}
        <aside className="hidden border-l border-border/60 xl:block xl:overflow-y-auto">
          {selected && (
            <>
              <RightSection title={t('details')} status={selected.state === 'done' ? t('sub_done') : t('state_open')}>
                <dl className="grid grid-cols-[78px_1fr] gap-x-3 gap-y-1.5 text-[12.5px]">
                  <dt className="text-muted-foreground">{t('deadline')}</dt>
                  <dd>{selected.id === 'deadline_action' ? t('deadline_in_list') : t('deadline_ongoing')}</dd>
                  <dt className="text-muted-foreground">{t('lagrum')}</dt>
                  <dd>{t(`lagrum_${selected.id}`)}</dd>
                </dl>
              </RightSection>
              {/* Only when there are any: "Inga beroenden" was a section saying nothing. */}
              {selected.deps.length > 0 && (
              <RightSection title={t('deps')} status={String(selected.deps.length)}>
                {selected.deps.map((d) => (
                    <div key={d} className="flex items-center gap-2 py-0.5 text-[12.5px]">
                      <span
                        className={cn(
                          'flex h-[14px] w-[14px] items-center justify-center rounded-full border',
                          depDone(d) ? 'border-success/60 text-success' : 'border-border',
                        )}
                        aria-hidden
                      >
                        {depDone(d) && <Check className="h-2 w-2" />}
                      </span>
                      {allTasks.some((x) => x.id === d) ? (
                        <button type="button" className="underline underline-offset-2" onClick={() => setSelectedId(d)}>
                          {t(`task_${d}`)}
                        </button>
                      ) : (
                        <Link href={ATT_GORA_TASK_HREF[d]} className="underline underline-offset-2">
                          {t(`task_${d}`)}
                        </Link>
                      )}
                    </div>
                  ))}
              </RightSection>
              )}
              <RightSection title={t('assistant')}>
                <div className="rounded-lg border border-border px-3 py-2.5 text-[12.5px] text-foreground/80">
                  <div className="mb-1 flex items-center gap-1.5 font-medium text-foreground">
                    <Sparkles className="h-3.5 w-3.5" aria-hidden />
                    Accounted
                  </div>
                  {assistantLine(selected)}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() =>
                    openAgentSheet({
                      intentId: 'general.help',
                      seedUserMessage: t('ask_seed', { task: t(`task_${selected.id}`) }),
                    })
                  }
                >
                  {t('ask_assistant')}
                </Button>
              </RightSection>
            </>
          )}
        </aside>
      </div>
    </div>
  )
}

function RightSection({ title, status, children }: { title: string; status?: string; children: ReactNode }) {
  return (
    <div className="border-b border-border/60 px-4 pb-4 pt-3.5">
      <div className="mb-2 flex items-center text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {title}
        {status && <span className="ml-auto normal-case tracking-normal text-[11px]">{status}</span>}
      </div>
      {children}
    </div>
  )
}
