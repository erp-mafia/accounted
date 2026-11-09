'use client'

import { useCallback, useRef, useSyncExternalStore, type SetStateAction } from 'react'
import { usePathname } from 'next/navigation'
import { decodePageState } from '@/lib/navigation/page-state'
import { useCompanyOptional } from '@/contexts/CompanyContext'

const values = new Map<string, unknown>()
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }

function read<T>(key: string, initial: T): T {
  if (values.has(key)) return values.get(key) as T
  let value = initial
  try {
    value = decodePageState(sessionStorage.getItem(key), initial)
  } catch { /* Disabled or malformed storage only loses the view preference. */ }
  values.set(key, value)
  return value
}

/** Preserve per-tab, per-company view choices without storing report or accounting data. */
export function usePageState<T>(name: string, initial: T) {
  const companyId = useCompanyOptional()?.company?.id
  const pathname = usePathname()
  const initialRef = useRef(initial)
  const key = `Accounted:view:${companyId ?? 'none'}:${pathname}:${name}`
  const state = useSyncExternalStore(subscribe, () => read(key, initialRef.current), () => initialRef.current)
  const setState = useCallback((next: SetStateAction<T>) => {
    const current = read(key, initialRef.current)
    const value = typeof next === 'function' ? (next as (previous: T) => T)(current) : next
    values.set(key, value)
    if (companyId) {
      try { sessionStorage.setItem(key, JSON.stringify(value instanceof Set ? [...value] : value)) } catch { /* Memory still preserves back navigation. */ }
    }
    listeners.forEach(listener => listener())
  }, [key, companyId])
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false)
  return [state, setState, hydrated] as const
}
