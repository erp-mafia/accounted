'use client'

import { useEffect, useRef, useState } from 'react'
import { registryLookupKey, type RegistryLookup, type RegistryLookupFound } from '@/lib/parties/registry-form-fill'

export type RegistryAutofillState =
  | { status: 'idle' }
  | { status: 'looking' }
  /** A company was found and these form fields were set from it. */
  | { status: 'filled'; name: string; fields: string[] }
  /** A company was found but every field it knows was already typed. */
  | { status: 'found'; name: string }
  | { status: 'not_found'; orgNumber: string }

const DEBOUNCE_MS = 400

/**
 * Looks a typed org number up in the register once it is complete and
 * valid, and hands a found company to `apply`. One lookup per distinct
 * number per form (answers are kept, so retyping a number costs nothing),
 * none for the number the form opened with (an edit dialog must not fetch
 * on open), none for a personnummer, and none at all once the environment
 * has said it has no SCB credentials (503). A failed lookup leaves the form
 * as it is: no toast, no spinner, the person keeps typing.
 */
export function useRegistryAutofill({
  orgNumber,
  enabled,
  initialOrgNumber,
  apply,
}: {
  /** The org number field as typed. */
  orgNumber: string | null | undefined
  /** False while the row is not a Swedish company, or the person cannot write. */
  enabled: boolean
  /** The value the form opened with: only a change from it triggers a lookup. */
  initialOrgNumber?: string | null
  /** Sets form fields from a found company; returns the names of the fields it set. */
  apply: (now: RegistryLookupFound, before: RegistryLookupFound | null) => string[]
}): RegistryAutofillState {
  const [state, setState] = useState<RegistryAutofillState>({ status: 'idle' })
  const applyRef = useRef(apply)
  useEffect(() => {
    applyRef.current = apply
  }, [apply])
  const answers = useRef(new Map<string, RegistryLookup>())
  const unavailable = useRef(false)
  const lastApplied = useRef<RegistryLookupFound | null>(null)
  const opened = useRef(registryLookupKey(initialOrgNumber))
  /** The key the current state describes; null while idle. */
  const shown = useRef<string | null>(null)

  const key = enabled ? registryLookupKey(orgNumber) : null

  useEffect(() => {
    if (key === shown.current) return
    const quiet = () => {
      shown.current = null
      setState((s) => (s.status === 'idle' ? s : { status: 'idle' }))
    }
    if (!key || key === opened.current || unavailable.current) {
      quiet()
      return
    }
    const settle = (result: RegistryLookup) => {
      shown.current = key
      if (!result.found) {
        setState({ status: 'not_found', orgNumber: result.orgNumber })
        return
      }
      const fields = applyRef.current(result, lastApplied.current)
      lastApplied.current = result
      setState(fields.length > 0 ? { status: 'filled', name: result.name, fields } : { status: 'found', name: result.name })
    }
    const known = answers.current.get(key)
    if (known) {
      settle(known)
      return
    }
    const ctrl = new AbortController()
    const timer = setTimeout(async () => {
      setState({ status: 'looking' })
      try {
        const res = await fetch(`/api/parties/registry?org_number=${encodeURIComponent(key)}`, { signal: ctrl.signal })
        if (res.status === 503) unavailable.current = true
        const json = res.ok ? ((await res.json()) as { data?: RegistryLookup }) : null
        if (!json?.data) {
          quiet()
          return
        }
        answers.current.set(key, json.data)
        settle(json.data)
      } catch {
        if (!ctrl.signal.aborted) quiet()
      }
    }, DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      ctrl.abort()
    }
  }, [key])

  return state
}
