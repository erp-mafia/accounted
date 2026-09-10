'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import type { TransactionCategory, VatTreatment } from '@/types'

/**
 * The assistant's verdict inside the recommendation header of the review
 * dialog: one line, not a box. It fetches POST /api/agent/categorize (the
 * deterministic candidates, then the model's pick, with the matched
 * receipt's text when there is one) and says one of three things: it
 * agrees with the current pick, it suggests another booking with why and
 * one click to take it, or it finds nothing that fits. It pre-fills the
 * dialog only when the dialog has no template of its own; a rule or a
 * learned counterpart is never overridden by the model. Nothing books here.
 */
interface CandidateDto {
  account: string
  label: string
  vatTreatment: VatTreatment | 'none' | null
  source: string
}

interface ProposalDto {
  account: string | null
  category: TransactionCategory | null
  vatTreatment: VatTreatment | 'none' | null
  reverseCharge?: boolean
  confidence: number
  modelConfidence?: number
  agreement?: boolean
  fromCandidate: boolean
  choice: { kind: 'account' | 'category' | 'needs_review' }
  reasoning: string
  candidates: CandidateDto[]
}

export interface AiProposalMeta {
  account: string
  confidence: number
  agreement?: boolean
  modelConfidence?: number
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
  | { status: 'ready'; proposal: ProposalDto }
  | { status: 'error' }
  | { status: 'unconfigured' }

interface Props {
  transactionId: string
  /** Fetch when the dialog is open. */
  open: boolean
  /** Whether a receipt or invoice is matched: it changes what the loading line says. */
  hasUnderlag?: boolean
  /** The business account the dialog currently books to, for the agree check. */
  currentAccount?: string | null
  /** Pre-fill the dialog with the pick when it lands; off when the dialog already has a template. */
  autoApply?: boolean
  /** Apply an account + VAT to the dialog fields (the flow without a template). */
  onApply: (account: string, vat: VatTreatment | 'none') => void
  /**
   * When set, the dialog books through a template and an account cannot be
   * dropped into it: taking the pick reopens the review on the assistant's
   * booking instead.
   */
  onUsePick?: (pick: AssistantPick) => void
  /** Surface the proposal metadata so the dialog can log a calibration sample on book. */
  onProposal?: (meta: AiProposalMeta) => void
}

/** The first sentence of the model's reasoning; the rest waits behind "Mer". */
function firstSentence(text: string): string {
  const m = text.trim().match(/^.*?[.!?](?=\s|$)/)
  return m ? m[0] : text.trim()
}

export default function AiCategorizeProposal({
  transactionId,
  open,
  hasUnderlag = false,
  currentAccount,
  autoApply = true,
  onApply,
  onUsePick,
  onProposal,
}: Props) {
  const t = useTranslations('tx_quick_review')
  const [state, setState] = useState<State>({ status: 'loading' })
  const [expanded, setExpanded] = useState(false)
  // Apply the pick to the dialog exactly once per fetch, so the user's later
  // manual edits are never clobbered by a re-render.
  const appliedRef = useRef<string | null>(null)

  useEffect(() => {
    if (!open) return
    let alive = true
    appliedRef.current = null
    ;(async () => {
      try {
        const res = await fetch('/api/agent/categorize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transaction_id: transactionId }),
        })
        if (!alive) return
        if (res.status === 503) return setState({ status: 'unconfigured' })
        if (!res.ok) return setState({ status: 'error' })
        const body = (await res.json()) as { data?: ProposalDto }
        if (!alive) return
        if (!body.data) return setState({ status: 'error' })
        setState({ status: 'ready', proposal: body.data })
      } catch {
        if (alive) setState({ status: 'error' })
      }
    })()
    return () => {
      alive = false
    }
  }, [open, transactionId])

  const reportedRef = useRef(false)
  useEffect(() => {
    if (state.status !== 'ready') return
    const p = state.proposal
    if (!p.account) return
    if (!reportedRef.current) {
      reportedRef.current = true
      const source = p.fromCandidate ? (p.candidates.find((c) => c.account === p.account)?.source ?? 'candidate') : 'category'
      onProposal?.({ account: p.account, confidence: p.confidence, agreement: p.agreement, modelConfidence: p.modelConfidence, source })
    }
    if (!autoApply) return
    // Only a pick with something behind it (a candidate, or a confident
    // model read) pre-fills; a low guess waits for the person.
    if (appliedRef.current === p.account || p.confidence < 0.5) return
    appliedRef.current = p.account
    onApply(p.account, p.vatTreatment ?? 'none')
  }, [state, autoApply, onApply, onProposal])

  const line = 'flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-muted-foreground'

  if (state.status === 'loading') {
    return (
      <p className={line}>
        <Sparkles className="h-3.5 w-3.5 animate-pulse" aria-hidden />
        {hasUnderlag ? t('ai_reading') : t('ai_looking')}
      </p>
    )
  }
  // No key configured (self-hosted without AI) or a failed call: the header
  // stands on its own, a line about the assistant's absence is noise.
  if (state.status === 'error' || state.status === 'unconfigured') return null

  const p = state.proposal
  const pick = p.account ? (p.candidates.find((c) => c.account === p.account) ?? null) : null
  const agrees = !!p.account && !!currentAccount && p.account === currentAccount
  const why = p.reasoning ? (expanded ? p.reasoning : firstSentence(p.reasoning)) : ''
  const hasMore = !!p.reasoning && why !== p.reasoning.trim()
  const more = hasMore ? (
    <button type="button" className={cn(QUIET_LINK_CLASS, 'text-[12px]')} onClick={() => setExpanded((v) => !v)}>
      {expanded ? t('ai_less') : t('ai_more')}
    </button>
  ) : null

  if (!p.account) {
    return (
      <p className={line}>
        <Sparkles className="h-3.5 w-3.5" aria-hidden />
        <span>
          {t('ai_none')}
          {why ? <span className="ml-1">{why}</span> : null}
        </span>
        {more}
      </p>
    )
  }

  const account = p.account
  const vat: VatTreatment | 'none' = p.vatTreatment ?? 'none'
  const label = pick?.label ?? ''
  const take = () => {
    if (onUsePick) return onUsePick({ account, vat, category: p.category, label })
    appliedRef.current = account
    onApply(account, vat)
  }

  return (
    <p className={line}>
      <Sparkles className={cn('h-3.5 w-3.5', agrees && 'text-success')} aria-hidden />
      {agrees ? (
        <span>
          {t('ai_agrees')}
          {why ? <span className="ml-1">{why}</span> : null}
        </span>
      ) : (
        <span>
          {t('ai_instead')} <span className="font-mono text-foreground">{account}</span>
          {label ? <span className="text-foreground"> {label}</span> : null}
          {vat === 'reverse_charge' ? <span className="text-foreground"> {t('ai_reverse_charge')}</span> : null}
          {why ? <span className="ml-1">· {why}</span> : null}
        </span>
      )}
      {more}
      {!agrees && (
        <button type="button" className={cn(QUIET_LINK_CLASS, 'text-[12px] font-medium')} onClick={take}>
          {t('ai_use')}
        </button>
      )}
    </p>
  )
}
