import { randomUUID, createHash } from 'node:crypto'
import { describe, it, expect, beforeAll } from 'vitest'
import { getPool, withUserContext } from './setup'
import { seedCompany, insertAuthUser } from './fixtures'

// Migrations under test: 20260802090000 (phone links + link codes),
// 20260802091000 (conversations + messages + sender quota RPC),
// 20260802092000 (inbox source CHECK widening + channel_context),
// 20260802210000 (acked_at combined-ack marker).

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function insertPhoneLink(params: {
  userId: string
  phoneHash?: string
  revokedAt?: string | null
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.whatsapp_phone_links
       (id, user_id, phone_hash, phone_enc, phone_masked, revoked_at)
     VALUES ($1, $2, $3, '\\x00', '+46 70 *** ** 00', $4)`,
    [id, params.userId, params.phoneHash ?? hash(randomUUID()), params.revokedAt ?? null],
  )
  return id
}

describe('whatsapp_phone_links', () => {
  let userA: string
  let userB: string
  let linkA: string

  beforeAll(async () => {
    userA = await insertAuthUser()
    userB = await insertAuthUser()
    linkA = await insertPhoneLink({ userId: userA })
    await insertPhoneLink({ userId: userB })
  })

  it('lets a user read only their own link', async () => {
    const rows = await withUserContext(userA, async (client) => {
      const res = await client.query(`SELECT id, user_id FROM public.whatsapp_phone_links`)
      return res.rows
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(linkA)
  })

  it('lets a user update their own link but blocks INSERT (service-role only)', async () => {
    await withUserContext(userA, async (client) => {
      const upd = await client.query(
        `UPDATE public.whatsapp_phone_links SET muted_at = now() WHERE id = $1 RETURNING id`,
        [linkA],
      )
      expect(upd.rows).toHaveLength(1)
    })

    await expect(
      withUserContext(userA, async (client) => {
        await client.query(
          `INSERT INTO public.whatsapp_phone_links
             (user_id, phone_hash, phone_enc, phone_masked)
           VALUES ($1, $2, '\\x00', '+46 70 *** ** 11')`,
          [userA, hash('self-insert')],
        )
      }),
    ).rejects.toThrow(/row-level security/)
  })

  it('cannot update another user’s link', async () => {
    const updated = await withUserContext(userB, async (client) => {
      const res = await client.query(
        `UPDATE public.whatsapp_phone_links SET muted_at = now() WHERE id = $1 RETURNING id`,
        [linkA],
      )
      return res.rows
    })
    expect(updated).toHaveLength(0)
  })

  it('enforces one ACTIVE link per phone, allowing rebinding after revocation', async () => {
    // Unique per run: pool inserts commit, so a fixed hash would collide
    // with rows left behind by a previous suite run against the same DB.
    const phoneHash = hash(`shared-phone-${randomUUID()}`)
    const owner1 = await insertAuthUser()
    const owner2 = await insertAuthUser()
    await insertPhoneLink({ userId: owner1, phoneHash })

    await expect(insertPhoneLink({ userId: owner2, phoneHash })).rejects.toThrow(
      /whatsapp_phone_links_phone_active/,
    )

    await getPool().query(
      `UPDATE public.whatsapp_phone_links SET revoked_at = now() WHERE phone_hash = $1`,
      [phoneHash],
    )
    await expect(insertPhoneLink({ userId: owner2, phoneHash })).resolves.toBeTruthy()
  })

  it('enforces one ACTIVE link per user', async () => {
    const owner = await insertAuthUser()
    await insertPhoneLink({ userId: owner })
    await expect(insertPhoneLink({ userId: owner })).rejects.toThrow(
      /whatsapp_phone_links_user_active/,
    )
  })
})

describe('whatsapp_link_codes / conversations / messages are service-role only', () => {
  it('hides link codes, conversations and messages from authenticated users', async () => {
    const { userId } = await seedCompany()
    const linkId = await insertPhoneLink({ userId })
    await getPool().query(
      `INSERT INTO public.whatsapp_link_codes (user_id, code_hash, expires_at)
       VALUES ($1, $2, now() + interval '10 minutes')`,
      [userId, hash(randomUUID())],
    )
    await getPool().query(
      `INSERT INTO public.whatsapp_conversations (phone_link_id) VALUES ($1)`,
      [linkId],
    )
    await getPool().query(
      `INSERT INTO public.whatsapp_messages (direction, message_type, phone_link_id)
       VALUES ('inbound', 'text', $1)`,
      [linkId],
    )

    await withUserContext(userId, async (client) => {
      for (const table of [
        'whatsapp_link_codes',
        'whatsapp_conversations',
        'whatsapp_messages',
      ]) {
        const res = await client.query(`SELECT count(*)::int AS n FROM public.${table}`)
        expect(res.rows[0].n).toBe(0)
      }
    })
  })
})

describe('whatsapp_messages wamid idempotency', () => {
  it('rejects duplicate INBOUND wamids but allows outbound reuse', async () => {
    const wamid = `wamid.${randomUUID()}`
    await getPool().query(
      `INSERT INTO public.whatsapp_messages (direction, message_type, wamid)
       VALUES ('inbound', 'image', $1)`,
      [wamid],
    )

    await expect(
      getPool().query(
        `INSERT INTO public.whatsapp_messages (direction, message_type, wamid)
         VALUES ('inbound', 'image', $1)`,
        [wamid],
      ),
    ).rejects.toThrow(/whatsapp_messages_inbound_wamid/)

    // ON CONFLICT DO NOTHING over the partial index is the webhook's dedupe.
    const dedupe = await getPool().query(
      `INSERT INTO public.whatsapp_messages (direction, message_type, wamid)
       VALUES ('inbound', 'image', $1)
       ON CONFLICT (wamid) WHERE wamid IS NOT NULL AND direction = 'inbound'
       DO NOTHING
       RETURNING id`,
      [wamid],
    )
    expect(dedupe.rows).toHaveLength(0)

    // The partial index does not constrain outbound rows.
    await expect(
      getPool().query(
        `INSERT INTO public.whatsapp_messages (direction, message_type, wamid)
         VALUES ('outbound', 'text', $1)`,
        [wamid],
      ),
    ).resolves.toBeTruthy()
  })
})

describe('inbox source widening (20260802092000)', () => {
  it('accepts source=whatsapp with channel_context and links the message', async () => {
    const { userId, companyId } = await seedCompany()
    const linkId = await insertPhoneLink({ userId })
    const msg = await getPool().query(
      `INSERT INTO public.whatsapp_messages (direction, message_type, phone_link_id)
       VALUES ('inbound', 'image', $1) RETURNING id`,
      [linkId],
    )
    const messageId = msg.rows[0].id

    const item = await getPool().query(
      `INSERT INTO public.invoice_inbox_items
         (company_id, user_id, status, source, whatsapp_message_id, channel_context, extracted_data)
       VALUES ($1, $2, 'received', 'whatsapp', $3, $4, '{}')
       RETURNING id, source, channel_context`,
      [
        companyId,
        userId,
        messageId,
        JSON.stringify({ channel: 'whatsapp', caption: 'lunch med kund' }),
      ],
    )
    expect(item.rows[0].source).toBe('whatsapp')
    expect(item.rows[0].channel_context.caption).toBe('lunch med kund')

    // One inbox item per delivering chat message.
    await expect(
      getPool().query(
        `INSERT INTO public.invoice_inbox_items
           (company_id, user_id, status, source, whatsapp_message_id, extracted_data)
         VALUES ($1, $2, 'received', 'whatsapp', $3, '{}')`,
        [companyId, userId, messageId],
      ),
    ).rejects.toThrow(/invoice_inbox_items_whatsapp_msg/)
  })

  it('still rejects unknown sources (the widened CHECK actually replaced the old one)', async () => {
    const { userId, companyId } = await seedCompany()
    await expect(
      getPool().query(
        `INSERT INTO public.invoice_inbox_items
           (company_id, user_id, status, source, extracted_data)
         VALUES ($1, $2, 'received', 'carrier_pigeon', '{}')`,
        [companyId, userId],
      ),
    ).rejects.toThrow(/invoice_inbox_items_source_check/)
  })

  it('accepts upload_source=whatsapp on document_attachments and rejects unknown values', async () => {
    const { userId, companyId } = await seedCompany()
    await expect(
      getPool().query(
        `INSERT INTO public.document_attachments
           (user_id, company_id, file_name, mime_type, file_size_bytes,
            storage_path, sha256_hash, upload_source)
         VALUES ($1, $2, 'kvitto.jpg', 'image/jpeg', 1024,
                 $3, $4, 'whatsapp')`,
        [userId, companyId, `documents/${companyId}/${userId}/t_kvitto.jpg`, hash(randomUUID())],
      ),
    ).resolves.toBeTruthy()

    await expect(
      getPool().query(
        `INSERT INTO public.document_attachments
           (user_id, company_id, file_name, mime_type, file_size_bytes,
            storage_path, sha256_hash, upload_source)
         VALUES ($1, $2, 'kvitto.jpg', 'image/jpeg', 1024,
                 $3, $4, 'telegram')`,
        [userId, companyId, `documents/${companyId}/${userId}/t2_kvitto.jpg`, hash(randomUUID())],
      ),
    ).rejects.toThrow(/document_attachments_upload_source_check/)
  })
})

describe('burst debounce claim + acked_at marker (20260802210000)', () => {
  it('lets exactly one claimant win a due pending_ack, and none before the deadline', async () => {
    const userId = await insertAuthUser()
    const linkId = await insertPhoneLink({ userId })
    const conv = await getPool().query(
      `INSERT INTO public.whatsapp_conversations (phone_link_id, pending_ack, debounce_until)
       VALUES ($1, true, now() + interval '1 hour') RETURNING id`,
      [linkId],
    )
    const conversationId = conv.rows[0].id

    // Deadline not reached: the claim must not fire.
    const early = await getPool().query(
      `UPDATE public.whatsapp_conversations SET pending_ack = false
       WHERE id = $1 AND pending_ack AND debounce_until <= now() RETURNING id`,
      [conversationId],
    )
    expect(early.rows).toHaveLength(0)

    await getPool().query(
      `UPDATE public.whatsapp_conversations SET debounce_until = now() - interval '1 second'
       WHERE id = $1`,
      [conversationId],
    )

    const claim = () =>
      getPool().query(
        `UPDATE public.whatsapp_conversations SET pending_ack = false
         WHERE id = $1 AND pending_ack AND debounce_until <= now() RETURNING id`,
        [conversationId],
      )
    const first = await claim()
    expect(first.rows).toHaveLength(1)
    const second = await claim()
    expect(second.rows).toHaveLength(0)
  })

  it('exposes acked_at on whatsapp_messages, null by default', async () => {
    const res = await getPool().query(
      `INSERT INTO public.whatsapp_messages (direction, message_type, processing_status)
       VALUES ('inbound', 'image', 'done') RETURNING acked_at`,
    )
    expect(res.rows[0].acked_at).toBeNull()

    const stamped = await getPool().query(
      `UPDATE public.whatsapp_messages SET acked_at = now()
       WHERE acked_at IS NULL AND direction = 'inbound' AND processing_status = 'done'
         AND conversation_id IS NULL
       RETURNING acked_at`,
    )
    expect(stamped.rows.length).toBeGreaterThan(0)
    expect(stamped.rows[0].acked_at).not.toBeNull()
  })
})

describe('check_and_increment_whatsapp_sender_quota', () => {
  it('counts per phone hash and trips the minute cap with rollback semantics', async () => {
    const phoneHash = hash(`quota-${randomUUID()}`)
    const call = () =>
      getPool().query(`SELECT public.check_and_increment_whatsapp_sender_quota($1, 2, 100) AS r`, [
        phoneHash,
      ])

    expect((await call()).rows[0].r.ok).toBe(true)
    expect((await call()).rows[0].r.ok).toBe(true)
    const third = (await call()).rows[0].r
    expect(third.ok).toBe(false)
    expect(third.scope).toBe('minute')

    // A different sender is unaffected: the key is the phone hash.
    const other = await getPool().query(
      `SELECT public.check_and_increment_whatsapp_sender_quota($1, 2, 100) AS r`,
      [hash(`other-${randomUUID()}`)],
    )
    expect(other.rows[0].r.ok).toBe(true)
  })

  it('is not executable by authenticated users (service-role only)', async () => {
    const userId = await insertAuthUser()
    await expect(
      withUserContext(userId, async (client) => {
        await client.query(
          `SELECT public.check_and_increment_whatsapp_sender_quota($1, 2, 100)`,
          [hash('nope')],
        )
      }),
    ).rejects.toThrow(/permission denied/)
  })
})
