import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const capture = vi.fn((..._a: unknown[]) => undefined)
const flush = vi.fn(async (..._a: unknown[]) => undefined)

// The real gate (lib/analytics/enabled.ts) decides whether a client exists;
// only the network client itself is replaced.
vi.mock('posthog-node', () => ({
  PostHog: class {
    capture = capture
    flush = flush
  },
}))

vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: vi.fn() }))

import {
  MCP_TOOL_CALL_EVENT,
  TOOL_CALL_EVENT_PROPERTIES,
  buildToolCallProperties,
  clientNameForPostHog,
  errorTypeForPostHog,
  mayMirrorToolCall,
  ANONYMOUS_AGENT_DISTINCT_ID,
  type ToolCallMirrorMode,
  mirrorToolCallToPostHog,
  type ToolCallMirrorInput,
} from '../posthog-tool-call'
import type { SupabaseClient } from '@supabase/supabase-js'

const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e'
const COMPANY = '11111111-1111-4111-8111-111111111111'

const ok: ToolCallMirrorInput = {
  tool: 'gnubok_get_trial_balance',
  isError: false,
  errorCode: null,
  errorKind: null,
  latencyMs: 41.6,
  client: 'claude-code',
  sessionId: SESSION,
  serverVersion: 'abc123def456',
}

const failed: ToolCallMirrorInput = {
  ...ok,
  isError: true,
  errorCode: 'VALIDATION_ERROR',
  errorKind: 'execution',
}

/** Every input shape the dispatcher can hand over, hostile ones included. */
const SHAPES: ToolCallMirrorInput[] = [
  ok,
  failed,
  { ...failed, errorKind: 'unknown_tool', errorCode: 'UNKNOWN_TOOL', tool: 'Book 12 500 kr for Anna Andersson' },
  { ...failed, errorKind: 'scope_denied', errorCode: 'Kunden 556677-8899 saknas' },
  { ...ok, client: 'Annas egna bot', sessionId: 'anna-andersson-session' },
  { ...failed, errorKind: 'constructor', errorCode: null, latencyMs: Number.NaN },
  // Fields the dispatcher's payload carries that must never be picked up.
  {
    ...failed,
    errorMessage: 'Fakturan till Anna Andersson på 12 500 kr saknas',
    errorDetail: 'row 5566778899',
    arguments: { amount: 12500 },
    result: { name: 'Anna' },
    actorLabel: 'Annas nyckel',
  } as ToolCallMirrorInput,
]

describe('buildToolCallProperties', () => {
  it('carries only properties on the fixed list, for every input shape', () => {
    const allowed = new Set<string>(TOOL_CALL_EVENT_PROPERTIES)
    for (const shape of SHAPES) {
      const outside = Object.keys(buildToolCallProperties(shape)).filter((key) => !allowed.has(key))
      expect(outside).toEqual([])
    }
  })

  it('keeps the fixed list itself fixed', () => {
    expect([...TOOL_CALL_EVENT_PROPERTIES]).toEqual([
      '$mcp_tool_name',
      '$mcp_is_error',
      '$mcp_error_type',
      'mcp_error_code',
      'mcp_error_kind',
      '$mcp_duration_ms',
      '$mcp_client_name',
      '$session_id',
      '$mcp_session_id',
      '$mcp_server_name',
      '$mcp_server_version',
      '$mcp_source',
      '$process_person_profile',
    ])
  })

  it('sends no free text: every value is a boolean, a number, or a short token', () => {
    for (const shape of SHAPES) {
      for (const value of Object.values(buildToolCallProperties(shape))) {
        if (typeof value === 'string') expect(value).toMatch(/^[A-Za-z0-9_.-]{1,80}$/)
        else expect(['boolean', 'number']).toContain(typeof value)
      }
    }
  })

  it('is the whole event for a successful call', () => {
    expect(buildToolCallProperties(ok)).toEqual({
      $mcp_tool_name: 'gnubok_get_trial_balance',
      $mcp_is_error: false,
      $mcp_duration_ms: 42,
      $mcp_client_name: 'claude-code',
      $session_id: SESSION,
      $mcp_session_id: SESSION,
      $mcp_server_name: 'accounted',
      $mcp_server_version: 'abc123def456',
      $mcp_source: 'posthog_mcp_analytics',
    })
  })

  it('reduces a failure to a code, a kind and a bucket', () => {
    expect(buildToolCallProperties(failed)).toMatchObject({
      $mcp_is_error: true,
      $mcp_error_type: 'validation',
      mcp_error_code: 'VALIDATION_ERROR',
      mcp_error_kind: 'execution',
    })
  })

  it('never sends a tool name the server did not recognise', () => {
    const invented = buildToolCallProperties({ ...failed, errorKind: 'unknown_tool', tool: 'gnubok_pay_anna' })
    expect(invented.$mcp_tool_name).toBe('unknown')
    expect(buildToolCallProperties({ ...ok, tool: 'Not A Tool' }).$mcp_tool_name).toBe('unknown')
  })

  it('drops an error code that is not a code, and a session id that is not a UUID', () => {
    const props = buildToolCallProperties({ ...failed, errorCode: 'Kunden saknas', sessionId: 'my-session' })
    expect(props.mcp_error_code).toBe('unknown')
    expect(props).not.toHaveProperty('$session_id')
    expect(props).not.toHaveProperty('$mcp_session_id')
  })
})

describe('clientNameForPostHog', () => {
  it('keeps a known harness, folds a suffixed marker into its family, and labels the rest other', () => {
    expect(clientNameForPostHog('claude-connector')).toBe('claude-connector')
    expect(clientNameForPostHog('Claude-Code-plugin')).toBe('claude-code')
    expect(clientNameForPostHog('annas-bot')).toBe('other')
    expect(clientNameForPostHog(null)).toBe('other')
  })
})

describe('errorTypeForPostHog', () => {
  it('maps the dispatcher refusals by kind and everything unmapped to internal', () => {
    expect(errorTypeForPostHog('scope_denied', 'ANYTHING')).toBe('permission')
    expect(errorTypeForPostHog('invalid_arguments', null)).toBe('validation')
    expect(errorTypeForPostHog('execution', 'UNKNOWN_ERROR')).toBe('internal')
    expect(errorTypeForPostHog('execution', null)).toBe('internal')
  })
})

function supabaseAnswering(
  prefs: { data: unknown; error: unknown },
  settings: { data: unknown; error: unknown },
): SupabaseClient {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => (table === 'user_preferences' ? prefs : settings) }),
      }),
    }),
  } as unknown as SupabaseClient
}

describe('mayMirrorToolCall', () => {
  const none = { data: null, error: null }

  it('is on for a person never asked and a company that is not a sandbox', async () => {
    expect(await mayMirrorToolCall(supabaseAnswering(none, none), 'user-1', COMPANY)).toBe('person')
    const asked = { data: { analytics_consent: true }, error: null }
    const real = { data: { is_sandbox: false }, error: null }
    expect(await mayMirrorToolCall(supabaseAnswering(asked, real), 'user-1', COMPANY)).toBe('person')
  })

  it('counts a person who switched analytics off without naming them', async () => {
    const off = { data: { analytics_consent: false }, error: null }
    expect(await mayMirrorToolCall(supabaseAnswering(off, none), 'user-1', COMPANY)).toBe('anonymous')
  })

  it('is off for a sandbox company, and when either read fails', async () => {
    const sandbox = { data: { is_sandbox: true }, error: null }
    const broken = { data: null, error: { message: 'down' } }
    const off = { data: { analytics_consent: false }, error: null }
    expect(await mayMirrorToolCall(supabaseAnswering(none, sandbox), 'user-1', COMPANY)).toBe('none')
    expect(await mayMirrorToolCall(supabaseAnswering(off, sandbox), 'user-1', COMPANY)).toBe('none')
    expect(await mayMirrorToolCall(supabaseAnswering(broken, none), 'user-1', COMPANY)).toBe('none')
    expect(await mayMirrorToolCall(supabaseAnswering(none, broken), 'user-1', COMPANY)).toBe('none')
  })
})

describe('mirrorToolCallToPostHog', () => {
  const call = { ...ok, userId: 'user-1', companyId: COMPANY }
  const mayMirror = vi.fn(async (..._a: unknown[]): Promise<ToolCallMirrorMode> => 'person')

  beforeEach(() => {
    capture.mockReset()
    flush.mockReset()
    mayMirror.mockReset()
    mayMirror.mockResolvedValue('person')
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', '')
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN', 'phc_test')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('sends one event as the person, grouped on the company, then flushes', async () => {
    await mirrorToolCallToPostHog(call, { mayMirror })
    expect(capture).toHaveBeenCalledTimes(1)
    expect(capture.mock.calls[0][0]).toEqual({
      distinctId: 'user-1',
      event: MCP_TOOL_CALL_EVENT,
      properties: buildToolCallProperties(ok),
      groups: { company: COMPANY },
    })
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('sends nothing on a self-hosted install, and does not even read the choice', async () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    await mirrorToolCallToPostHog(call, { mayMirror })
    expect(capture).not.toHaveBeenCalled()
    expect(mayMirror).not.toHaveBeenCalled()
  })

  it('sends nothing without a project token', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN', '')
    await mirrorToolCallToPostHog(call, { mayMirror })
    expect(capture).not.toHaveBeenCalled()
    expect(mayMirror).not.toHaveBeenCalled()
  })

  it('sends nothing when the rule says none', async () => {
    mayMirror.mockResolvedValue('none')
    await mirrorToolCallToPostHog(call, { mayMirror })
    expect(capture).not.toHaveBeenCalled()
  })

  it('counts an opted-out person without a user id, a company, a session or a profile', async () => {
    mayMirror.mockResolvedValue('anonymous')
    const session = '3f2b8a1e-5c4d-4e6f-8a9b-0c1d2e3f4a5b'
    await mirrorToolCallToPostHog({ ...call, sessionId: session }, { mayMirror })
    expect(capture).toHaveBeenCalledTimes(1)
    const sent = capture.mock.calls[0][0] as { properties: Record<string, unknown> }
    expect(sent).toEqual({
      distinctId: ANONYMOUS_AGENT_DISTINCT_ID,
      event: MCP_TOOL_CALL_EVENT,
      properties: { ...buildToolCallProperties({ ...ok, sessionId: null }), $process_person_profile: false },
    })
    const wire = JSON.stringify(sent)
    for (const secret of ['user-1', COMPANY, session]) expect(wire).not.toContain(secret)
    for (const key of Object.keys(sent.properties)) expect(TOOL_CALL_EVENT_PROPERTIES).toContain(key)
  })

  it('sends nothing without a person or a company', async () => {
    await mirrorToolCallToPostHog({ ...call, userId: '' }, { mayMirror })
    await mirrorToolCallToPostHog({ ...call, companyId: '' }, { mayMirror })
    expect(capture).not.toHaveBeenCalled()
  })

  it('resolves when the capture, the flush or the rule read throws', async () => {
    capture.mockImplementation(() => {
      throw new Error('posthog down')
    })
    await expect(mirrorToolCallToPostHog(call, { mayMirror })).resolves.toBeUndefined()
    capture.mockReset()
    flush.mockRejectedValue(new Error('network'))
    await expect(mirrorToolCallToPostHog(call, { mayMirror })).resolves.toBeUndefined()
    mayMirror.mockRejectedValue(new Error('db down'))
    await expect(mirrorToolCallToPostHog(call, { mayMirror })).resolves.toBeUndefined()
  })
})
