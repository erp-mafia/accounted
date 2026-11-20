'use client'

import { createContext, useContext, type ReactNode } from 'react'

/**
 * The request's CSP nonce (src/proxy.ts), for client components that load a
 * script themselves. next/script receives the nonce automatically only while
 * it renders on the server; the script element it inserts on the client
 * carries a nonce only when one is passed as a prop, and the root layout is
 * the one place that can read it from the request.
 */
const NonceContext = createContext<string | undefined>(undefined)

export function NonceProvider({
  nonce,
  children,
}: {
  nonce: string | undefined
  children: ReactNode
}) {
  return <NonceContext.Provider value={nonce}>{children}</NonceContext.Provider>
}

/** The request's CSP nonce, or undefined outside a proxied render. */
export function useNonce(): string | undefined {
  return useContext(NonceContext)
}
