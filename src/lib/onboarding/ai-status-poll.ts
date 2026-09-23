import { AI_CLIENTS, type AiClient } from '@/lib/onboarding/ai-clients'

/** How often the Done step asks whether an AI client has signed in, inside a polling window. */
export const AI_POLL_MS = 4000
/** How long one connection attempt keeps polling before it waits for the next click or focus. */
export const AI_POLL_WINDOW_MS = 120_000

export interface AiStatusPoller {
  /** The user started connecting `client`: poll until it shows up or the window runs out. */
  attempt(client: AiClient): void
  /** One read now (the user came back). Reopens the window while an attempt is still unanswered. */
  check(): void
  /** Unmount: no more reads, and an outstanding one is aborted and ignored. */
  stop(): void
}

/**
 * The Done step's AI connection poll. The OAuth sign-in happens in another
 * tab or app, so the chip can only turn green by asking. Polling is tied to a
 * connection attempt rather than to the step being on screen: a window opens
 * on the Anslut click, the next read is scheduled only after the previous one
 * settled (a slow response can never overlap the next), and the window ends
 * when the client connects, the time runs out, a read fails, or the tab is
 * hidden. Coming back to the tab asks once and reopens the window if the
 * attempt is still unanswered: the token route may mint the key seconds
 * after the user returns.
 *
 * `fetchStatus` answers null when the status is unavailable. That never
 * reaches `onStatus`, so a failed read cannot make a connected client look
 * disconnected.
 */
export function createAiStatusPoller(opts: {
  fetchStatus: (signal: AbortSignal) => Promise<AiClient[] | null>
  onStatus: (connected: AiClient[]) => void
  isHidden?: () => boolean
  intervalMs?: number
  windowMs?: number
}): AiStatusPoller {
  const intervalMs = opts.intervalMs ?? AI_POLL_MS
  const windowMs = opts.windowMs ?? AI_POLL_WINDOW_MS
  let target: AiClient | null = null
  let deadline = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight: AbortController | null = null
  let stopped = false

  function clearTimer() {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  async function read() {
    clearTimer()
    if (stopped || inFlight) return
    if (opts.isHidden?.()) return
    const controller = new AbortController()
    inFlight = controller
    let connected: AiClient[] | null = null
    try {
      connected = await opts.fetchStatus(controller.signal)
    } catch {
      connected = null
    }
    inFlight = null
    if (stopped || controller.signal.aborted) return
    if (!connected) return
    opts.onStatus(connected)
    if (target && connected.includes(target)) target = null
    if (!target || connected.length >= AI_CLIENTS.length) return
    if (Date.now() + intervalMs <= deadline) timer = setTimeout(() => void read(), intervalMs)
  }

  return {
    attempt(client) {
      if (stopped) return
      target = client
      deadline = Date.now() + windowMs
      void read()
    },
    check() {
      if (stopped) return
      if (target) deadline = Date.now() + windowMs
      void read()
    },
    stop() {
      stopped = true
      clearTimer()
      inFlight?.abort()
      inFlight = null
    },
  }
}
