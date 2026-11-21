'use client'

import { useEffect, useState } from 'react'
import { fetchSigningAvailability, SIGNING_UNAVAILABLE_VIEW, type SigningAvailabilityView } from './signing-client'

/**
 * One read of GET /api/signing/availability per page load, shared by every
 * component that asks (the Arkiv record, the Signeringar page, the
 * årsredovisning page, the plan card): what to offer that starts or chases a
 * signing. All false until it answered, and all false when the read fails,
 * so a broken read never offers a dead flow. `known` is true once the server
 * answered: only then may a page say signing is not offered or not in the
 * plan, rather than that nothing was found.
 */
type SigningAvailabilityAnswer = SigningAvailabilityView & { known: boolean }

const UNKNOWN: SigningAvailabilityAnswer = { ...SIGNING_UNAVAILABLE_VIEW, known: false }

let shared: Promise<SigningAvailabilityAnswer> | null = null

function readAvailability(): Promise<SigningAvailabilityAnswer> {
  shared ??= fetchSigningAvailability().then(
    (view) => ({ ...view, known: true }),
    () => {
      shared = null
      return UNKNOWN
    },
  )
  return shared
}

export function useSigningAvailability(): SigningAvailabilityAnswer {
  const [availability, setAvailability] = useState<SigningAvailabilityAnswer>(UNKNOWN)
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
