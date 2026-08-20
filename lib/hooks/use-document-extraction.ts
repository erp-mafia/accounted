'use client'

import { useEffect, useState } from 'react'

// Polls GET /api/documents/:id/extraction-status until the AI extraction
// pipeline completes, fails, or times out. Returns the derived status the
// upload UI binds to.
//
// "Disabled" semantics: the server answers 'disabled' as soon as it knows
// no extraction will happen (AI not configured on this deployment, company
// not entitled, self-generated document: see the route), so the UI can
// quietly fall back ("Uppladdat" without an AI hint) on the first poll: no
// scary error for a feature the customer didn't pay for, and no 30 s hang
// on a self-host without an AI key. The client-side timeout stays as the
// last resort for the one case the server cannot see: the
// document-extraction extension switched off entirely (the column stays
// NULL forever).
//
// Reasonable timeout: typical extraction takes 2-8s on Sonnet via Bedrock.
// 30s is generous and keeps the UX responsive on flaky links.

const POLL_INTERVAL_MS = 1500
const EXTRACTION_TIMEOUT_MS = 30_000

export type ExtractionStatus =
  | 'idle'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'unsupported'
  | 'disabled'

interface State {
  status: ExtractionStatus
  // Hint to consumers: how long we've been polling. Lets the UI swap the
  // copy after a few seconds ("Läser fakturan…" → "Tar lite längre än
  // vanligt…") without re-rendering.
  elapsedMs: number
}

export function useDocumentExtraction(documentId: string | null | undefined): State {
  const [state, setState] = useState<State>({ status: 'idle', elapsedMs: 0 })

  useEffect(() => {
    if (!documentId) {
      setState({ status: 'idle', elapsedMs: 0 })
      return
    }

    let cancelled = false
    const startedAt = Date.now()
    setState({ status: 'running', elapsedMs: 0 })

    async function tick(): Promise<void> {
      if (cancelled) return
      const elapsedMs = Date.now() - startedAt

      if (elapsedMs > EXTRACTION_TIMEOUT_MS) {
        setState({ status: 'disabled', elapsedMs })
        return
      }

      try {
        const res = await fetch(`/api/documents/${documentId}/extraction-status`)
        if (cancelled) return
        if (res.ok) {
          const json = (await res.json()) as {
            data: { status: ExtractionStatus }
          }
          const status = json.data.status
          if (status !== 'running') {
            setState({ status, elapsedMs })
            return
          }
          setState({ status: 'running', elapsedMs })
        }
        // Non-ok responses fall through to retry; transient 5xx shouldn't
        // collapse the UI to "failed".
      } catch {
        // Network blip: keep polling.
      }

      setTimeout(() => {
        if (!cancelled) void tick()
      }, POLL_INTERVAL_MS)
    }

    void tick()

    return () => {
      cancelled = true
    }
  }, [documentId])

  return state
}
