'use client'

import { useEffect, useState } from 'react'

// Polls GET /api/documents/:id/extraction-status until the AI extraction
// pipeline completes, fails, or times out. Returns the derived status the
// upload UI binds to.
//
// "Disabled" semantics: if the document-extraction extension isn't enabled
// (the column stays NULL forever), we don't know server-side. Instead we
// stop polling after EXTRACTION_TIMEOUT_MS and bubble status='disabled' so
// the UI can quietly fall back ("Uppladdat" without an AI hint) — no scary
// error for a feature the customer didn't pay for.
//
// Reasonable timeout: typical extraction takes 2–8s on Sonnet via Bedrock.
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
        // Network blip — keep polling.
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
