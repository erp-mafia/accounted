/**
 * Permission shadow mode: decide() (./decide.ts) runs next to today's
 * permission checks at every door and changes nothing. Where its answer
 * disagrees with what today's code actually did, one row goes to
 * permission_shadow_log; that log, read over a week, is what enforcement
 * waits for.
 *
 * Guarantees, for every door that calls in:
 *   - the response is never touched: a door hands over what it did (allow,
 *     stage, or deny with a code) and goes on;
 *   - nothing throws into a request: every step is wrapped and a failure
 *     only logs a warning;
 *   - no database read at all, and no write on the way to the response:
 *     the comparison is in memory over what the door already knows, and a
 *     disagreement's row is written after the response (next/server after(),
 *     the same pattern as the webhook dispatch kick);
 *   - one row per door, principal, company, reason and today's outcome per
 *     window (DEDUPE_WINDOW_MS, in process), so a systematic mismatch cannot
 *     write a row per request;
 *   - PERMISSIONS_SHADOW=off switches all of it off.
 *
 * Not compared: a cookie-session read (the session door catalog classifies
 * writes only), a refusal that is not about permissions (package off, the
 * paywall, a test key), approvals, which are decided per staged operation
 * at the commit seam, a request whose door did not read the role, and
 * a missing scope (scope checks stay at the wire; decide() runs behind them).
 *
 * Each row says whether the difference is expected, with why:
 *   AGENT_NEVER_HOLDS   decide() refuses an agent members, settings and
 *                       agents.autonomy by design (./catalog.ts);
 *   HANDLER_CHECK       the gate let the request through and the handler
 *                       refused it (a check finer than a permission, such as
 *                       a colleague's key or the owner-only reset), which
 *                       stays beside decide();
 *   a preset exception  a documented difference between a role's preset and
 *                       today's route gate (./preset-exceptions.ts).
 * Everything else is unexplained (expected = false) and counts.
 */
import { after } from 'next/server'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { createLogger } from '@/lib/logger'
import { PERMISSION_CATALOG, PERMISSIONS, type Permission } from './catalog'
import { decide, type Decision, type MandateLevel, type Principal } from './decide'
import { isOutsideDoor, sessionRequestDoor, type DoorClass, type DoorRule } from './doors'
import { deriveMandate, type AgentKeyKind } from './mandate'
import { presetExceptionFor } from './preset-exceptions'
import { effectivePersonPermissions } from './presets'
import { insertShadowRow, type ShadowRow } from './shadow-writer'

const log = createLogger('permissions/shadow')

/** One row per door, principal, company, reason and outcome within this window. */
export const DEDUPE_WINDOW_MS = 5 * 60_000
/** Bound on the dedupe memory: past it, expired entries go, then everything. */
const DEDUPE_MAX_ENTRIES = 5_000

/**
 * What today's code did at the door:
 *   allow  the door ran as built (committed, read, or ran a tool that failed for another reason)
 *   stage  the door staged the write for a person to approve
 *   deny   refused, with the code of the check that refused
 */
export interface TodayOutcome {
  outcome: 'allow' | 'stage' | 'deny'
  /** The refusal code, for a deny. */
  code?: string
  /** Who refused: the door's own gate, or the handler after the gate let the request through. */
  by?: 'gate' | 'handler'
  /** A dry run or test key: nothing was written either way. */
  dryRun?: boolean
}

/** The key facts an agent principal is derived from (./mandate.ts). */
export interface ShadowAgentKey {
  kind: AgentKeyKind
  scopes: readonly string[]
  apiKeyId: string | null
  agentIdentityId: string | null
}

export type ShadowPrincipal =
  | { kind: 'person'; userId: string }
  /** The in-app assistant acting for the signed-in person: it stages every write today and never approves. */
  | { kind: 'assistant'; userId: string }
  | { kind: 'agent'; userId: string; key: ShadowAgentKey; companyAccess?: 'read' | 'write' }

export interface ShadowObservation {
  /** Stable door key: 'session:<operation>', 'v1:<operation>', 'mcp:<tool>', 'ext:<extension><path>', 'assistant:<tool>'. */
  door: string
  method?: string | null
  /** The door's class, or a thunk for it; null, undefined or an outside door: no permission governs it, nothing to compare. */
  doorRule: DoorRule | null | undefined | (() => DoorRule | null | undefined)
  companyId: string | null | undefined
  principal: ShadowPrincipal
  /**
   * The principal's role in the company (the sponsor's, for an agent), as
   * the door read it. Without one the check is skipped: the shadow never
   * reads it itself.
   */
  role?: string | null
  today: TodayOutcome
  action?: 'call' | 'approve'
  /** A person's concrete request, to find a documented preset exception. */
  request?: { method: string; pathname: string }
}

const NOOP = (): void => {}

export function shadowEnabled(): boolean {
  return (process.env.PERMISSIONS_SHADOW ?? '').trim().toLowerCase() !== 'off'
}

// ── Principals ─────────────────────────────────────────────────────────

const ASSISTANT_LEVELS: Partial<Record<Permission, MandateLevel>> = Object.freeze(
  Object.fromEntries(PERMISSIONS.filter((p) => PERMISSION_CATALOG[p].agentMayHold).map((p) => [p, 'propose'])),
)

function principalFor(p: ShadowPrincipal, role: string): Principal {
  const permissions = effectivePersonPermissions(role)
  if (p.kind === 'person') return { kind: 'person', permissions }
  if (p.kind === 'assistant') {
    return { kind: 'agent', sponsorPermissions: permissions, levels: ASSISTANT_LEVELS, highRiskToo: {} }
  }
  const mandate = deriveMandate({ kind: p.key.kind, scopes: p.key.scopes, companyAccess: p.companyAccess })
  return { kind: 'agent', sponsorPermissions: permissions, levels: mandate.levels, highRiskToo: mandate.highRiskToo }
}

// ── Comparison and classification ──────────────────────────────────────

/**
 * Does decide() say what today's code did? `allow` means the door does what
 * it does, so it agrees with a commit, a read and a door that always stages;
 * `stage` agrees only with a staging, or with a dry run that wrote nothing.
 */
export function agrees(today: TodayOutcome, decision: Decision): boolean {
  if (decision.outcome === 'deny') return today.outcome === 'deny'
  if (today.outcome === 'deny') return false
  if (decision.outcome === 'allow') return true
  if (decision.outcome === 'stage') return today.outcome === 'stage' || today.dryRun === true
  return false
}

function expectedBecause(obs: ShadowObservation, decision: Decision, role: string): string | null {
  if (decision.reason === 'AGENT_NEVER_HOLDS') return 'AGENT_NEVER_HOLDS'
  if (obs.today.outcome === 'deny' && obs.today.by === 'handler' && decision.outcome !== 'deny') return 'HANDLER_CHECK'
  if (obs.principal.kind === 'person' && obs.request) {
    return presetExceptionFor(obs.request.method, obs.request.pathname, role)
  }
  return null
}

function toRow(obs: ShadowObservation, companyId: string, decision: Decision, role: string): ShadowRow {
  const because = expectedBecause(obs, decision, role)
  const p = obs.principal
  return {
    company_id: companyId,
    user_id: p.userId,
    agent_identity_id: p.kind === 'agent' ? p.key.agentIdentityId : null,
    api_key_id: p.kind === 'agent' ? p.key.apiKeyId : null,
    principal_kind: p.kind,
    door: obs.door.slice(0, 200),
    method: obs.method ? obs.method.toUpperCase().slice(0, 10) : null,
    today_outcome: obs.today.outcome,
    today_code: (obs.today.code ?? (obs.today.dryRun ? 'DRY_RUN' : null))?.slice(0, 64) ?? null,
    decide_outcome: decision.outcome,
    decide_reason: decision.reason,
    permission: decision.permission,
    expected: because !== null,
    expected_reason: because,
  }
}

// ── Dedupe ─────────────────────────────────────────────────────────────

const recent = new Map<string, number>()

function principalId(p: ShadowPrincipal): string {
  return p.kind === 'agent' ? `agent:${p.key.apiKeyId ?? p.key.agentIdentityId ?? p.userId}` : `${p.kind}:${p.userId}`
}

function dedupeKey(obs: ShadowObservation, companyId: string, reason: string): string {
  return [obs.door, obs.method ?? '', companyId, principalId(obs.principal), reason, obs.today.outcome].join('|')
}

/** True the first time a key is seen within the window. */
function claim(key: string): boolean {
  const now = Date.now()
  const until = recent.get(key)
  if (until !== undefined && until > now) return false
  if (recent.size >= DEDUPE_MAX_ENTRIES) {
    for (const [k, expiry] of recent) if (expiry <= now) recent.delete(k)
    if (recent.size >= DEDUPE_MAX_ENTRIES) recent.clear()
  }
  recent.set(key, now + DEDUPE_WINDOW_MS)
  return true
}

/** Test-only: forget the dedupe window. */
export function resetPermissionShadowForTests(): void {
  recent.clear()
}

// ── After the response ─────────────────────────────────────────────────

function warn(message: string, err: unknown): void {
  try {
    log.warn(message, { error: err instanceof Error ? err.message : String(err) })
  } catch {
    // Logging must not throw either.
  }
}

function runAfterResponse(task: () => Promise<void>): void {
  const guarded = async (): Promise<void> => {
    try {
      await task()
    } catch (err) {
      warn('permission shadow write failed', err)
    }
  }
  try {
    // Keeps the serverless instance alive past the response until the write settles.
    after(guarded)
  } catch {
    // Outside a request scope (tests, scripts): a floating promise instead.
    queueMicrotask(() => void guarded())
  }
}

// ── The check ──────────────────────────────────────────────────────────

function resolveDoor(rule: ShadowObservation['doorRule']): DoorClass | null {
  const found = typeof rule === 'function' ? rule() : rule
  if (!found || isOutsideDoor(found)) return null
  return found
}

/** The row to write when decide() disagrees and the window has not seen it yet, else null. */
function disagreement(obs: ShadowObservation, companyId: string, door: DoorClass, role: string): ShadowRow | null {
  const decision = decide({ principal: principalFor(obs.principal, role), door, action: obs.action ?? 'call' })
  if (agrees(obs.today, decision)) return null
  if (!claim(dedupeKey(obs, companyId, decision.reason))) return null
  return toRow(obs, companyId, decision, role)
}

/**
 * Compare decide() with what today's code did, and log a disagreement after
 * the response. Never throws, never awaits, never changes anything the door
 * returns.
 */
export function shadowPermission(obs: ShadowObservation): void {
  try {
    if (!shadowEnabled()) return
    const companyId = obs.companyId
    if (!companyId) return
    const door = resolveDoor(obs.doorRule)
    if (!door) return

    // No role read by the door (or no membership): nothing to compare.
    if (typeof obs.role !== 'string' || obs.role.length === 0) return
    const row = disagreement(obs, companyId, door, obs.role)
    if (row) runAfterResponse(() => insertShadowRow(row))
  } catch (err) {
    warn('permission shadow check failed', err)
  }
}

// ── Door helpers ───────────────────────────────────────────────────────

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * The recorder for one cookie-session request (withRouteContext, the
 * extension dispatcher): call it once with what the request's checks did.
 * The door is the session door catalog's (sessionRequestDoor), which
 * classifies writes; a read method, an unknown role or the switch off
 * answers a no-op.
 */
export function sessionShadow(input: {
  door: string
  method: string
  pathname: string
  companyId: string
  userId: string
  role: string | undefined
}): (today: TodayOutcome) => void {
  try {
    const method = input.method.toUpperCase()
    if (!shadowEnabled() || SAFE_METHODS.has(method) || !input.role) return NOOP
    let recorded = false
    return (today) => {
      if (recorded) return
      recorded = true
      shadowPermission({
        door: input.door,
        method,
        doorRule: () => sessionRequestDoor(method, input.pathname),
        companyId: input.companyId,
        principal: { kind: 'person', userId: input.userId },
        role: input.role,
        today,
        request: { method, pathname: input.pathname },
      })
    }
  } catch (err) {
    warn('permission shadow check failed', err)
    return NOOP
  }
}

/** Where an agent's call landed: the company, the sponsor's role there when the door read it, the key's access to it. */
export interface AgentShadowTarget {
  companyId: string | null | undefined
  role?: string | null
  companyAccess?: 'read' | 'write'
}

/**
 * The recorder for one API-key request (REST v1, MCP): call it with what the
 * request's checks did, once per company the call acts in. The switch off
 * answers a no-op.
 */
export function agentShadow(base: {
  door: string
  method: string | null
  userId: string
  key: ShadowAgentKey
  doorRule: ShadowObservation['doorRule']
}): (today: TodayOutcome, target: AgentShadowTarget) => void {
  try {
    if (!shadowEnabled()) return NOOP
    return (today, target) =>
      shadowPermission({
        door: base.door,
        method: base.method,
        doorRule: base.doorRule,
        companyId: target.companyId,
        principal: { kind: 'agent', userId: base.userId, key: base.key, companyAccess: target.companyAccess },
        role: target.role,
        today,
      })
  } catch (err) {
    warn('permission shadow check failed', err)
    return NOOP
  }
}

/**
 * The recorder for one tool call of the in-app assistant, acting for the
 * signed-in person: `settled` when the tool returned (a staged operation or
 * not), `failed` when it threw. An unknown role or the switch off answers a
 * no-op.
 */
export function assistantShadow(input: {
  toolName: string
  companyId: string
  userId: string
  role: string | undefined
  doorRule: () => DoorRule | null | undefined
}): { settled(staged: boolean, dryRun: boolean): void; failed(err: unknown): void } {
  const noop = { settled: NOOP, failed: NOOP }
  try {
    if (!shadowEnabled() || !input.role) return noop
    let door: DoorRule | null | undefined
    let resolved = false
    const resolveOnce = (): DoorRule | null | undefined => {
      if (!resolved) {
        resolved = true
        door = input.doorRule()
      }
      return door
    }
    const record = (today: TodayOutcome) =>
      shadowPermission({
        door: `assistant:${input.toolName}`,
        method: null,
        doorRule: resolveOnce,
        companyId: input.companyId,
        principal: { kind: 'assistant', userId: input.userId },
        role: input.role,
        today,
      })
    return {
      settled: (staged, dryRun) => record({ outcome: staged ? 'stage' : 'allow', dryRun }),
      failed: (err) => {
        try {
          const found = resolveOnce()
          const staging = !!found && !isOutsideDoor(found) && found.stageable
          record(todayFromToolFailure(err, staging))
        } catch (failure) {
          warn('permission shadow check failed', failure)
        }
      },
    }
  } catch (err) {
    warn('permission shadow check failed', err)
    return noop
  }
}

/** A thrown error's code, when it carries one. */
export function errorCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string') return code
  const nested = (err as { error?: { code?: unknown } } | null)?.error?.code
  return typeof nested === 'string' ? nested : null
}

/**
 * What a tool's failure says about today's permission outcome: a refusal
 * (a code answered 403, such as FORBIDDEN from requireCompanyAdmin) is a
 * deny by the handler; any other failure means the checks let the call
 * through, as a staging (`staging`) or as a direct call.
 */
export function todayFromToolFailure(err: unknown, staging: boolean): TodayOutcome {
  const code = errorCode(err)
  if (code && getErrorEntry(code)?.httpStatus === 403) return { outcome: 'deny', code, by: 'handler' }
  return { outcome: staging ? 'stage' : 'allow' }
}
