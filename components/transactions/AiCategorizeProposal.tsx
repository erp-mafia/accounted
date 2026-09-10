'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import AgentAvatar from '@/components/agent/AgentAvatar'
import { useAgentSheet } from '@/components/agent/AgentSheetProvider'
import { getAccountName } from '@/lib/bookkeeping/client-account-names'
import { firstSentence, type AssistantRead } from '@/lib/agent/categorize/read-shape'
import type { TransactionCategory, VatTreatment } from '@/types'

/**
 * The assistant's verdict inside the recommendation header of the review
 * dialog: one line, not a box. It reads the assistant's stored read of this
 * transaction (POST /api/agent/categorize answers with one, fetching only
 * when the list did not already hand it over) and says one of three things:
 * it agrees with the current pick, it suggests another booking with why and
 * one click to take it, or it found nothing that fits. Nothing books here.
 */
export interface AiProposalMeta {
  account: string
  confidence: number
  agreement: number | null
  modelConfidence: string | null
  source: string
}

/** What the assistant wants booked, complete enough to open a review on. */
export interface AssistantPick {
  account: string
  vat: VatTreatment | 'none'
  category: TransactionCategory | null
  label: string
}

type State =
  | { status: 'loading' }
  | { status: 'ready'; read: AssistantRead }
  /** No AI backend, a failed call, or a read that found nothing: the header stands alone. */
  | { status: 'silent' }

interface Props {
  transactionId: string
  /** Fetch when the dialog is open. */
  open: boolean
  /** Whether a receipt or invoice is matched: it changes what the loading line says. */
  hasUnderlag?: boolean
  /** The business account the dialog currently books to, for the agree check. */
  currentAccount?: string | null
  /** Take the pick as soon as it lands; off when the dialog already has a template of its own. */
  autoApply?: boolean
  /** Take the pick into the dialog: `auto` when it landed on its own, false when the person clicked Använd. */
  onTake: (pick: AssistantPick, opts: { auto: boolean }) => void
  /** Surface the read so the dialog can log a calibration sample on book. */
  onProposal?: (meta: AiProposalMeta) => void
  /** The stored read the list already has: shown at once, no fetch. */
  initial?: AssistantRead | null
}

function pickFrom(read: AssistantRead): AssistantPick | null {
  if (!read.account) return null
  const label = read.candidates.find((c) => c.account === read.account)?.label ?? getAccountName(read.account)
  return { account: read.account, vat: read.vat_treatment ?? 'none', category: read.category, label }
}

export default function AiCategorizeProposal({
  transactionId,
  open,
  hasUnderlag = false,
  currentAccount,
  autoApply = true,
  onTake,
  onProposal,
  initial = null,
}: Props) {
  const t = useTranslations('tx_quick_review')
  const { identity } = useAgentSheet()
  const [state, setState] = useState<State>(() => (initial ? { status: 'ready', read: initial } : { status: 'loading' }))
  const [expanded, setExpanded] = useState(false)
  // The pick is handed to the dialog once per read, so the person's later
  // edits are never clobbered by a re-render.
  const takenRef = useRef<string | null>(null)

  useEffect(() => {
    if (!open || initial) return
    let alive = true
    takenRef.current = null
    ;(async () => {
      try {
        const res = await fetch('/api/agent/categorize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transaction_id: transactionId }),
        })
        if (!alive) return
        const body = res.ok ? ((await res.json()) as { data?: AssistantRead }) : null
        if (!alive) return
        setState(body?.data ? { status: 'ready', read: body.data } : { status: 'silent' })
      } catch {
        if (alive) setState({ status: 'silent' })
      }
    })()
    return () => {
      alive = false
    }
  }, [open, transactionId, initial])

  const reportedRef = useRef(false)
  useEffect(() => {
    if (state.status !== 'ready') return
    const read = state.read
    const pick = pickFrom(read)
    if (!pick) return
    if (!reportedRef.current) {
      reportedRef.current = true
      const source = read.from_candidate
        ? (read.candidates.find((c) => c.account === read.account)?.source ?? 'candidate')
        : 'category'
      onProposal?.({
        account: pick.account,
        confidence: read.confidence,
        agreement: read.agreement,
        modelConfidence: read.model_confidence,
        source,
      })
    }
    // Only a pick with something behind it (a candidate, or a confident model
    // read) fills the dialog on its own; a low guess waits for the person.
    if (!autoApply || takenRef.current === pick.account || read.confidence < 0.5) return
    takenRef.current = pick.account
    onTake(pick, { auto: true })
  }, [state, autoApply, onTake, onProposal])

  const line = 'flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-muted-foreground'
  const mark = <AgentAvatar avatarId={identity.avatarId} size="xs" className="h-4 w-4 flex-none" alt="" />

  if (state.status === 'silent') return null
  if (state.status === 'loading') {
    return (
      <p className={cn(line, 'animate-pulse')}>
        {mark}
        {hasUnderlag ? t('ai_reading') : t('ai_looking')}
      </p>
    )
  }

  const read = state.read
  const pick = pickFrom(read)
  const why = read.reasoning ? (expanded ? read.reasoning : firstSentence(read.reasoning)) : ''
  const hasMore = !!read.reasoning && why !== read.reasoning.trim()
  const more = hasMore ? (
    <button type="button" className={cn(QUIET_LINK_CLASS, 'text-[12px]')} onClick={() => setExpanded((v) => !v)}>
      {expanded ? t('ai_less') : t('ai_more')}
    </button>
  ) : null

  if (!pick) {
    return (
      <p className={line}>
        {mark}
        <span>
          {t('ai_none')}
          {why ? <span className="ml-1">{why}</span> : null}
        </span>
        {more}
      </p>
    )
  }

  const agrees = !!currentAccount && pick.account === currentAccount

  return (
    <p className={line}>
      {mark}
      {agrees ? (
        <span>
          {t('ai_agrees')}
          {why ? <span className="ml-1">{why}</span> : null}
        </span>
      ) : (
        <span>
          {t('ai_instead')} <span className="font-mono text-foreground">{pick.account}</span>
          <span className="text-foreground"> {pick.label}</span>
          {pick.vat === 'reverse_charge' ? <span className="text-foreground"> {t('ai_reverse_charge')}</span> : null}
          {why ? <span className="ml-1">· {why}</span> : null}
        </span>
      )}
      {more}
      {!agrees && (
        <button
          type="button"
          className={cn(QUIET_LINK_CLASS, 'text-[12px] font-medium')}
          onClick={() => {
            takenRef.current = pick.account
            onTake(pick, { auto: false })
          }}
        >
          {t('ai_use')}
        </button>
      )}
    </p>
  )
}
