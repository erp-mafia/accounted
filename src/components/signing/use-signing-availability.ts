'use client'

import { useEffect, useState } from 'react'
import { fetchSigningAvailability, SIGNING_UNAVAILABLE_VIEW, type SigningAvailabilityView } from './signing-client'

/**
 * One read of GET /api/signing/availability per page load, shared by every
 * component that asks (the Arkiv record, the Signeringar page, the
 * årsredovisning page, the plan card): what to offer that starts or chases a
 * signing. All false until it answered, and all false when the read fails,
 * so a broken read never offers a dead flow.
 */
let shared: Promise<SigningAvailabilityView> | null = null

function readAvailability(): Promise<SigningAvailabilityView> {
  shared ??= fetchSigningAvailability().catch(() => {
    shared = null
    return SIGNING_UNAVAILABLE_VIEW
  })
  return shared
}

export function useSigningAvailability(): SigningAvailabilityView {
  const [availability, setAvailability] = useState<SigningAvailabilityView>(SIGNING_UNAVAILABLE_VIEW)
  useEffect(() => {
    let cancelled = false
    void readAvailability().then((value) => {
      if (!cancelled) setAvailability(value)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return availability
}
