'use client'

import { useCallback, useState } from 'react'

/**
 * Wraps an async submit function so that responses of the form
 * `{ error: { code: 'ACCOUNTS_NOT_IN_CHART', account_numbers } }` trigger a
 * dialog-and-retry flow instead of surfacing as a generic error.
 *
 * The consumer renders <ActivateAccountsDialog> bound to `dialog.open`,
 * `dialog.accountNumbers`, `confirm`, and `cancel`. On confirm the missing
 * accounts are activated and the original submit runs again automatically.
 *
 * The submit fn should throw with a cause object containing the parsed
 * response body so we can read the structured error. Convention:
 *   throw Object.assign(new Error(body.error.message), { body, status })
 */

interface DialogState {
  open: boolean
  accountNumbers: string[]
}

interface StructuredError {
  code?: string
  account_numbers?: string[]
  message?: string
}

function extractAccountsNotInChart(err: unknown): string[] | null {
  if (typeof err !== 'object' || err === null) return null
  const anyErr = err as { body?: { error?: StructuredError } }
  const structured = anyErr.body?.error
  if (structured?.code === 'ACCOUNTS_NOT_IN_CHART' && Array.isArray(structured.account_numbers)) {
    return structured.account_numbers
  }
  return null
}

export function useSubmitWithAccountActivation<T>(
  submit: () => Promise<T>
) {
  const [dialog, setDialog] = useState<DialogState>({ open: false, accountNumbers: [] })
  const [pendingResolve, setPendingResolve] = useState<null | ((value: T | null) => void)>(null)
  const [pendingReject, setPendingReject] = useState<null | ((err: unknown) => void)>(null)

  const runSubmit = useCallback(async (): Promise<T> => {
    try {
      return await submit()
    } catch (err) {
      const missing = extractAccountsNotInChart(err)
      if (!missing) throw err

      // Open dialog and wait for the user to confirm or cancel.
      return new Promise<T>((resolve, reject) => {
        setPendingResolve(() => (value: T | null) => {
          if (value === null) reject(new Error('cancelled'))
          else resolve(value)
        })
        setPendingReject(() => reject)
        setDialog({ open: true, accountNumbers: missing })
      })
    }
  }, [submit])

  const confirm = useCallback(async () => {
    const numbers = dialog.accountNumbers
    try {
      const res = await fetch('/api/bookkeeping/accounts/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_numbers: numbers }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw Object.assign(new Error('Kunde inte aktivera konton'), { body, status: res.status })
      }
      // Retry the original submit
      const result = await submit()
      setDialog({ open: false, accountNumbers: [] })
      pendingResolve?.(result as T | null)
      setPendingResolve(null)
      setPendingReject(null)
    } catch (err) {
      setDialog({ open: false, accountNumbers: [] })
      pendingReject?.(err)
      setPendingResolve(null)
      setPendingReject(null)
    }
  }, [dialog.accountNumbers, submit, pendingResolve, pendingReject])

  const cancel = useCallback(() => {
    setDialog({ open: false, accountNumbers: [] })
    pendingReject?.(new Error('cancelled'))
    setPendingResolve(null)
    setPendingReject(null)
  }, [pendingReject])

  return { runSubmit, dialog, confirm, cancel }
}

/**
 * Small helper: parse a Response and throw a shaped error that
 * useSubmitWithAccountActivation can recognize. Callers use this inside
 * their submit fn so the hook can pick up ACCOUNTS_NOT_IN_CHART.
 */
export async function throwOnStructuredError(response: Response): Promise<unknown> {
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw Object.assign(new Error(extractMessage(body) || `HTTP ${response.status}`), {
      body,
      status: response.status,
    })
  }
  return body
}

function extractMessage(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const obj = body as { error?: unknown }
  if (typeof obj.error === 'string') return obj.error
  if (typeof obj.error === 'object' && obj.error !== null) {
    const e = obj.error as { message?: unknown }
    if (typeof e.message === 'string') return e.message
  }
  return null
}
