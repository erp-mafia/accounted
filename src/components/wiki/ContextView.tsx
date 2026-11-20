'use client'

import { useCallback, useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { AttnLine } from '@/components/ui/attn-line'
import { Button } from '@/components/ui/button'
import { EmptyState, LoadError } from '@/components/ui/empty-state'
import { HOVER_REVEAL_CLASS } from '@/components/ui/dry-table'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { useFormat } from '@/lib/hooks/use-format'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { cn, formatCurrency } from '@/lib/utils'
import { getPackage } from '@/lib/modules/packages'
import { vatLabel } from '@/lib/agent-context/vat-labels'
import {
  clientDisplayName,
  type ContextFactItem,
  type ContextItem,
  type ContextSection,
  type ContextWindow,
} from '@/lib/agent-context/context-window'
import { ContextGraph } from '@/components/context-graph/ContextGraph'
import { HelpPopover } from '@/components/ui/help-popover'
import { ContextBar, RawText, ScopeStack, Swatch, type ScopeLevel } from './wiki-parts'

interface ContextPayload {
  window: ContextWindow
  text: string
}

type LoadState =
  | { state: 'loading' }
  | { state: 'ok'; data: ContextPayload }
  | { state: 'failed'; description: string }
  | { state: 'unavailable'; sentence: string }

/** Values the briefing sends as an enum the page names in words (wiki.value_enums). */
const ENUM_VALUES = new Set(['accrual', 'cash', 'aktiebolag', 'enskild_firma', 'active', 'needs_reconsent', 'true'])

/** The fact kinds the memory knows (wiki.fact_kinds); another kind shows as stored. */
const FACT_KINDS = new Set(['fact', 'preference', 'pattern', 'correction'])

/**
 * The wiki's context view: what an agent receives when it opens the active
 * company, read from the briefing itself (GET /api/wiki/context). The scope,
 * the window as one bar split by source, every part with its size, every
 * line with its source, who saved it and when, the remembered facts with
 * Glöm and Ångra (the memory API), and the raw text the agent reads.
 */
export function ContextView() {
  const t = useTranslations('wiki')
  const locale = useLocale() as ErrorLocale
  const [load, setLoad] = useState<LoadState>({ state: 'loading' })

  const fetchContext = useCallback(async () => {
    setLoad({ state: 'loading' })
    try {
      const res = await fetch('/api/wiki/context')
      const body = (await res.json().catch(() => null)) as { data?: ContextPayload; error?: { code?: string } } | null
      if (res.ok && body?.data) {
        setLoad({ state: 'ok', data: body.data })
        return
      }
      const message = getErrorMessage(body, { locale, statusCode: res.status })
      if (res.status === 404 && body?.error?.code === 'AGENT_CONTEXT_UNAVAILABLE') setLoad({ state: 'unavailable', sentence: t('unavailable') })
      else setLoad({ state: 'failed', description: message })
    } catch (err) {
      setLoad({ state: 'failed', description: getErrorMessage(err, { locale }) })
    }
  }, [locale, t])

  useEffect(() => {
    void fetchContext()
  }, [fetchContext])

  if (load.state === 'loading') return <ContextSkeleton />
  if (load.state === 'failed') return <LoadError title={t('load_failed_title')} description={load.description} onRetry={() => void fetchContext()} />
  if (load.state === 'unavailable') return <EmptyState title={load.sentence} />
  return <ContextWindowView window={load.data.window} text={load.data.text} />
}

function ContextSkeleton() {
  return (
    <LateReveal>
      <div className="space-y-6" aria-busy>
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-2 w-full" />
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-11 w-full" />
        ))}
      </div>
    </LateReveal>
  )
}

export function ContextWindowView({ window: w, text }: { window: ContextWindow; text: string }) {
  const t = useTranslations('wiki')
  const n = (x: number) => x.toLocaleString('sv-SE')
  const levels: ScopeLevel[] = [
    ...(w.scope.group ? [{ level: 'group' as const, name: w.scope.group.name }] : []),
    { level: 'company', name: w.scope.company.name ?? w.scope.company.company_id, detail: w.scope.company.org_number },
  ]
  // How full the memory is, in whole percent of the fact budget. The exact
  // character figures sit behind the "?" beside it.
  const percent = w.memory_budget.budget > 0 ? (w.memory_budget.used / w.memory_budget.budget) * 100 : 0
  const memoryLine =
    percent > 0 && percent < 1
      ? t('memory_used_under_one')
      : t('memory_used', { percent: Math.min(100, Math.round(percent)) })
  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <ScopeStack levels={levels} />
        <h2 id="wiki-window-title" className="text-[15px] font-medium text-strong">
          {t('window_title')}
        </h2>
      </div>

      <ContextGraph text={text} />

      <section className="space-y-3" aria-labelledby="wiki-window-title">
        <ContextBar sections={w.sections} total={w.total_chars} />
        <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
          <span className="tabular-nums">{memoryLine}</span>
          <HelpPopover>
            <div className="space-y-2">
              <div className="tabular-nums">{t('window_budget', { used: n(w.memory_budget.used), budget: n(w.memory_budget.budget) })}</div>
              <div className="tabular-nums">{t('window_help_total', { chars: n(w.total_chars) })}</div>
              <ul className="space-y-0.5 tabular-nums">
                {w.sections.map((s) => (
                  <li key={s.id} className="flex items-baseline justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <Swatch family={s.family} />
                      <span className="truncate">{t(`sections.${s.id}`)}</span>
                    </span>
                    <span className="shrink-0 text-muted-foreground">
                      {s.fact_chars > 0 ? t('section_size_facts', { chars: n(s.chars), facts: n(s.fact_chars) }) : t('section_size', { chars: n(s.chars) })}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="text-muted-foreground">{t('window_sizes_note', { budget: n(w.memory_budget.budget) })}</div>
              <div className="text-muted-foreground">{t('window_connector')}</div>
            </div>
          </HelpPopover>
        </div>
        {w.memory_budget.truncated && <AttnLine>{t('window_truncated')}</AttnLine>}
      </section>

      <div className="stagger-enter space-y-8">
        {w.sections.map((s) => (
          <ContextSectionView key={s.id} section={s} />
        ))}
      </div>

      <RawText text={text} subject="company" />
    </div>
  )
}

function ContextSectionView({ section }: { section: ContextSection }) {
  const t = useTranslations('wiki')
  const visible = section.items
  return (
    <section aria-labelledby={`wiki-section-${section.id}`}>
      <div className="-mx-2 flex items-center gap-2 border-b-hairline px-2 pb-2">
        <Swatch family={section.family} />
        <h3 id={`wiki-section-${section.id}`} className="text-[13px] font-medium text-strong">
          {t(`sections.${section.id}`)}
        </h3>
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {visible.length === 0
            ? null
            : visible.every((item) => item.type === 'fact')
              ? t('section_count_facts', { count: visible.length })
              : t('section_count_items', { count: visible.length })}
        </span>
      </div>
      {visible.length === 0 ? (
        <div className="py-3 text-[13px] text-muted-foreground">{section.id === 'memory' ? t('memory_empty') : t('section_empty')}</div>
      ) : (
        <ul className="-mx-2">
          {visible.map((item, i) => (
            <ContextItemRow key={item.type === 'fact' ? item.fact_id : `${item.type}-${i}`} item={item} />
          ))}
        </ul>
      )}
    </section>
  )
}

const ROW_CLASS = 'group grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 border-b-hairline px-2 py-2.5 text-[13px] last:border-b-0'

function ContextItemRow({ item }: { item: ContextItem }) {
  const t = useTranslations('wiki')
  const locale = useLocale()
  const { formatDateLong } = useFormat()
  switch (item.type) {
    case 'fact':
      return <FactRow fact={item} />
    case 'value': {
      const shown =
        item.value === 'available'
          ? t(`values_text.${item.label}`)
          : item.label === 'where_to_find'
            ? t('where_to_find_count', { count: item.value })
            : item.label === 'workflows'
              ? t('workflows_count', { count: Number(item.value) })
              : item.label === 'packages_off'
                ? item.value
                    .split(',')
                    .map((id) => {
                      const pkg = getPackage(id)
                      return pkg ? (locale === 'en' ? pkg.name : pkg.nameSv) : id
                    })
                    .join(', ')
                : ENUM_VALUES.has(item.value)
                  ? t(`value_enums.${item.value}`)
                  : item.label === 'bank_synced'
                    ? formatDateLong(item.value)
                    : item.value
      return (
        <li className={ROW_CLASS}>
          <div className="grid min-w-0 gap-x-4 gap-y-0.5 sm:grid-cols-[200px_minmax(0,1fr)]">
            <span className="text-muted-foreground">{t(`values.${item.label}`)}</span>
            <span className="min-w-0 break-words" data-ph-mask="">
              {shown}
            </span>
          </div>
          <SourceMeta source={item.source} date={item.label === 'bank_synced' ? null : item.date} />
        </li>
      )
    }
    case 'text': {
      // A check says what it found, as the agent gets it: the difference in kr, a count, or that it is open.
      const result = item.result
        ? item.result.difference === null
          ? t('check_open')
          : item.result.unit === 'count'
            ? t('check_count', { count: item.result.difference })
            : t('check_difference', { amount: formatCurrency(item.result.difference) })
        : null
      const detail = item.evidence
        ? t('pattern_evidence', { agree: item.evidence.agree, seen: item.evidence.seen })
        : [item.detail, result].filter(Boolean).join(' · ')
      const vat = vatLabel(item.vat_treatment ?? null)
      return (
        <li className={ROW_CLASS}>
          <div className="min-w-0">
            <div className="break-words" data-ph-mask="">
              {item.text}
              {vat ? `, ${vat}` : null}
            </div>
            {detail && (
              <div className={cn('text-xs', item.result ? 'tabular-nums text-foreground/80' : 'text-muted-foreground')} data-ph-mask="">
                {detail}
              </div>
            )}
          </div>
          <SourceMeta source={item.source} date={item.date} />
        </li>
      )
    }
    case 'key':
      return (
        <li className={ROW_CLASS}>
          <span className="min-w-0 truncate font-mono text-xs">{t('key_item', { key: item.key })}</span>
          <span className="text-xs tabular-nums text-muted-foreground">{t('section_size', { chars: item.chars.toLocaleString('sv-SE') })}</span>
        </li>
      )
  }
}

/** Where a line comes from, and when: muted text, never a chip (the same on every row). */
function SourceMeta({ source, date }: { source: string; date: string | null }) {
  const t = useTranslations('wiki')
  const { formatDateLong } = useFormat()
  return (
    <span className="text-right text-xs text-muted-foreground">
      {t(`sources.${source}`)}
      {date ? <span className="date-figures"> · {formatDateLong(date)}</span> : null}
    </span>
  )
}

/** Who saved a fact, through which AI and from where, in one line. */
function savedLine(fact: ContextFactItem, t: ReturnType<typeof useTranslations>): string {
  const parts: string[] = []
  if (fact.created_by) parts.push(t('saved_by', { name: fact.created_by }))
  else if (fact.created_by_deleted) parts.push(t('saved_by_deleted'))
  if (fact.client) {
    const name = clientDisplayName(fact.client)
    parts.push(name ? t('saved_via', { client: name }) : t('saved_via_unknown'))
  } else if (!fact.created_by && !fact.created_by_deleted && !fact.origin) {
    parts.push(t('saved_in_app'))
  }
  if (fact.origin === 'session_sync') parts.push(t('origin_session_sync'))
  if (fact.origin === 'onboarding_import') parts.push(t('origin_onboarding_import'))
  const line = parts.join(' ')
  return line.charAt(0).toUpperCase() + line.slice(1)
}

function FactRow({ fact }: { fact: ContextFactItem }) {
  const t = useTranslations('wiki')
  const locale = useLocale() as ErrorLocale
  const { formatDateLong } = useFormat()
  const { canWrite } = useCanWrite()
  const [forgotten, setForgotten] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  const setActive = async (active: boolean) => {
    setBusy(true)
    setFailed(null)
    try {
      const res = await fetch(`/api/agent/memory/${fact.fact_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: active }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        setFailed(getErrorMessage(body, { locale, statusCode: res.status, fallback: t('forget_failed') }))
        return
      }
      setForgotten(!active)
    } catch {
      setFailed(t('forget_failed'))
    } finally {
      setBusy(false)
    }
  }

  // A group fact is retired in the group's own list (the group admins' call).
  const editable = canWrite && fact.scope === 'company'
  return (
    <li className={ROW_CLASS}>
      <div className={cn('min-w-0 transition-opacity duration-150', forgotten && 'opacity-50')}>
        <div className={cn('break-words', forgotten ? 'line-through' : 'text-strong')} data-ph-mask="">
          {fact.content}
        </div>
        <div className="text-xs text-muted-foreground">
          {forgotten ? (
            t('forgotten')
          ) : (
            <>
              {FACT_KINDS.has(fact.kind) ? t(`fact_kinds.${fact.kind}`) : fact.kind} · {t('sources.memory')} · <span data-ph-mask="">{savedLine(fact, t)}</span>
              {fact.saved_at ? <span className="date-figures"> · {formatDateLong(fact.saved_at)}</span> : null}
            </>
          )}
        </div>
        {failed && <div className="text-xs text-destructive">{failed}</div>}
      </div>
      {editable ? (
        <span className={forgotten ? undefined : HOVER_REVEAL_CLASS}>
          <Button
            variant="row"
            loading={busy}
            onClick={() => void setActive(forgotten)}
            aria-label={forgotten ? t('restore') : t('forget_label', { content: fact.content.slice(0, 80) })}
          >
            {forgotten ? t('restore') : t('forget')}
          </Button>
        </span>
      ) : (
        <span />
      )}
    </li>
  )
}
