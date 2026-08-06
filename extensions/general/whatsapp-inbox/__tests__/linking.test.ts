import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import crypto from 'crypto'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  CODE_ALPHABET,
  LinkCodeRateLimitError,
  MAX_CODES_PER_TTL_WINDOW,
  normalizeLinkCode,
  looksLikeLinkCode,
  hashLinkCode,
  mintLinkCode,
  consumeLinkCode,
} from '@/extensions/general/whatsapp-inbox/lib/linking'
import type { SupabaseClient } from '@supabase/supabase-js'

describe('linking', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.WHATSAPP_PHONE_HASH_KEY = 'test-pepper'
    process.env.WHATSAPP_PHONE_ENCRYPTION_KEY = 'a'.repeat(64)
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  describe('normalizeLinkCode', () => {
    it('accepts the canonical form', () => {
      expect(normalizeLinkCode('AC-7KP4QF')).toBe('AC-7KP4QF')
    })

    it('uppercases and trims', () => {
      expect(normalizeLinkCode('  ac-7kp4qf ')).toBe('AC-7KP4QF')
    })

    it('tolerates a missing prefix (when digits disambiguate) and inner whitespace', () => {
      expect(normalizeLinkCode('7KP4QF')).toBe('AC-7KP4QF')
      expect(normalizeLinkCode('AC 7KP4QF')).toBe('AC-7KP4QF')
      // All-letter bodies are only accepted WITH the prefix: bare ones would
      // collide with ordinary words.
      expect(normalizeLinkCode('AC-QSTVWX')).toBe('AC-QSTVWX')
      expect(normalizeLinkCode('QSTVWX')).toBeNull()
    })

    it('rejects ambiguous characters outside the alphabet', () => {
      // 1, 0, I, O, L, U are excluded from the alphabet.
      expect(normalizeLinkCode('AC-7KP4Q1')).toBeNull()
      expect(normalizeLinkCode('AC-7KP4QO')).toBeNull()
    })

    it('rejects free text and wrong lengths', () => {
      expect(normalizeLinkCode('hej hej')).toBeNull()
      expect(normalizeLinkCode('hejhej')).toBeNull()
      expect(normalizeLinkCode('AC-7KP4Q')).toBeNull()
      expect(normalizeLinkCode('AC-7KP4QFF')).toBeNull()
      expect(normalizeLinkCode('')).toBeNull()
      expect(normalizeLinkCode(null)).toBeNull()
    })

    it('looksLikeLinkCode mirrors normalizeLinkCode', () => {
      expect(looksLikeLinkCode('ac-7kp4qf')).toBe(true)
      expect(looksLikeLinkCode('lunch med anna')).toBe(false)
    })
  })

  describe('hashLinkCode', () => {
    it('is an HMAC under the server pepper, never a bare sha256', () => {
      // 30^6 codes behind a fixed 'AC-' prefix is enumerable offline in about
      // a second, so an unpeppered digest would protect nothing at rest.
      const bare = crypto.createHash('sha256').update('AC-7KP4QF').digest('hex')
      const peppered = crypto
        .createHmac('sha256', Buffer.from('test-pepper', 'utf8'))
        .update('AC-7KP4QF')
        .digest('hex')
      expect(hashLinkCode('AC-7KP4QF')).toBe(peppered)
      expect(hashLinkCode('AC-7KP4QF')).not.toBe(bare)
    })

    it('changes with the pepper', () => {
      const withA = hashLinkCode('AC-7KP4QF')
      process.env.WHATSAPP_PHONE_HASH_KEY = 'another-pepper'
      expect(hashLinkCode('AC-7KP4QF')).not.toBe(withA)
      process.env.WHATSAPP_PHONE_HASH_KEY = 'test-pepper'
    })
  })

  describe('mintLinkCode', () => {
    it('mints an AC- prefixed code from the ambiguity-free alphabet with a 10 min TTL', async () => {
      const { supabase, enqueue, findCall } = createQueuedMockSupabase()
      enqueue({ count: 0 }) // mint-rate check
      enqueue({ data: null, error: null }) // burn earlier unused codes
      enqueue({ data: null, error: null })

      const before = Date.now()
      const minted = await mintLinkCode(supabase as unknown as SupabaseClient, 'user-1')

      expect(minted.code).toMatch(/^AC-[A-Z2-9]{6}$/)
      for (const ch of minted.code.slice(3)) {
        expect(CODE_ALPHABET).toContain(ch)
      }
      const ttlMs = new Date(minted.expiresAt).getTime() - before
      expect(ttlMs).toBeGreaterThan(9 * 60 * 1000)
      expect(ttlMs).toBeLessThanOrEqual(10 * 60 * 1000 + 5000)

      const insertArgs = findCall('whatsapp_link_codes', 'insert') as [Record<string, unknown>]
      expect(insertArgs[0].user_id).toBe('user-1')
      expect(insertArgs[0].code_hash).toBe(hashLinkCode(minted.code))
    })

    it('throws when the insert fails', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ count: 0 })
      enqueue({ data: null, error: null })
      enqueue({ data: null, error: { message: 'boom' } })
      await expect(
        mintLinkCode(supabase as unknown as SupabaseClient, 'user-1'),
      ).rejects.toThrow(/boom/)
    })

    it('burns the caller earlier unused codes so only the newest one works', async () => {
      const { supabase, enqueue, findCall } = createQueuedMockSupabase()
      enqueue({ count: 1 })
      enqueue({ data: null, error: null })
      enqueue({ data: null, error: null })

      await mintLinkCode(supabase as unknown as SupabaseClient, 'user-1')

      const burn = findCall('whatsapp_link_codes', 'update') as [Record<string, unknown>]
      expect(burn[0].used_at).toBeTruthy()
    })

    it('refuses to mint once the caller has burned through the window quota', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ count: MAX_CODES_PER_TTL_WINDOW })

      await expect(
        mintLinkCode(supabase as unknown as SupabaseClient, 'user-1'),
      ).rejects.toBeInstanceOf(LinkCodeRateLimitError)
    })
  })

  describe('consumeLinkCode', () => {
    const futureExpiry = () => new Date(Date.now() + 5 * 60 * 1000).toISOString()

    it('consumes a valid unused code', async () => {
      const { supabase, enqueue, findCall } = createQueuedMockSupabase()
      enqueue({ data: { id: 'code-1', user_id: 'user-1', expires_at: futureExpiry(), used_at: null } })
      enqueue({ data: { id: 'code-1' } })

      const result = await consumeLinkCode(supabase as unknown as SupabaseClient, 'ac-7kp4qf')
      expect(result).toEqual({ userId: 'user-1' })
      const updateArgs = findCall('whatsapp_link_codes', 'update') as [Record<string, unknown>]
      expect(updateArgs[0].used_at).toBeTruthy()
    })

    it('rejects an expired code', async () => {
      const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
      enqueue({
        data: {
          id: 'code-1',
          user_id: 'user-1',
          expires_at: new Date(Date.now() - 1000).toISOString(),
          used_at: null,
        },
      })

      const result = await consumeLinkCode(supabase as unknown as SupabaseClient, 'AC-7KP4QF')
      expect(result).toBeNull()
      expect(findCalls('whatsapp_link_codes', 'update')).toHaveLength(0)
    })

    it('rejects an already-used code (single use)', async () => {
      const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
      enqueue({
        data: {
          id: 'code-1',
          user_id: 'user-1',
          expires_at: futureExpiry(),
          used_at: new Date().toISOString(),
        },
      })

      const result = await consumeLinkCode(supabase as unknown as SupabaseClient, 'AC-7KP4QF')
      expect(result).toBeNull()
      expect(findCalls('whatsapp_link_codes', 'update')).toHaveLength(0)
    })

    it('loses the claim race gracefully', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: { id: 'code-1', user_id: 'user-1', expires_at: futureExpiry(), used_at: null } })
      enqueue({ data: null }) // guarded update matched no row: someone else won

      const result = await consumeLinkCode(supabase as unknown as SupabaseClient, 'AC-7KP4QF')
      expect(result).toBeNull()
    })

    it('rejects unknown codes without touching anything', async () => {
      const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
      enqueue({ data: null })
      const result = await consumeLinkCode(supabase as unknown as SupabaseClient, 'AC-7KP4QF')
      expect(result).toBeNull()
      expect(findCalls('whatsapp_link_codes', 'update')).toHaveLength(0)
    })

    it('short-circuits on non-code text without any DB call', async () => {
      const { supabase, calls } = createQueuedMockSupabase()
      const result = await consumeLinkCode(supabase as unknown as SupabaseClient, 'hej!')
      expect(result).toBeNull()
      expect(calls).toHaveLength(0)
    })
  })
})
