'use client'

import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { XMarkIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { cn, formatDateLong } from '@/lib/utils'
import { buildContextGraph, chipFamily, parseBriefingText } from '@/lib/context-graph/build'
import { layoutGraph, STAGE_NARROW, STAGE_WIDE } from '@/lib/context-graph/layout'
import { CHIP_FAMILIES, type ChipFamily, type GraphFamily, type GraphNode, type GraphNodeKind } from '@/lib/context-graph/types'
import { FAMILY_DOT, GraphStage, type StageNode } from './GraphStage'
import { describeNode, nodeLabel, nodeName, type NodePages, type NodeText } from './node-text'

/**
 * The context graph at the top of the wiki's context view: what the agent
 * receives about the company, as one web of linked things (founder brief
 * 2026-11-14, prototype canvas "Kontext").
 *
 * It reads the briefing text the page already holds, the same answer the
 * sections below describe, so it loads nothing of its own. Full-bleed
 * between two hairlines on the page's own ground (light and dark follow the
 * theme), no card and no summary on top. The chips carry the counts and dim
 * everything outside their family; picking a dot keeps it, its lines and its
 * neighbours and says what it is in a small floating panel inside the stage
 * (under the stage on a phone), with its links and the page that holds it.
 */

/** Below this much room the web is laid out for a phone (nearly square, shorter). */
const NARROW_BELOW = 600
/** Kinds whose name is the start of a sentence: shown on hover, when picked and zoomed in, never at rest. */
const SENTENCE_KINDS: ReadonlySet<GraphNodeKind> = new Set(['fact', 'group_fact', 'check', 'suggestion', 'deadline', 'question'])
/** How many linked things the panel lists before "+N". */
const LINKS_SHOWN = 6

export function ContextGraph({ text }: { text: string }) {
  const t = useTranslations('wiki')
  const tNav = useTranslations('nav')
  const locale = useLocale()
  const wrapRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState<number | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [family, setFamily] = useState<ChipFamily | null>(null)

  const model = useMemo(() => {
    const briefing = parseBriefingText(text)
    return briefing ? buildContextGraph(briefing) : null
  }, [text])

  const drawable = model !== null && !model.empty
  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const measure = () => setWidth(Math.round(el.getBoundingClientRect().width))
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [drawable])

  const narrow = width !== null && width < NARROW_BELOW
  const view = useMemo(() => {
    if (!model || model.empty) return null
    const byId = new Map(model.nodes.map((n) => [n.id, n]))
    const labelled = model.nodes.map((n) => ({ id: n.id, label: nodeLabel(n, t), quiet: SENTENCE_KINDS.has(n.kind) }))
    const layout = layoutGraph(labelled, model.edges, narrow ? STAGE_NARROW : STAGE_WIDE)
    const texts = new Map<string, NodeText>()
    const pages: NodePages = { home: tNav('home'), accounts: tNav('v3_accounts_balance'), deadlines: tNav('v3_deadlines') }
    for (const n of model.nodes) {
      const counterparties = (layout.neighbours[n.id] ?? []).filter((id) => byId.get(id)?.kind === 'counterparty').length
      texts.set(n.id, describeNode(n, t, (date) => formatDateLong(date, locale), counterparties, pages))
    }
    const nodes: StageNode[] = model.nodes.map((n, i) => ({ id: n.id, family: n.family, label: labelled[i].label, name: nodeName(n, texts.get(n.id)!, t) }))
    return { byId, layout, texts, nodes }
  }, [model, narrow, t, tNav, locale])

  const lit = useMemo(() => {
    if (!model || !family) return null
    // The agent stays lit: it is what every family hangs on.
    return new Set(model.nodes.filter((n) => n.family === 'agent' || chipFamily(n.family) === family).map((n) => n.id))
  }, [model, family])

  if (!model) return null
  if (model.empty || !view) return <EmptyState title={t('graph.empty')} />

  const picked = selected ? view.byId.get(selected) : undefined
  const height = width === null ? 0 : narrow ? Math.round((width * STAGE_NARROW.height) / STAGE_NARROW.width) : Math.max(320, Math.min(560, Math.round(width * 0.46)))
  const panel = picked ? (
    <NodePanel
      node={picked}
      text={view.texts.get(picked.id)!}
      neighbours={(view.layout.neighbours[picked.id] ?? []).map((id) => view.byId.get(id)).filter((n): n is GraphNode => !!n)}
      labelOf={(n) => view.nodes.find((s) => s.id === n.id)?.label ?? ''}
      onPick={setSelected}
      onClose={() => setSelected(null)}
      floating={!narrow}
    />
  ) : null

  return (
    <section ref={wrapRef} aria-label={t('graph.label')} className="-mx-4 border-b-hairline border-t-hairline md:-mx-6">
      <div role="group" aria-label={t('graph.chips_label')} className="flex flex-wrap gap-1.5 px-4 pt-3 md:px-6">
        {CHIP_FAMILIES.filter((f) => model.counts[f] > 0).map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={family === f}
            onClick={() => {
              setSelected(null)
              setFamily(family === f ? null : f)
            }}
            className={cn(
              'inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-xs transition-colors duration-150 pointer-coarse:min-h-10',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70',
              family === f ? 'bg-secondary text-strong' : 'bg-secondary/35 text-foreground hover:bg-secondary/60',
            )}
          >
            <FamilyDot family={f} />
            {t(`graph.families.${f}`)}
            <span className="font-medium tabular-nums text-muted-foreground">{model.counts[f].toLocaleString('sv-SE')}</span>
          </button>
        ))}
      </div>
      {width !== null && (
        <GraphStage
          nodes={view.nodes}
          edges={model.edges}
          layout={view.layout}
          width={width}
          height={height}
          selected={selected}
          onSelect={setSelected}
          lit={lit}
          labels={{ stage: t('graph.stage_label'), zoomGroup: t('graph.zoom_label'), zoomOut: t('graph.zoom_out'), zoomIn: t('graph.zoom_in'), zoomReset: t('graph.zoom_reset') }}
        >
          {!narrow && (
            <div aria-live="polite" data-graph-ui="">
              {panel}
            </div>
          )}
        </GraphStage>
      )}
      {narrow && <div aria-live="polite">{panel}</div>}
    </section>
  )
}

/** The family's mark, as on its dots: filled, or a ring for what is waiting. Shape and name carry it too, never colour alone. */
function FamilyDot({ family }: { family: GraphFamily }) {
  const color = FAMILY_DOT[family]
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block h-2 w-2 shrink-0 rounded-full', family === 'wait' && 'border-[1.5px]')}
      style={family === 'wait' ? { borderColor: color } : { backgroundColor: color }}
    />
  )
}

/** What the picked dot is: its kind, what it says, where it comes from, what it links to and the page that holds it. */
function NodePanel({
  node,
  text,
  neighbours,
  labelOf,
  onPick,
  onClose,
  floating,
}: {
  node: GraphNode
  text: NodeText
  neighbours: GraphNode[]
  labelOf: (node: GraphNode) => string
  onPick: (id: string) => void
  onClose: () => void
  floating: boolean
}) {
  const t = useTranslations('wiki')
  const shown = neighbours.slice(0, LINKS_SHOWN)
  return (
    <div
      className={cn(
        'cursor-default text-[13px]',
        floating
          ? 'absolute bottom-4 left-4 max-h-[calc(100%-2rem)] w-[280px] max-w-[calc(100%-2rem)] animate-rise overflow-y-auto rounded-pop bg-popover py-2.5 pl-3.5 pr-3 text-popover-foreground shadow-float md:left-6'
          : 'border-t-hairline px-4 py-3',
      )}
    >
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <FamilyDot family={node.family} />
        <span className="min-w-0 flex-1 truncate">{text.kind}</span>
        <Button variant="ghost" size="icon" aria-label={t('graph.close')} onClick={onClose} className="-my-1 -mr-1 shrink-0 text-muted-foreground">
          <XMarkIcon className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="mt-0.5 break-words font-medium text-strong" data-ph-mask="">
        {text.title}
      </div>
      {text.meta.map((line) => (
        <div key={line} className="mt-1 break-words text-xs text-muted-foreground" data-ph-mask="">
          {line}
        </div>
      ))}
      {shown.length > 0 && (
        <div className="mt-2.5">
          <div className="text-xs font-medium text-muted-foreground">{t('graph.links_title')}</div>
          <ul className="-mx-1.5 mt-0.5">
            {shown.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => onPick(n.id)}
                  className="flex min-h-7 w-full items-center gap-1.5 rounded-md px-1.5 text-left text-[13px] text-foreground transition-colors duration-150 hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 pointer-coarse:min-h-10"
                >
                  <FamilyDot family={n.family} />
                  <span className="min-w-0 truncate" data-ph-mask="">
                    {labelOf(n)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {neighbours.length > shown.length && <div className="mt-0.5 text-xs tabular-nums text-muted-foreground">{t('graph.more', { count: neighbours.length - shown.length })}</div>}
        </div>
      )}
      {text.link && (
        <div className="mt-2">
          <Link href={text.link.href} scroll={false} className="text-foreground underline decoration-foreground/25 underline-offset-[3px] hover:decoration-foreground/60">
            {text.link.label}
          </Link>
        </div>
      )}
    </div>
  )
}
