import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  VIEW_APPROVAL_META_KEY,
  VIEW_TOKEN_TTL_SECONDS,
  approvalViewFor,
  approvalViewMeta,
  checkViewApprovalToken,
  mintViewApprovalToken,
} from '../view-approval'

const KEY = '11111111-1111-4111-8111-111111111111'
const OTHER_KEY = '22222222-2222-4222-8222-222222222222'
const OP = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a'
const OTHER_OP = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b'
const NOW = new Date('2026-11-06T10:00:00.000Z')

beforeEach(() => {
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-secret')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('view approval tokens', () => {
  it('passes for the key and the operation it was minted for', () => {
    const token = mintViewApprovalToken({ apiKeyId: KEY, operationId: OP, now: NOW })
    expect(token).toMatch(/^va1\.\d+\.[A-Za-z0-9_-]{43}$/)
    expect(checkViewApprovalToken(token, { apiKeyId: KEY, operationId: OP, now: NOW })).toEqual({ ok: true })
    // The operation id is matched without regard to case, as ids are.
    expect(checkViewApprovalToken(token, { apiKeyId: KEY, operationId: OP.toUpperCase(), now: NOW })).toEqual({ ok: true })
  })

  it('never passes for another operation or another key', () => {
    const token = mintViewApprovalToken({ apiKeyId: KEY, operationId: OP, now: NOW })
    expect(checkViewApprovalToken(token, { apiKeyId: KEY, operationId: OTHER_OP, now: NOW })).toEqual({ ok: false, reason: 'mismatch' })
    expect(checkViewApprovalToken(token, { apiKeyId: OTHER_KEY, operationId: OP, now: NOW })).toEqual({ ok: false, reason: 'mismatch' })
  })

  it('expires, and a moved expiry breaks the signature', () => {
    const token = mintViewApprovalToken({ apiKeyId: KEY, operationId: OP, now: NOW })
    const later = new Date(NOW.getTime() + (VIEW_TOKEN_TTL_SECONDS + 1) * 1000)
    expect(checkViewApprovalToken(token, { apiKeyId: KEY, operationId: OP, now: later })).toEqual({ ok: false, reason: 'expired' })
    const [prefix, expiresAt, signature] = token.split('.')
    const stretched = `${prefix}.${Number(expiresAt) + 3600}.${signature}`
    expect(checkViewApprovalToken(stretched, { apiKeyId: KEY, operationId: OP, now: NOW })).toEqual({ ok: false, reason: 'mismatch' })
  })

  it('never passes under another secret', () => {
    const token = mintViewApprovalToken({ apiKeyId: KEY, operationId: OP, now: NOW })
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'another-secret')
    expect(checkViewApprovalToken(token, { apiKeyId: KEY, operationId: OP, now: NOW })).toEqual({ ok: false, reason: 'mismatch' })
  })

  it('refuses a missing or malformed token', () => {
    for (const token of [undefined, null, '', 42]) {
      expect(checkViewApprovalToken(token, { apiKeyId: KEY, operationId: OP, now: NOW })).toEqual({ ok: false, reason: 'missing' })
    }
    for (const token of ['va1', 'va1.x.y', 'va2.1.abc', `va1.123.${'a'.repeat(42)}`]) {
      expect(checkViewApprovalToken(token, { apiKeyId: KEY, operationId: OP, now: NOW })).toEqual({ ok: false, reason: 'malformed' })
    }
  })
})

describe('which connections have the approval view', () => {
  const apps = { 'io.modelcontextprotocol/clientCapabilities': { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } } }
  const noApps = { 'io.modelcontextprotocol/clientCapabilities': { extensions: { 'io.modelcontextprotocol/tasks': {} } } }

  it('only one minted by the OAuth sign-in for Claude', () => {
    expect(approvalViewFor({ oauthProvider: 'claude', requestMeta: undefined })).toBe(true)
    for (const provider of ['chatgpt', 'grok', 'cursor', 'gemini', 'local', 'registered:abc', '', null, undefined]) {
      expect(approvalViewFor({ oauthProvider: provider, requestMeta: undefined })).toBe(false)
      expect(approvalViewFor({ oauthProvider: provider, requestMeta: apps })).toBe(false)
    }
  })

  it('never for a client that says on the request that it renders no MCP Apps, even on a Claude connection', () => {
    expect(approvalViewFor({ oauthProvider: 'claude', requestMeta: apps })).toBe(true)
    expect(approvalViewFor({ oauthProvider: 'claude', requestMeta: {} })).toBe(true)
    expect(approvalViewFor({ oauthProvider: 'claude', requestMeta: noApps })).toBe(false)
    expect(approvalViewFor({ oauthProvider: 'claude', requestMeta: { 'io.modelcontextprotocol/clientCapabilities': {} } })).toBe(false)
  })
})

describe('approvalViewMeta', () => {
  const operations = [
    { id: OP, status: 'pending' },
    { id: OTHER_OP, status: 'committed' },
    { id: 7, status: 'pending' },
  ]

  it('hands the view one token per pending operation, under its own key', () => {
    const meta = approvalViewMeta({ approvalView: true, apiKeyId: KEY, canApprove: true, operations, now: NOW })
    const tokens = (meta?.[VIEW_APPROVAL_META_KEY] as { tokens: Record<string, string> }).tokens
    expect(Object.keys(tokens)).toEqual([OP])
    expect(checkViewApprovalToken(tokens[OP], { apiKeyId: KEY, operationId: OP, now: NOW })).toEqual({ ok: true })
  })

  it('hands out nothing without the view, without approve, without a key or with nothing pending', () => {
    expect(approvalViewMeta({ approvalView: false, apiKeyId: KEY, canApprove: true, operations })).toBeNull()
    expect(approvalViewMeta({ approvalView: true, apiKeyId: KEY, canApprove: false, operations })).toBeNull()
    expect(approvalViewMeta({ approvalView: true, apiKeyId: null, canApprove: true, operations })).toBeNull()
    expect(approvalViewMeta({ approvalView: true, apiKeyId: KEY, canApprove: true, operations: [{ id: OP, status: 'rejected' }] })).toBeNull()
  })
})
