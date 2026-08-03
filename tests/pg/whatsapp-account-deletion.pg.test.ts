import { randomUUID, createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser } from './fixtures'

/**
 * Migration 20260803090000: anonymize_user_account must erase the WhatsApp
 * channel too.
 *
 * whatsapp_phone_links.user_id declares ON DELETE CASCADE, but Accounted
 * never deletes auth.users (the row is tombstoned for ~100 years), so the
 * cascade never fires. Before the migration an erased data subject kept an
 * ACTIVE phone link with a decryptable phone_enc, and every further inbound
 * message was persisted with its content: GDPR Art 17 plus continued
 * collection with no lawful basis. These tests fail against the pre-migration
 * definition of the RPC.
 */

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

interface SeededChannel {
  userId: string
  linkId: string
  conversationId: string
  messageId: string
  codeId: string
}

async function seedLinkedUser(): Promise<SeededChannel> {
  const userId = await insertAuthUser()
  await getPool().query(
    `INSERT INTO public.profiles (id, email, full_name)
     VALUES ($1, $2, 'PG Real')
     ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, full_name = EXCLUDED.full_name`,
    [userId, `pg-real-${userId}@test.invalid`],
  )

  const linkId = randomUUID()
  await getPool().query(
    `INSERT INTO public.whatsapp_phone_links
       (id, user_id, phone_hash, phone_enc, phone_masked, wa_profile_name)
     VALUES ($1, $2, $3, 'deadbeefcafe', '+46 70 *** ** 67', 'Erased Person')`,
    [linkId, userId, hash(randomUUID())],
  )

  const conversationId = randomUUID()
  await getPool().query(
    `INSERT INTO public.whatsapp_conversations (id, phone_link_id, state, context)
     VALUES ($1, $2, 'awaiting_company', '{"company_options": [{"id": "x", "name": "Bolag AB"}]}'::jsonb)`,
    [conversationId, linkId],
  )

  const messageId = randomUUID()
  await getPool().query(
    `INSERT INTO public.whatsapp_messages
       (id, direction, wamid, sender_phone_hash, phone_link_id, conversation_id,
        message_type, body_text, raw_payload, processing_status)
     VALUES ($1, 'inbound', $2, $3, $4, $5, 'text', 'lunch med Anna',
             '{"from": "46701234567", "type": "text"}'::jsonb, 'done')`,
    [messageId, `wamid.${randomUUID()}`, hash('sender'), linkId, conversationId],
  )

  const codeId = randomUUID()
  await getPool().query(
    `INSERT INTO public.whatsapp_link_codes (id, user_id, code_hash, expires_at)
     VALUES ($1, $2, $3, now() + interval '10 minutes')`,
    [codeId, userId, hash(randomUUID())],
  )

  return { userId, linkId, conversationId, messageId, codeId }
}

describe('anonymize_user_account: WhatsApp channel erasure (pg)', () => {
  it('revokes and shreds the phone link so the number stops resolving', async () => {
    const seeded = await seedLinkedUser()

    await withUserContext(seeded.userId, async (client) => {
      await client.query('SELECT public.anonymize_user_account($1)', [seeded.userId])
      await client.query('RESET ROLE')

      const { rows } = await client.query<{
        revoked_at: string | null
        phone_enc: string
        phone_masked: string
        wa_profile_name: string | null
        default_company_id: string | null
        last_company_id: string | null
      }>(
        `SELECT revoked_at, phone_enc, phone_masked, wa_profile_name,
                default_company_id, last_company_id
           FROM public.whatsapp_phone_links WHERE id = $1`,
        [seeded.linkId],
      )
      expect(rows).toHaveLength(1)
      // revoked_at is what lookupActiveLink filters on: a revoked link makes
      // every further inbound message take the unknown-sender path, which
      // persists no content at all.
      expect(rows[0]!.revoked_at).not.toBeNull()
      expect(rows[0]!.phone_enc).toBe('')
      expect(rows[0]!.phone_masked).toBe('+** *** ** **')
      expect(rows[0]!.wa_profile_name).toBeNull()
      expect(rows[0]!.default_company_id).toBeNull()
      expect(rows[0]!.last_company_id).toBeNull()
    })
  })

  it('nulls body_text and raw_payload on every message of that link', async () => {
    const seeded = await seedLinkedUser()

    await withUserContext(seeded.userId, async (client) => {
      await client.query('SELECT public.anonymize_user_account($1)', [seeded.userId])
      await client.query('RESET ROLE')

      const { rows } = await client.query<{
        body_text: string | null
        raw_payload: unknown
        wamid: string | null
      }>(
        `SELECT body_text, raw_payload, wamid
           FROM public.whatsapp_messages WHERE id = $1`,
        [seeded.messageId],
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]!.body_text).toBeNull()
      expect(rows[0]!.raw_payload).toBeNull()
      // The skeleton survives: "a message existed" stays auditable.
      expect(rows[0]!.wamid).not.toBeNull()
    })
  })

  it('resets the conversation and deletes outstanding link codes', async () => {
    const seeded = await seedLinkedUser()

    await withUserContext(seeded.userId, async (client) => {
      await client.query('SELECT public.anonymize_user_account($1)', [seeded.userId])
      await client.query('RESET ROLE')

      const conversation = await client.query<{
        state: string
        context: Record<string, unknown>
        company_id: string | null
      }>(
        `SELECT state, context, company_id
           FROM public.whatsapp_conversations WHERE id = $1`,
        [seeded.conversationId],
      )
      expect(conversation.rows[0]!.state).toBe('idle')
      expect(conversation.rows[0]!.context).toEqual({})
      expect(conversation.rows[0]!.company_id).toBeNull()

      const codes = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM public.whatsapp_link_codes WHERE user_id = $1`,
        [seeded.userId],
      )
      expect(codes.rows[0]!.n).toBe(0)
    })
  })

  it('leaves another user WhatsApp data untouched', async () => {
    const erased = await seedLinkedUser()
    const bystander = await seedLinkedUser()

    await withUserContext(erased.userId, async (client) => {
      await client.query('SELECT public.anonymize_user_account($1)', [erased.userId])
      await client.query('RESET ROLE')

      const { rows } = await client.query<{ revoked_at: string | null; phone_enc: string }>(
        `SELECT revoked_at, phone_enc FROM public.whatsapp_phone_links WHERE id = $1`,
        [bystander.linkId],
      )
      expect(rows[0]!.revoked_at).toBeNull()
      expect(rows[0]!.phone_enc).toBe('deadbeefcafe')

      const message = await client.query<{ body_text: string | null }>(
        `SELECT body_text FROM public.whatsapp_messages WHERE id = $1`,
        [bystander.messageId],
      )
      expect(message.rows[0]!.body_text).toBe('lunch med Anna')
    })
  })
})
