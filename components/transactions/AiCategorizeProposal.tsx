'use client'

import { useEffect, useRef, useState } from 'react'
import { Sparkles, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { VatTreatment } from '@/types'

/**
 * The auto-booking proposal, inline in the quick-review dialog.
 *
 * Fetches POST /api/agent/categorize (Tier 1 deterministic candidates → Tier 2
 * model selector, provider-agnostic) and shows the model's pick with a
 * confidence pill, a short "Varför", and the candidate alternatives. It
 * pre-fills the dialog's account + VAT when it lands on a real account, and
 * clicking an alternative re-applies. Nothing books here — the dialog's own
 * "Bokför" commits through the existing categorize route.
 *
 * i18n: strings are inline Swedish for now (this is the Swedish-answering
 * assistant surface); lift to messages/{sv,en}.json before final merge.
 */

interface CandidateDto {
  account: string
  label: string
  vatTreatment: VatTreatment | null
  source: string
  confidence: number
}

interface ProposalDto {
  account: string | null
  category: string | null
  vatTreatment: VatTreatment | null
  reverseCharge: boolean
  confidence: number
  agreement: number
  modelConfidence: 'high' | 'medium' | 'low'
  fromCandidate: boolean
  reasoning: string
  choice: { kind: 'candidate' | 'category' | 'needs_review' }
  candidates: CandidateDto[]
}

/** What the dialog needs to log a calibration sample when the user books. */
export interface AiProposalMeta {
  account: string
  confidence: number
  agreement: number
  modelConfidence: 'high' | 'medium' | 'low'
  source: string
}

type State =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'unconfigured' }
  | { status: 'ready'; proposal: ProposalDto }

interface Props {
  transactionId: string
  /** Fetch when the dialog is open. */
  open: boolean
  /** Apply an account + VAT to the dialog fields. */
  onApply: (account: string, vat: VatTreatment | 'none') => void
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

const BAND_LABEL: Record<Band, string> = { sure: 'Säker', likely: 'Trolig', review: 'Välj konto' }

export default function AiCategorizeProposal({ transactionId, open, onApply, onProposal }: Props) {
  const [state, setState] = useState<State>({ status: 'loading' })
  // Apply the pick to the dialog exactly once per fetch, so the user's later
  // manual edits are never clobbered by a re-render.
  const appliedRef = useRef<string | null>(null)

  useEffect(() => {
    if (!open) return
    let alive = true
    appliedRef.current = null
    // Initial state is already 'loading'; the dialog mounts this fresh per
    // transaction (keyed on tx.id), so no in-effect reset is needed.
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

  // When a proposal with a real account arrives: surface its metadata to the
  // dialog (for calibration logging on book) and pre-fill the fields.
  useEffect(() => {
    if (state.status !== 'ready') return
    const p = state.proposal
    if (!p.account) return

    if (!reportedRef.current) {
      reportedRef.current = true
      const source = p.fromCandidate
        ? (p.candidates.find((c) => c.account === p.account)?.source ?? 'candidate')
        : 'category'
      onProposal?.({
        account: p.account,
        confidence: p.confidence,
        agreement: p.agreement,
        modelConfidence: p.modelConfidence,
        source,
      })
    }

    // Pre-fill only when it's not the low "review" band, and only once.
    if (appliedRef.current === p.account || bandOf(p) === 'review') return
    appliedRef.current = p.account
    onApply(p.account, p.vatTreatment ?? 'none')
  }, [state, onApply, onProposal])

  if (state.status === 'loading') {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-secondary/30 px-3 py-2.5 text-sm text-muted-foreground">
        <Sparkles className="h-3.5 w-3.5 animate-pulse" />
        Assistenten föreslår kontering…
      </div>
    )
  }

  if (state.status === 'error') return null // fall back silently to the deterministic default

  if (state.status === 'unconfigured') {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-border bg-secondary/30 px-3 py-2.5 text-xs text-muted-foreground">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
        Assistenten är inte konfigurerad. Välj konto nedan som vanligt.
      </div>
    )
  }

  const p = state.proposal
  const band = bandOf(p)
  const alternatives = p.candidates.filter((c) => c.account !== p.account).slice(0, 3)

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-start justify-between gap-3 px-3 pt-3">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Sparkles className="h-3.5 w-3.5" />
          Assistentens förslag
        </div>
        <span
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium',
            band === 'sure' && 'bg-success/15 text-success',
            band === 'likely' && 'bg-warning/15 text-warning',
            band === 'review' && 'bg-secondary text-muted-foreground',
          )}
        >
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              band === 'sure' && 'bg-success',
              band === 'likely' && 'bg-warning',
              band === 'review' && 'bg-muted-foreground',
            )}
          />
          {BAND_LABEL[band]}
        </span>
      </div>

      <div className="px-3 pb-3 pt-2">
        {band === 'review' ? (
          <p className="text-sm text-foreground">
            {p.reasoning || 'För lite underlag för att avgöra konto. Välj konto nedan.'}
          </p>
        ) : (
          <>
            {p.reasoning && (
              <p className="text-[13px] leading-snug text-muted-foreground">{p.reasoning}</p>
            )}
            {alternatives.length > 0 && (
              <div className="mt-2.5">
                <p className="mb-1.5 text-[11px] text-muted-foreground">Byt konto:</p>
                <div className="flex flex-wrap gap-1.5">
                  {alternatives.map((c) => (
                    <button
                      key={c.account}
                      type="button"
                      onClick={() => {
                        appliedRef.current = c.account
                        onApply(c.account, c.vatTreatment ?? 'none')
                      }}
                      className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-xs transition-colors hover:bg-secondary"
                    >
                      <span className="font-mono">{c.account}</span>
                      <span className="text-muted-foreground">{c.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
