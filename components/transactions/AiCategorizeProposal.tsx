'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import type { VatTreatment } from '@/types'

/**
 * The assistant's verdict inside the recommendation header of the review
 * dialog: one line, not a box. It fetches POST /api/agent/categorize (the
 * deterministic candidates, then the model's pick, with the matched
 * receipt's text when there is one) and says one of three things: it
 * agrees with the current pick, it suggests another account (with why and
 * a way to take it), or it is unsure. It pre-fills the dialog only when the
 * dialog has no template of its own; a rule or a learned counterpart is
 * never overridden by the model. Nothing books here.
 */
interface CandidateDto {
  account: string
  label: string
  vatTreatment: VatTreatment | 'none' | null
  source: string
}

interface ProposalDto {
  account: string | null
  vatTreatment: VatTreatment | 'none' | null
  confidence: number
  modelConfidence?: number
  agreement?: boolean
  fromCandidate: boolean
  choice: { kind: 'account' | 'needs_review' }
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

type State =
  | { status: 'loading' }
  | { status: 'ready'; proposal: ProposalDto }
  | { status: 'error' }
  | { status: 'unconfigured' }

interface Props {
  transactionId: string
  /** Fetch when the dialog is open. */
  open: boolean
  /** The business account the dialog currently books to, for the agree check. */
  currentAccount?: string | null
  /** Pre-fill the dialog with the pick when it lands; off when the dialog already has a template. */
  autoApply?: boolean
  /** Apply an account + VAT to the dialog fields. */
  onApply: (account: string, vat: VatTreatment | 'none') => void
  /**
   * When set, the dialog books through a template and an account cannot be
   * applied directly: the pick and the alternatives open the template
   * picker searched on that account instead.
   */
  onShowTemplates?: (account: string) => void
  /** Surface the proposal metadata so the dialog can log a calibration sample on book. */
  onProposal?: (meta: AiProposalMeta) => void
}

type Band = 'sure' | 'likely' | 'review'

function bandOf(p: ProposalDto): Band {
  if (p.choice.kind === 'needs_review' || !p.account) return 'review'
  if (p.confidence >= 0.8) return 'sure'
  if (p.confidence >= 0.5) return 'likely'
  return 'review'
}

export default function AiCategorizeProposal({ transactionId, open, currentAccount, autoApply = true, onApply, onShowTemplates, onProposal }: Props) {
  const t = useTranslations('tx_quick_review')
  const [state, setState] = useState<State>({ status: 'loading' })
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
    if (appliedRef.current === p.account || bandOf(p) === 'review') return
    appliedRef.current = p.account
    onApply(p.account, p.vatTreatment ?? 'none')
  }, [state, autoApply, onApply, onProposal])

  const line = 'flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-muted-foreground'

  if (state.status === 'loading') {
    return (
      <p className={line}>
        <Sparkles className="h-3.5 w-3.5 animate-pulse" aria-hidden />
        {t('ai_reading')}
      </p>
    )
  }
  if (state.status === 'error') return null
  if (state.status === 'unconfigured') {
    return (
      <p className={line}>
        <Sparkles className="h-3.5 w-3.5" aria-hidden />
        {t('ai_unconfigured')}
      </p>
    )
  }

  const p = state.proposal
  const band = bandOf(p)
  const pick = p.account ? (p.candidates.find((c) => c.account === p.account) ?? null) : null
  const agrees = !!p.account && !!currentAccount && p.account === currentAccount
  const alternatives = p.candidates.filter((c) => c.account !== p.account && c.account !== currentAccount).slice(0, 3)

  if (band === 'review') {
    return (
      <p className={line}>
        <Sparkles className="h-3.5 w-3.5" aria-hidden />
        {t('ai_unsure', { reason: p.reasoning || '' })}
      </p>
    )
  }

  return (
    <div className="space-y-1">
      <p className={line}>
        <Sparkles className={cn('h-3.5 w-3.5', agrees && 'text-success')} aria-hidden />
        {agrees ? (
          <span>
            {t('ai_agrees')}
            {p.reasoning ? <span className="ml-1">{p.reasoning}</span> : null}
          </span>
        ) : (
          <>
            <span>
              {t('ai_instead')} <span className="font-mono text-foreground">{p.account}</span>
              {pick?.label ? <span className="text-foreground"> {pick.label}</span> : null}
              {p.reasoning ? <span className="ml-1">· {p.reasoning}</span> : null}
            </span>
            <button
              type="button"
              className={cn(QUIET_LINK_CLASS, 'text-[12px]')}
              onClick={() => {
                if (onShowTemplates) return onShowTemplates(p.account as string)
                appliedRef.current = p.account
                onApply(p.account as string, p.vatTreatment ?? 'none')
              }}
            >
              {onShowTemplates ? t('ai_show_templates') : t('ai_use')}
            </button>
          </>
        )}
      </p>
      {alternatives.length > 0 && (
        <p className={line}>
          <span>{t('ai_alternatives')}:</span>
          {alternatives.map((c) => (
            <button
              key={c.account}
              type="button"
              onClick={() => {
                if (onShowTemplates) return onShowTemplates(c.account)
                appliedRef.current = c.account
                onApply(c.account, c.vatTreatment ?? 'none')
              }}
              className={cn(QUIET_LINK_CLASS, 'text-[12px]')}
            >
              <span className="font-mono">{c.account}</span> {c.label}
            </button>
          ))}
        </p>
      )}
    </div>
  )
}
