'use client'

import { useEffect, useState } from 'react'
import { fetchSigningAvailability } from './signing-client'

/**
 * One read of GET /api/signing/availability per page load, shared by every
 * component that asks (the Arkiv record, the Signeringar page): whether to
 * offer anything that starts or chases a signing. False until it answered,
 * and false when the read fails, so a broken read never offers a dead flow.
 */
let shared: Promise<boolean> | null = null

function readAvailability(): Promise<boolean> {
  shared ??= fetchSigningAvailability().catch(() => {
    shared = null
    return false
  })
  return shared
}

export function useSigningAvailability(): boolean {
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    let cancelled = false
    void readAvailability().then((value) => {
      if (!cancelled) setAvailable(value)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return available
}
