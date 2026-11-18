'use client'

import { useEffect, useState } from 'react'
import { CheckCircleIcon, ExclamationTriangleIcon } from '@/components/icons'
import { Badge } from '@/components/ui/badge'
import { Skeleton, LateReveal } from '@/components/ui/skeleton'
import { LoadError } from '@/components/ui/empty-state'
import { formatCurrency } from '@/lib/utils'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import type { StatementReconciliation } from '@/lib/reports/statement-reconciliation'

interface StatementReconciliationPanelProps {
  periodId: string
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: StatementReconciliation }

/**
 * Årets resultat from the ledger, the declaration and the resultaträkning,
 * side by side, right after the bokslut is executed: the moment a mismatch
 * between the årsredovisning and INK2/NE can still be fixed before filing.
 * The figures, notes and disagreement texts come from
 * lib/reports/statement-reconciliation.ts; this panel only lays them out.
 * Swedish like the rest of the year-end wizard.
 */
export function StatementReconciliationPanel({ periodId }: StatementReconciliationPanelProps) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  // Bumped by "Försök igen" to fetch the same period again.
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/reports/statement-reconciliation?period_id=${encodeURIComponent(periodId)}`)
      .then(async (res) => {
        const body = await res.json().catch(() => null)
        if (cancelled) return
        if (!res.ok || !body) {
          setState({
            kind: 'error',
            message: getErrorMessage(body?.error) ?? 'Avstämningen kunde inte hämtas.',
          })
          return
        }
        setState({ kind: 'ready', data: body as StatementReconciliation })
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'error', message: 'Avstämningen kunde inte hämtas.' })
      })
    return () => {
      cancelled = true
    }
  }, [periodId, attempt])

  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-2 px-1">
        <h3 className="font-sans text-xs font-medium text-muted-foreground">
          Årets resultat i rapporterna
        </h3>
        {state.kind === 'ready' &&
          (state.data.isReconciled ? (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <CheckCircleIcon className="h-3.5 w-3.5" />
              Stämmer
            </span>
          ) : (
            <Badge variant="destructive" className="gap-1">
              <ExclamationTriangleIcon className="h-3 w-3" />
              Avvikelser
            </Badge>
          ))}
      </div>

      {state.kind === 'loading' && (
        <LateReveal className="space-y-2 px-1" role="status" aria-label="Hämtar avstämningen">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-full" />
        </LateReveal>
      )}

      {state.kind === 'error' && (
        <LoadError
          title={state.message}
          onRetry={() => {
            setState({ kind: 'loading' })
            setAttempt((n) => n + 1)
          }}
        />
      )}

      {state.kind === 'ready' && (
        <div className="space-y-4 px-1">
          <div className="space-y-3 text-sm">
            {state.data.figures.map((figure) => (
              <div
                key={figure.surface}
                className="flex items-start justify-between gap-4 border-b-hairline pb-3 last:border-b-0 last:pb-0"
              >
                <div className="min-w-0">
                  <p className="text-muted-foreground">{figure.surface}</p>
                  {figure.note && (
                    <p className="text-xs leading-5 text-muted-foreground">{figure.note}</p>
                  )}
                </div>
                <span className="shrink-0 font-medium tabular-nums">
                  {figure.aretsResultat === null ? 'Saknas' : formatCurrency(figure.aretsResultat)}
                </span>
              </div>
            ))}
          </div>

          {state.data.disagreements.map((text) => (
            <div key={text} className="flex items-start gap-2 text-sm text-destructive">
              <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{text}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
