import type { useTranslations } from 'next-intl'
import { clientDisplayName } from '@/lib/agent-context/context-window'
import { vatLabel } from '@/lib/agent-context/vat-labels'
import { formatCurrency } from '@/lib/utils'
import { shortLabel } from '@/lib/context-graph/build'
import type { ChipFamily, GraphNode } from '@/lib/context-graph/types'

/**
 * What a dot says in words: its name under the dot, and the lines of its
 * panel. Every sentence is a template filled from the briefing (counts,
 * names, dates), in the wiki namespace, so the picture reads the same as the
 * sections under it.
 */

type T = ReturnType<typeof useTranslations>

const FACT_KINDS = new Set(['fact', 'preference', 'pattern', 'correction'])
const STATUS = new Set(['active', 'needs_reconsent'])

/**
 * The message each chip of the legend is named by, in the wiki namespace.
 * What people saved and the knowledge areas are rows of the agent picture's
 * card (Minne, Kunskap): the legend reads the card's own row names, so one
 * thing has one word on the card and in the graph that opens from it.
 */
export const FAMILY_LABEL_KEY: Readonly<Record<ChipFamily, string>> = {
  taught: 'picture.row_memory',
  read: 'graph.families.read',
  wait: 'graph.families.wait',
  instructions: 'picture.row_knowledge',
}

/** The name on a chip of the legend. */
export function familyLabel(family: ChipFamily, t: (key: string) => string): string {
  return t(FAMILY_LABEL_KEY[family])
}

/**
 * A knowledge area's name by its id and its title in the briefing: the lookup
 * the knowledge folders name their tiles with (useKnowledgeName in
 * components/skills/knowledge-labels.ts).
 */
export type KnowledgeName = (id: string, title: string) => string

/** A knowledge dot's title: the folder's name for the area when the lookup is given, else the briefing's own. */
function knowledgeTitle(node: GraphNode, knowledgeName: KnowledgeName | undefined): string | null {
  if (node.kind !== 'skill' || !node.text) return null
  return knowledgeName && node.atomId ? knowledgeName(node.atomId, node.text) : node.text
}

/** The name under a dot. */
export function nodeLabel(node: GraphNode, t: T, knowledgeName?: KnowledgeName): string {
  if (node.kind === 'more') return t('graph.more', { count: node.count ?? 0 })
  const knowledge = knowledgeTitle(node, knowledgeName)
  if (knowledge) return shortLabel(knowledge)
  return node.label ?? t(`graph.kinds.${node.kind}`)
}

export interface NodeText {
  /** The kind of thing, the panel's small first line. */
  kind: string
  /** What it says. */
  title: string
  /** Where it comes from, how sure, when: muted lines under the title. */
  meta: string[]
  /** The page that holds it. A wiki view is a query on the page itself, so it works wherever the wiki is mounted. */
  link: { href: string; label: string } | null
}

/** The menu names of the pages a waiting thing is handled on (nav messages), so a link reads as the menu does. */
export interface NodePages {
  /** Hem: where the suggestions are answered. */
  home: string
  /** Konton och saldo: where a check that differs is reconciled. */
  accounts: string
  /** Frister. */
  deadlines: string
}

export function describeNode(
  node: GraphNode,
  t: T,
  formatDateLong: (date: string) => string,
  linkedCounterparties: number,
  pages?: NodePages,
  knowledgeName?: KnowledgeName,
): NodeText {
  const kind = t(`graph.kinds.${node.kind === 'more' && node.moreOf ? node.moreOf : node.kind}`)
  const date = (d: string | null | undefined) => (d ? formatDateLong(d) : null)
  const lines = (...parts: (string | null | undefined | false)[]) => parts.filter((p): p is string => !!p)
  const view = (v: 'memory' | 'map' | 'skills') => ({ href: `?view=${v}`, label: t('graph.open', { page: t(`view_${v}`) }) })
  // A waiting thing links to the page it is handled on; without the page's name there is no link.
  const page = (href: string, name: string | undefined) => (name ? { href, label: t('graph.open', { page: name }) } : null)

  switch (node.kind) {
    case 'agent':
      return { kind, title: t('graph.agent_text'), meta: [t('graph.agent_meta')], link: null }
    case 'fact':
    case 'group_fact': {
      const client = node.client ? clientDisplayName(node.client) : null
      const saved = [node.savedBy ? t('saved_by', { name: node.savedBy }) : null, node.client ? (client ? t('saved_via', { client }) : t('saved_via_unknown')) : null].filter(Boolean).join(' ')
      const factKind = node.factKind && FACT_KINDS.has(node.factKind) ? t(`fact_kinds.${node.factKind}`) : node.factKind
      return {
        kind,
        title: node.text ?? '',
        meta: lines([factKind, saved ? saved.charAt(0).toUpperCase() + saved.slice(1) : null, date(node.date)].filter(Boolean).join(' · ')),
        link: view('memory'),
      }
    }
    case 'group':
      return { kind, title: node.text ?? '', meta: [], link: view('memory') }
    case 'counterparty': {
      const vat = vatLabel(node.vatTreatment ?? null)
      return {
        kind,
        title: node.account ? t('graph.counterparty_text', { name: node.text ?? '', account: node.account }) : (node.text ?? ''),
        meta: lines(
          [node.evidence ? t('pattern_evidence', { agree: node.evidence.agree, seen: node.evidence.seen }) : null, node.date ? t('graph.last_booked', { date: date(node.date) ?? '' }) : null]
            .filter(Boolean)
            .join(' · '),
          vat,
        ),
        link: view('map'),
      }
    }
    case 'account':
      return { kind, title: t('graph.account_text', { account: node.account ?? '' }), meta: lines(linkedCounterparties > 0 && t('graph.account_meta', { count: linkedCounterparties })), link: view('map') }
    case 'bank':
      return { kind, title: t('graph.bank_text', { date: date(node.date) ?? '' }), meta: [t('sources.connections')], link: { href: '/settings/banking', label: t('graph.open', { page: t('sources.connections') }) } }
    case 'skatteverket':
      return {
        kind,
        title: t('graph.skatteverket_text', { status: node.status && STATUS.has(node.status) ? t(`value_enums.${node.status}`) : (node.status ?? '') }),
        meta: [t('sources.connections')],
        link: { href: '/settings/tax', label: t('graph.open', { page: t('sources.connections') }) },
      }
    case 'inbox':
      return { kind, title: node.text ?? '', meta: [t('sources.connections')], link: null }
    case 'owners':
      return {
        kind,
        title: node.text ?? node.detail ?? '',
        meta: lines(node.text && node.detail ? `${t('values.board')}: ${node.detail}` : null, t('sources.register')),
        link: null,
      }
    case 'archive':
      return {
        kind,
        title: lines(
          node.count !== null && node.count !== undefined && `${t('values.archive_documents')}: ${node.count.toLocaleString('sv-SE')}`,
          node.count2 !== null && node.count2 !== undefined && `${t('values.archive_agreements')}: ${node.count2.toLocaleString('sv-SE')}`,
        ).join(' · '),
        meta: [t('sources.archive')],
        link: { href: '/arkiv', label: t('graph.open', { page: t('sources.archive') }) },
      }
    case 'check': {
      const result = node.result
        ? node.result.difference === null
          ? t('check_open')
          : node.result.unit === 'count'
            ? t('check_count', { count: node.result.difference })
            : t('check_difference', { amount: formatCurrency(node.result.difference) })
        : null
      return { kind, title: node.text ?? '', meta: lines([result, node.account, date(node.date)].filter(Boolean).join(' · '), t('sources.checks')), link: page('/accounts', pages?.accounts) }
    }
    case 'suggestion':
      return { kind, title: node.text ?? '', meta: lines(node.detail), link: page('/', pages?.home) }
    case 'deadline':
      return {
        kind,
        title: node.text ?? '',
        meta: lines(
          [node.date ? t('graph.due', { date: date(node.date) ?? '' }) : null, node.amount !== null && node.amount !== undefined ? formatCurrency(node.amount) : null].filter(Boolean).join(' · '),
          node.detail,
        ),
        link: page('/deadlines', pages?.deadlines),
      }
    case 'question':
      return { kind, title: node.text ?? '', meta: lines(node.detail, node.date ? t('graph.asked', { date: date(node.date) ?? '' }) : null), link: null }
    case 'skill':
      return { kind, title: knowledgeTitle(node, knowledgeName) ?? '', meta: lines(node.detail), link: view('skills') }
    case 'workflows':
      return { kind, title: t('workflows_count', { count: node.count ?? 0 }), meta: [t('sources.accounted')], link: view('skills') }
    case 'permissions':
      return { kind, title: node.count ? t('graph.permissions_text', { count: node.count }) : kind, meta: [], link: null }
    case 'more':
      return {
        kind,
        title: t('graph.more_text', { count: node.count ?? 0 }),
        meta: [],
        link: node.moreOf === 'fact' || node.moreOf === 'group_fact' ? view('memory') : node.moreOf === 'counterparty' ? view('map') : node.moreOf === 'skill' ? view('skills') : null,
      }
  }
}

/** The accessible name of a dot: what kind of thing it is, then what it says. */
export function nodeName(node: GraphNode, text: NodeText, t: T): string {
  return node.kind === 'agent' ? text.kind : t('graph.node_name', { kind: text.kind, text: text.title })
}
