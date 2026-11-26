'use client'

import { useEffect, useRef, useState } from 'react'
import type { BooksFindings } from '@/lib/onboarding/findings'
import { aiConnectionFromWire, type AiClient, type AiConnection } from '@/lib/onboarding/ai-clients'
import { createAiStatusPoller, type AiStatusPoller } from '@/lib/onboarding/ai-status-poll'

/** Null when the status is unavailable: the chips keep what they last showed. */
async function fetchAiStatus(signal: AbortSignal): Promise<AiConnection | null> {
  try {
    const res = await fetch('/api/onboarding/ai-status', { signal })
    if (!res.ok) return null
    const json = (await res.json()) as { data: { connected: AiClient[]; agentConnected?: boolean } }
    return aiConnectionFromWire(json.data.connected, json.data.agentConnected)
  } catch {
    // Safe to ignore: null keeps what the chips last showed, and the next poll or focus asks again.
    return null
  }
}

/**
 * The AI connection of the books act: what the findings say, refreshed by
 * the status poller. The OAuth sign-in happens in another tab, so a chip
 * turns green by asking the status route (one api_keys read, never the
 * findings): in a bounded window after an Anslut click, and once when the
 * user comes back.
 */
export function useAiConnection(findings: BooksFindings | null) {
  const [preferredClient, setPreferredClient] = useState<AiClient>()
  const [polled, setPolled] = useState<AiConnection | null>(null)
  const pollerRef = useRef<AiStatusPoller | null>(null)

  useEffect(() => {
    const poller = createAiStatusPoller({
      fetchStatus: fetchAiStatus,
      onStatus: setPolled,
      isHidden: () => document.visibilityState === 'hidden',
    })
    pollerRef.current = poller
    const onFocus = () => poller.check()
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      poller.stop()
      pollerRef.current = null
    }
  }, [])

  const onConnect = (client: AiClient) => {
    setPreferredClient(client)
    pollerRef.current?.attempt(client)
  }
  const connection = polled ?? aiConnectionFromWire(findings?.ai.connected ?? [], findings?.ai.agentConnected)
  return { connection, connected: connection.clients, preferredClient, onConnect }
}
