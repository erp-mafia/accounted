'use client'

import { Suspense, useEffect, useRef } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'

/**
 * Opens something the page already has (its create drawer, its upload) when
 * the URL carries a bare query parameter, so a button outside the page (the
 * area sidebar's create button, the rail's plus) can link to it:
 * /transactions?new, /arkiv?upload. The parameter is consumed, so a reload
 * or the back button does not open it again. Renders nothing.
 */
export function OpenOnParam({ param, onOpen }: { param: string; onOpen: () => void }) {
  return (
    // useSearchParams needs a Suspense boundary on a server-rendered page.
    <Suspense fallback={null}>
      <OpenOnParamInner param={param} onOpen={onOpen} />
    </Suspense>
  )
}

function OpenOnParamInner({ param, onOpen }: { param: string; onOpen: () => void }) {
  const searchParams = useSearchParams()
  const pathname = usePathname()
  const latest = useRef(onOpen)
  useEffect(() => {
    latest.current = onOpen
  }, [onOpen])

  const wanted = searchParams.has(param)
  const rest = (() => {
    const next = new URLSearchParams(searchParams.toString())
    next.delete(param)
    return next.toString()
  })()
  useEffect(() => {
    if (!wanted) return
    // The History API, which Next keeps in step with useSearchParams: a
    // router.replace here was dropped on pages that navigate on mount.
    window.history.replaceState(null, '', rest ? `${pathname}?${rest}` : pathname)
    latest.current()
  }, [wanted, rest, pathname])
  return null
}
