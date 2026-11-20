'use client'

import { useEffect, useRef, useState } from 'react'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import type { AiClient } from '@/lib/onboarding/ai-clients'
import type { AiHandoff, RouteContext } from '@/lib/inkorg/missing'

const ADDRESS_URL = '/api/extensions/ext/invoice-inbox/inbox/address'
const WHATSAPP_URL = '/api/extensions/ext/whatsapp-inbox/link'
const HANDOFF_URL = '/api/receipt-hunt/agent-handoff'

async function readAddress(): Promise<string | null> {
  try {
    const res = await fetch(ADDRESS_URL)
    if (!res.ok) return null
    const json = (await res.json()) as { data?: { address?: string } }
    return json.data?.address || null
  } catch {
    return null
  }
}

async function readWhatsappLinked(): Promise<boolean> {
  // Not every deployment carries the WhatsApp door; without it there is no route to ask.
  if (!ENABLED_EXTENSION_IDS.has('whatsapp-inbox')) return false
  try {
    const res = await fetch(WHATSAPP_URL)
    if (!res.ok) return false
    const json = (await res.json()) as { data?: { linked?: boolean } }
    return json.data?.linked === true
  } catch {
    return false
  }
}

async function readHandoff(): Promise<AiHandoff | null> {
  try {
    const res = await fetch(HANDOFF_URL)
    if (!res.ok) return null
    const json = (await res.json()) as { data?: { clients?: AiClient[] } }
    return json.data ? { clients: json.data.clients ?? [] } : null
  } catch {
    return null
  }
}

export interface MissingContext {
  /** The company's ways in, for the route hints; null until read. */
  routes: RouteContext | null
  /** The receipt-hunt hand-off; null until read, and when its read failed (no AI button then). */
  handoff: AiHandoff | null
}

/**
 * What Saknar underlag needs beyond the purchases, read the first time the
 * view opens: the intake address and whether WhatsApp is linked (the route
 * hints, over the same reads Lägg till brevlåda makes) and which AI the
 * user has connected (the receipt-hunt hand-off, as the Underlag workspace
 * reads it). A failed read only leaves a hint or the AI button out. The
 * hand-off is read again when the user comes back to the tab, so a Claude
 * connected in another tab turns "Koppla Claude" into "Hämta med Claude".
 */
export function useMissingContext(enabled: boolean): MissingContext {
  const [routes, setRoutes] = useState<RouteContext | null>(null)
  const [handoff, setHandoff] = useState<AiHandoff | null>(null)
  const started = useRef(false)

  useEffect(() => {
    if (!enabled || started.current) return
    started.current = true
    void Promise.all([readAddress(), readWhatsappLinked()]).then(([intakeAddress, whatsappLinked]) =>
      setRoutes({ intakeAddress, whatsappLinked }),
    )
    void readHandoff().then(setHandoff)
  }, [enabled])

  useEffect(() => {
    if (!enabled) return
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      void readHandoff().then((next) => {
        // A failed re-read keeps what is on screen.
        if (next) setHandoff(next)
      })
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [enabled])

  return { routes, handoff }
}
