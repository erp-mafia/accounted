import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { requireAuth } from '@/lib/auth/require-auth'
import {
  createSessionTimeoutState,
  evaluateSessionTimeout,
  fetchAutoLogoutPreference,
  getSessionTimeoutConfig,
  sessionStateMatchesUser,
  sessionStateNeedsRemint,
  sessionTimeoutCookieOptions,
  signSessionTimeoutState,
  toSessionTimeoutClientState,
  verifySessionTimeoutState,
} from '@/lib/auth/session-timeout'
import {
  SESSION_AUTH_METHOD_HINT_COOKIE,
  SESSION_TIMEOUT_COOKIE,
  isSessionAuthMethod,
  type SessionTimeoutReason,
} from '@/lib/auth/session-timeout-shared'

export const dynamic = 'force-dynamic'

async function getSessionId(supabase: SupabaseClient): Promise<string | null> {
  if (typeof supabase.auth.getClaims !== 'function') return null

  try {
    const { data } = await supabase.auth.getClaims()
    return typeof data?.claims?.session_id === 'string'
      ? data.claims.session_id
      : null
  } catch {
    return null
  }
}

function expiredResponse(reason: SessionTimeoutReason): NextResponse {
  const response = NextResponse.json(
    { error: { code: 'SESSION_EXPIRED', reason } },
    { status: 401 },
  )
  response.headers.set('X-Session-Timeout-Reason', reason)
  response.headers.set('Cache-Control', 'no-store')
  return response
}

async function heartbeat(updateActivity: boolean): Promise<NextResponse> {
  const auth = await requireAuth()
  if (auth.error) return auth.error

  const config = getSessionTimeoutConfig()
  const now = Date.now()

  if (!config.enabled) {
    return NextResponse.json({
      data: {
        enabled: false,
        idleTimeoutMs: 0,
        absoluteTimeoutMs: 0,
        warningMs: 0,
        serverNow: now,
        startedAt: now,
        lastActivityAt: now,
        method: 'password',
      },
    })
  }

  const cookieStore = await cookies()
  const encodedState = cookieStore.get(SESSION_TIMEOUT_COOKIE)?.value
  const state = await verifySessionTimeoutState(encodedState)
  const sessionId = await getSessionId(auth.supabase)

  const stateMatches =
    state !== null && sessionStateMatchesUser(state, auth.user.id, sessionId)

  if (!state || !stateMatches || sessionStateNeedsRemint(state)) {
    // Mirror middleware initialization: a missing, session-mismatched, or
    // pre-toggle cookie means the timeout state has not been established
    // for this session yet, not that the session expired.
    const hintedMethod = cookieStore.get(SESSION_AUTH_METHOD_HINT_COOKIE)?.value
    const autoLogout = await fetchAutoLogoutPreference(auth.supabase, auth.user.id)
    const freshState = state && stateMatches
      ? { ...state, autoLogout: autoLogout ?? false }
      : createSessionTimeoutState({
          userId: auth.user.id,
          sessionId,
          method: isSessionAuthMethod(hintedMethod) ? hintedMethod : 'password',
          autoLogout: autoLogout ?? false,
          now,
        })
    const response = NextResponse.json({
      data: toSessionTimeoutClientState(freshState, config, now),
    })
    response.headers.set('Cache-Control', 'no-store')
    // Unknown preference (failed read): answer this poll without persisting
    // a fail-open snapshot; the next resync retries the read (mirrors the
    // middleware).
    if (autoLogout !== null) {
      const signedFresh = await signSessionTimeoutState(freshState)
      if (signedFresh) {
        response.cookies.set(
          SESSION_TIMEOUT_COOKIE,
          signedFresh,
          sessionTimeoutCookieOptions(),
        )
      }
    }
    return response
  }

  const reason = evaluateSessionTimeout(state, config, now)
  if (reason) return expiredResponse(reason)

  const nextState = updateActivity
    ? { ...state, lastActivityAt: now }
    : state
  const response = NextResponse.json({
    data: toSessionTimeoutClientState(nextState, config, now),
  })
  response.headers.set('Cache-Control', 'no-store')

  if (updateActivity) {
    const signedNext = await signSessionTimeoutState(nextState)
    if (signedNext) {
      response.cookies.set(
        SESSION_TIMEOUT_COOKIE,
        signedNext,
        sessionTimeoutCookieOptions(),
      )
    }
  }

  return response
}

export async function GET(): Promise<NextResponse> {
  return heartbeat(false)
}

export async function POST(): Promise<NextResponse> {
  return heartbeat(true)
}
