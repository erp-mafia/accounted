'use client'

import { useEffect, useState } from 'react'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import type { ProposalLine } from '@/lib/bookkeeping/proposal-lines'
import type { ProposalPreviewRequest } from '@/lib/bookkeeping/proposal-preview'

export type { ProposalPreviewRequest }

/** A refused or failed preview, its message already in Swedish. */
export class ProposalPreviewError extends Error {}

/**
 * The lines a proposal books, from POST /api/bookkeeping/proposal-preview:
 * built on the server by the code the booking posts with.
 */
export async function fetchProposalPreview(
  request: ProposalPreviewRequest,
  signal?: AbortSignal,
): Promise<ProposalLine[]> {
  const res = await fetch('/api/bookkeeping/proposal-preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new ProposalPreviewError(getErrorMessage(body))
  return (body?.data?.lines ?? []) as ProposalLine[]
}

export interface ProposalPreviewState {
  lines: ProposalLine[]
  /** A request for the current proposal is on its way; `lines` are the last answer meanwhile. */
  loading: boolean
  error: string | null
}

const IDLE: ProposalPreviewState = { lines: [], loading: false, error: null }

/** The last answer, and the request it answered. */
interface Answer {
  body: string
  refreshKey: string
  lines: ProposalLine[]
  error: string | null
}

/**
 * The preview of `request`, refetched when it changes (debounced, the last
 * request wins). The last lines stay while the next answer is on its way, so
 * typing an amount does not blink the kontering; a refusal clears them, as a
 * refused proposal books nothing. `null` asks for nothing. `refreshKey` asks
 * again for the same request when what the server reads changed (a row's
 * SEK backfill).
 */
export function useProposalPreview(
  request: ProposalPreviewRequest | null,
  { refreshKey = '', delayMs = 150 }: { refreshKey?: string; delayMs?: number } = {},
): ProposalPreviewState {
  const body = request ? JSON.stringify(request) : null
  const [answer, setAnswer] = useState<Answer | null>(null)

  useEffect(() => {
    if (!body) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      fetchProposalPreview(JSON.parse(body) as ProposalPreviewRequest, controller.signal)
        .then((lines) => {
          if (!controller.signal.aborted) setAnswer({ body, refreshKey, lines, error: null })
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return
          const error = err instanceof ProposalPreviewError ? err.message : getErrorMessage(err)
          setAnswer({ body, refreshKey, lines: [], error })
        })
    }, delayMs)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [body, refreshKey, delayMs])

  if (!body) return IDLE
  const current = answer !== null && answer.body === body && answer.refreshKey === refreshKey
  if (current) return { lines: answer.lines, loading: false, error: answer.error }
  return { lines: answer?.lines ?? [], loading: true, error: null }
}
