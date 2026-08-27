'use client'

import { useEffect, useSyncExternalStore } from 'react'

// Session-scoped cache of the company's own chart-of-accounts names, keyed
// by account_number. Module-level state is safe here: switching the active
// company always hard-reloads the page (CompanyTabSync / BankIdCompanyPicker
// call window.location.assign), so the map cannot outlive its company.
let accountNames: Map<string, string> | null = null
let started = false
const listeners = new Set<() => void>()

export function buildAccountNameMap(rows: unknown): Map<string, string> {
  const map = new Map<string, string>()
  if (!Array.isArray(rows)) return map
  for (const row of rows) {
    const number = (row as { account_number?: unknown })?.account_number
    const name = (row as { account_name?: unknown })?.account_name
    if (typeof number === 'string' && typeof name === 'string' && name) {
      map.set(number, name)
    }
  }
  return map
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const getSnapshot = () => accountNames
const getServerSnapshot = () => null

export function getCompanyAccountNames(): Map<string, string> | null {
  return accountNames
}

export async function ensureCompanyAccountNamesLoaded(): Promise<void> {
  if (started) return
  started = true
  try {
    // active=false includes deactivated accounts: historical verifikat keep
    // referencing them long after they leave the active chart.
    const res = await fetch('/api/bookkeeping/accounts?active=false')
    if (!res.ok) return
    const body: unknown = await res.json()
    accountNames = buildAccountNameMap((body as { data?: unknown })?.data)
    listeners.forEach((l) => l())
  } catch {
    // Degrade to the BAS reference names; no retry this session.
  }
}

/**
 * The company's chart-of-accounts names by account number, or null until
 * loaded. Kicks off one fetch per page load; all consumers share the result.
 */
export function useCompanyAccountNames(): Map<string, string> | null {
  const names = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  useEffect(() => {
    void ensureCompanyAccountNamesLoaded()
  }, [])
  return names
}
