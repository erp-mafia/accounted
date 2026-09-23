'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Dossier } from '@/lib/parties/register'
import { registrySummary, type RegistrySummary } from '@/lib/parties/registry-summary'

/**
 * The party behind a supplier or customer row, for the row's own page. One
 * fetch feeds the Företagsuppgifter block and the "från SCB" notes on the
 * contact rows, so the two never disagree about what the register said.
 */
export function usePartyDossier(partyId: string | null | undefined): {
  dossier: Dossier | null
  registry: RegistrySummary | null
  scbEnabled: boolean
  loaded: boolean
  reload: () => Promise<void>
} {
  const [dossier, setDossier] = useState<Dossier | null>(null)
  const [scbEnabled, setScbEnabled] = useState(false)
  const [loaded, setLoaded] = useState(!partyId)

  const reload = useCallback(async () => {
    if (!partyId) return
    try {
      const res = await fetch(`/api/parties/${partyId}`)
      if (!res.ok) throw new Error(String(res.status))
      const json = (await res.json()) as { data: Dossier | null; scbConfigured?: boolean }
      setDossier(json.data)
      setScbEnabled(!!json.scbConfigured)
    } catch {
      setDossier(null)
    } finally {
      setLoaded(true)
    }
  }, [partyId])

  useEffect(() => {
    void reload()
  }, [reload])

  const registry = useMemo(() => (dossier ? registrySummary(dossier.facts) : null), [dossier])
  return { dossier, registry, scbEnabled, loaded, reload }
}
