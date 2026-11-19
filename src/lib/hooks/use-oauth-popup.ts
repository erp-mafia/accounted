'use client'

import { useEffect, useRef, type RefObject } from 'react'

/**
 * OAuth popups and tabs (Skatteverket, Enable Banking, the migration
 * providers) report their outcome with window.postMessage from the callback
 * page. Any window can post to this one, so a message is trusted only when
 * BOTH hold:
 *   - its origin is allowed (the app's own by default; Skatteverket also
 *     accepts its pinned OAuth host, see lib/skatteverket/popup-origin.ts),
 *   - event.source is the very window this component opened. A window
 *     reference cannot be forged, so another tab or frame on an allowed
 *     origin cannot fake a connect outcome.
 *
 * Pure so it is testable without a browser.
 */
export function isTrustedPopupMessage(
  event: Pick<MessageEvent, 'origin' | 'source'>,
  popup: Window | null,
  isAllowedOrigin: (origin: string) => boolean,
): boolean {
  return popup !== null && event.source === popup && isAllowedOrigin(event.origin)
}

function isOwnOrigin(origin: string): boolean {
  return origin === window.location.origin
}

/**
 * Listen for the OAuth window's postMessage. Put the window you open in the
 * returned ref (`popupRef.current = window.open(...)`) and leave it there
 * after the window closes: the callback posts and then closes itself, so its
 * message can arrive after the close is observed.
 */
export function useOAuthPopup<T = unknown>(
  onMessage: (data: T | null) => void,
  isAllowedOrigin: (origin: string) => boolean = isOwnOrigin,
): RefObject<Window | null> {
  const popupRef = useRef<Window | null>(null)
  const onMessageRef = useRef(onMessage)
  const isAllowedOriginRef = useRef(isAllowedOrigin)
  useEffect(() => {
    onMessageRef.current = onMessage
    isAllowedOriginRef.current = isAllowedOrigin
  })
  useEffect(() => {
    function listener(event: MessageEvent) {
      if (!isTrustedPopupMessage(event, popupRef.current, isAllowedOriginRef.current)) return
      onMessageRef.current(event.data as T | null)
    }
    window.addEventListener('message', listener)
    return () => window.removeEventListener('message', listener)
  }, [])
  return popupRef
}
