'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { resetAnalyticsIdentity } from '@/lib/analytics/reset'
import {
  SESSION_TIMEOUT_CHANNEL,
  SESSION_TIMEOUT_REASON_HEADER,
  type SessionTimeoutClientState,
  type SessionTimeoutReason,
} from '@/lib/auth/session-timeout-shared'
import { SessionTimeoutModal } from './SessionTimeoutModal'

const ACTIVITY_HEARTBEAT_INTERVAL_MS = 15_000
const SERVER_RESYNC_INTERVAL_MS = 60_000
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'scroll', 'touchstart'] as const

type Warning = { reason: SessionTimeoutReason; seconds: number }

function timeoutDeadline(
  state: SessionTimeoutClientState,
  lastActivityAt: number,
): { at: number; reason: SessionTimeoutReason } {
  const absoluteAt = state.absoluteTimeoutMs > 0
    ? state.startedAt + state.absoluteTimeoutMs
    : Number.POSITIVE_INFINITY
  const idleAt = state.idleTimeoutMs > 0
    ? lastActivityAt + state.idleTimeoutMs
    : Number.POSITIVE_INFINITY

  return absoluteAt <= idleAt
    ? { at: absoluteAt, reason: 'absolute' }
    : { at: idleAt, reason: 'idle' }
}

export function SessionTimeoutController() {
  const [warning, setWarning] = useState<Warning | null>(null)
  const [isExtending, setIsExtending] = useState(false)
  const stateRef = useRef<SessionTimeoutClientState | null>(null)
  const lastActivityAtRef = useRef(0)
  const lastHeartbeatAtRef = useRef(0)
  const heartbeatInFlightRef = useRef(false)
  const expiringRef = useRef(false)
  const warningOpenRef = useRef(false)
  const channelRef = useRef<BroadcastChannel | null>(null)

  const expire = useCallback(async (reason: SessionTimeoutReason) => {
    if (expiringRef.current) return
    expiringRef.current = true
    resetAnalyticsIdentity()

    try {
      await createClient().auth.signOut({ scope: 'local' })
    } catch {
      // Middleware remains authoritative and clears the server cookies.
    }

    const method = stateRef.current?.method ?? 'password'
    const url = new URL('/login', window.location.origin)
    url.searchParams.set('reason', reason)
    url.searchParams.set('method', method)
    const next = window.location.pathname + window.location.search
    if (next !== '/') url.searchParams.set('next', next)
    window.location.assign(url.toString())
  }, [])

  const applyServerState = useCallback((state: SessionTimeoutClientState) => {
    if (!state.enabled) {
      stateRef.current = null
      lastActivityAtRef.current = 0
      warningOpenRef.current = false
      setWarning(null)
      return
    }

    const clockOffset = Date.now() - state.serverNow
    stateRef.current = {
      ...state,
      startedAt: state.startedAt + clockOffset,
      lastActivityAt: state.lastActivityAt + clockOffset,
      serverNow: Date.now(),
    }
    lastActivityAtRef.current = state.lastActivityAt + clockOffset
  }, [])

  const handleExpiredResponse = useCallback((response: Response) => {
    const reason = response.headers.get(SESSION_TIMEOUT_REASON_HEADER) === 'idle'
      ? 'idle'
      : 'absolute'
    void expire(reason)
  }, [expire])

  const syncFromServer = useCallback(async () => {
    try {
      const response = await fetch('/api/auth/heartbeat', {
        method: 'GET',
        cache: 'no-store',
        credentials: 'same-origin',
      })
      if (response.status === 401) {
        handleExpiredResponse(response)
        return
      }
      if (!response.ok) return
      const payload = await response.json() as { data: SessionTimeoutClientState }
      applyServerState(payload.data)
    } catch {
      // A later resync or protected request will retry server enforcement.
    }
  }, [applyServerState, handleExpiredResponse])

  const sendHeartbeat = useCallback(async (showProgress = false) => {
    if (heartbeatInFlightRef.current || !stateRef.current) return false
    heartbeatInFlightRef.current = true
    if (showProgress) setIsExtending(true)

    try {
      const response = await fetch('/api/auth/heartbeat', {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
      })
      if (response.status === 401) {
        handleExpiredResponse(response)
        return false
      }
      if (!response.ok) return false
      const payload = await response.json() as { data: SessionTimeoutClientState }
      applyServerState(payload.data)
      lastHeartbeatAtRef.current = Date.now()
      warningOpenRef.current = false
      setWarning(null)
      channelRef.current?.postMessage({ type: 'heartbeat', state: payload.data })
      return true
    } catch {
      return false
    } finally {
      heartbeatInFlightRef.current = false
      if (showProgress) setIsExtending(false)
    }
  }, [applyServerState, handleExpiredResponse])

  const recordActivity = useCallback(() => {
    const state = stateRef.current
    if (!state || warningOpenRef.current || expiringRef.current) return

    const now = Date.now()
    lastActivityAtRef.current = now
    channelRef.current?.postMessage({ type: 'activity', at: now })

    if (now - lastHeartbeatAtRef.current >= ACTIVITY_HEARTBEAT_INTERVAL_MS) {
      void sendHeartbeat()
    }
  }, [sendHeartbeat])

  useEffect(() => {
    void syncFromServer()

    const channel = typeof BroadcastChannel === 'undefined'
      ? null
      : new BroadcastChannel(SESSION_TIMEOUT_CHANNEL)
    channelRef.current = channel
    if (channel) {
      channel.onmessage = (event: MessageEvent<{
        type: 'activity' | 'heartbeat' | 'expired'
        at?: number
        reason?: SessionTimeoutReason
        state?: SessionTimeoutClientState
      }>) => {
        // 'expired' comes from notifySessionExpired(): a data request hit the
        // middleware 401 before our own timers noticed, which is the normal
        // order of events in a backgrounded tab where they are throttled.
        if (event.data.type === 'expired') {
          void expire(event.data.reason === 'idle' ? 'idle' : 'absolute')
        } else if (event.data.type === 'heartbeat' && event.data.state) {
          applyServerState(event.data.state)
          lastHeartbeatAtRef.current = Date.now()
          warningOpenRef.current = false
          setWarning(null)
        } else if (
          event.data.type === 'activity' &&
          typeof event.data.at === 'number' &&
          !warningOpenRef.current
        ) {
          lastActivityAtRef.current = Math.max(
            lastActivityAtRef.current,
            event.data.at,
          )
        }
      }
    }

    for (const eventName of ACTIVITY_EVENTS) {
      window.addEventListener(eventName, recordActivity, { passive: true })
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void syncFromServer()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    const timer = window.setInterval(() => {
      const state = stateRef.current
      if (!state) return
      const deadline = timeoutDeadline(state, lastActivityAtRef.current)
      const remainingMs = deadline.at - Date.now()

      if (remainingMs <= 0) {
        void expire(deadline.reason)
        return
      }

      if (state.warningMs > 0 && remainingMs <= state.warningMs) {
        warningOpenRef.current = true
        setWarning({
          reason: deadline.reason,
          seconds: Math.max(1, Math.ceil(remainingMs / 1000)),
        })
      } else if (warningOpenRef.current) {
        warningOpenRef.current = false
        setWarning(null)
      }
    }, 1000)
    const resyncTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void syncFromServer()
    }, SERVER_RESYNC_INTERVAL_MS)

    return () => {
      window.clearInterval(timer)
      window.clearInterval(resyncTimer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      for (const eventName of ACTIVITY_EVENTS) {
        window.removeEventListener(eventName, recordActivity)
      }
      channel?.close()
      channelRef.current = null
    }
  }, [applyServerState, expire, recordActivity, syncFromServer])

  if (!warning) return null

  return (
    <SessionTimeoutModal
      reason={warning.reason}
      seconds={warning.seconds}
      isExtending={isExtending}
      onContinue={() => {
        if (warning.reason === 'absolute') {
          void expire('absolute')
        } else {
          lastActivityAtRef.current = Date.now()
          void sendHeartbeat(true)
        }
      }}
    />
  )
}
