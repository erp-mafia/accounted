import { describe, it, expect } from 'vitest'
import { getPool, withUserContext } from './setup'
import { randomUUID } from 'crypto'
import { seedCompany } from './fixtures'

// Committed (pool) inserts persist across pg-real runs, and the store_url
// partial unique index is global: fixed URLs would collide with rows left by
// a previous run before the assertion under test is ever reached.
const uniqueStore = (label: string) => 'https://' + label + '-' + randomUUID() + '.example.se'

// An ACTIVE row must carry both activation signals (CHECK, 20260907143000):
// stored credentials and the session-bound browser confirmation.
const ACTIVE_COLUMNS =
  '(company_id, user_id, store_url, status, consumer_key_encrypted, consumer_secret_encrypted, browser_confirmed_at)'
const ACTIVE_VALUES = "'active', 'enc:k', 'enc:s', now()"

/**
 * Covers migration 20260806170000_woocommerce_connections:
 *   1. RLS: members insert and read their own company's connection,
 *      non-members see nothing and cannot insert for a foreign company.
 *   2. Multiple ACTIVE connections per company (multi-store: the
 *      one-active-per-company index was dropped in 20260811073422).
 *   3. One store actively connected to at most one company.
 *   4. No DELETE policy: a member DELETE silently affects zero rows.
 * Covers migration 20260907143000_woocommerce_activation_gate:
 *   5. status = 'active' requires stored credentials AND browser_confirmed_at,
 *      on insert and on update, so the wc-auth callback (keys only) and the
 *      return leg (confirmation only) can each write their signal without
 *      either alone ever producing a syncable row.
 * Covers migration 20260907150000_woocommerce_browser_confirmation_server_only:
 *   6. browser_confirmed_at is server-only: an end-user session (JWT role
 *      authenticated) cannot insert or update it, even on its own company's
 *      row, so a colleague cannot supply the initiator's signal. Service-role
 *      and pool writes pass.
 *   7. Activation is server-only: an end-user session cannot insert an
 *      'active' row or move a row into 'active', even one that carries both
 *      signals (the TTL lives in the server's conditional update, which the
 *      CHECK alone does not enforce). Leaving 'active' stays member-writable.
 */

describe('woocommerce_connections RLS', () => {
  it('a member can insert and read their company connection', async () => {
    const { userId, companyId } = await seedCompany()
    await withUserContext(userId, async (client) => {
      const inserted = await client.query(
        `INSERT INTO public.woocommerce_connections
           (company_id, user_id, store_url, status, oauth_state)
         VALUES ($1, $2, 'https://shop.example.se', 'pending', gen_random_uuid())
         RETURNING id`,
        [companyId, userId],
      )
      expect(inserted.rows).toHaveLength(1)

      const read = await client.query(
        `SELECT status, store_url FROM public.woocommerce_connections WHERE company_id = $1`,
        [companyId],
      )
      expect(read.rows).toEqual([
        { status: 'pending', store_url: 'https://shop.example.se' },
      ])
    })
  })

  it('a non-member sees nothing and cannot insert for a foreign company', async () => {
    const { userId: ownerId, companyId } = await seedCompany()
    await getPool().query(
      `INSERT INTO public.woocommerce_connections ${ACTIVE_COLUMNS}
       VALUES ($1, $2, $3, ${ACTIVE_VALUES})`,
      [companyId, ownerId, uniqueStore('foreign')],
    )
    const { userId: outsiderId } = await seedCompany() // member of a DIFFERENT company

    await withUserContext(outsiderId, async (client) => {
      const read = await client.query(
        `SELECT id FROM public.woocommerce_connections WHERE company_id = $1`,
        [companyId],
      )
      expect(read.rows).toHaveLength(0)

      await expect(
        client.query(
          `INSERT INTO public.woocommerce_connections (company_id, user_id, store_url, status)
           VALUES ($1, $2, 'https://intruder.example.se', 'pending')`,
          [companyId, outsiderId],
        ),
      ).rejects.toThrow(/row-level security/i)
    })
  })

  it('a company may hold several ACTIVE connections (multi-store)', async () => {
    const { userId, companyId } = await seedCompany()
    await getPool().query(
      `INSERT INTO public.woocommerce_connections ${ACTIVE_COLUMNS}
       VALUES ($1, $2, $3, ${ACTIVE_VALUES})`,
      [companyId, userId, uniqueStore('store-one')],
    )
    const second = await getPool().query(
      `INSERT INTO public.woocommerce_connections ${ACTIVE_COLUMNS}
       VALUES ($1, $2, $3, ${ACTIVE_VALUES}) RETURNING id`,
      [companyId, userId, uniqueStore('store-two')],
    )
    expect(second.rows).toHaveLength(1)
  })

  it('a store may be actively connected to at most one company', async () => {
    const { userId: userA, companyId: companyA } = await seedCompany()
    const { userId: userB, companyId: companyB } = await seedCompany()
    const sharedUrl = uniqueStore('shared')
    await getPool().query(
      `INSERT INTO public.woocommerce_connections ${ACTIVE_COLUMNS}
       VALUES ($1, $2, $3, ${ACTIVE_VALUES})`,
      [companyA, userA, sharedUrl],
    )
    await expect(
      getPool().query(
        `INSERT INTO public.woocommerce_connections ${ACTIVE_COLUMNS}
         VALUES ($1, $2, $3, ${ACTIVE_VALUES})`,
        [companyB, userB, sharedUrl],
      ),
    ).rejects.toMatchObject({ code: '23505' })

    // A revoked row for the same store is fine (history is kept).
    const revoked = await getPool().query(
      `INSERT INTO public.woocommerce_connections (company_id, user_id, store_url, status)
       VALUES ($1, $2, $3, 'revoked') RETURNING id`,
      [companyB, userB, sharedUrl],
    )
    expect(revoked.rows).toHaveLength(1)
  })

  it('members cannot DELETE (no DELETE policy; revoke is a status flip)', async () => {
    const { userId, companyId } = await seedCompany()
    const { rows } = await getPool().query(
      `INSERT INTO public.woocommerce_connections ${ACTIVE_COLUMNS}
       VALUES ($1, $2, $3, ${ACTIVE_VALUES}) RETURNING id`,
      [companyId, userId, uniqueStore('keep')],
    )
    await withUserContext(userId, async (client) => {
      const del = await client.query(
        `DELETE FROM public.woocommerce_connections WHERE id = $1`,
        [rows[0].id],
      )
      expect(del.rowCount).toBe(0)
    })
    const still = await getPool().query(
      `SELECT id FROM public.woocommerce_connections WHERE id = $1`,
      [rows[0].id],
    )
    expect(still.rows).toHaveLength(1)
  })

  describe('activation gate (20260907143000)', () => {
    const insertPending = async (companyId: string, userId: string, storeUrl: string) => {
      const { rows } = await getPool().query(
        `INSERT INTO public.woocommerce_connections (company_id, user_id, store_url, status, oauth_state)
         VALUES ($1, $2, $3, 'pending', gen_random_uuid()) RETURNING id`,
        [companyId, userId, storeUrl],
      )
      return rows[0].id as string
    }

    it('refuses an active row that has keys but no browser confirmation', async () => {
      const { userId, companyId } = await seedCompany()
      await expect(
        getPool().query(
          `INSERT INTO public.woocommerce_connections
             (company_id, user_id, store_url, status, consumer_key_encrypted, consumer_secret_encrypted)
           VALUES ($1, $2, $3, 'active', 'enc:k', 'enc:s')`,
          [companyId, userId, uniqueStore('keys-only')],
        ),
      ).rejects.toMatchObject({ code: '23514' })
    })

    it('refuses an active row that has a browser confirmation but no keys', async () => {
      const { userId, companyId } = await seedCompany()
      await expect(
        getPool().query(
          `INSERT INTO public.woocommerce_connections
             (company_id, user_id, store_url, status, browser_confirmed_at)
           VALUES ($1, $2, $3, 'active', now())`,
          [companyId, userId, uniqueStore('browser-only')],
        ),
      ).rejects.toMatchObject({ code: '23514' })
    })

    it('lets each leg stage its own signal on a pending row, and the conditional flip activates exactly once', async () => {
      const { userId, companyId } = await seedCompany()
      const id = await insertPending(companyId, userId, uniqueStore('two-legs'))

      // Callback leg: keys only. Still pending, so no consumer can select it.
      await getPool().query(
        `UPDATE public.woocommerce_connections
            SET consumer_key_encrypted = 'enc:k', consumer_secret_encrypted = 'enc:s'
          WHERE id = $1 AND status = 'pending'`,
        [id],
      )
      // Flipping now must be refused by the CHECK: browser has not confirmed.
      await expect(
        getPool().query(
          `UPDATE public.woocommerce_connections SET status = 'active' WHERE id = $1`,
          [id],
        ),
      ).rejects.toMatchObject({ code: '23514' })

      // The application-side conditional flip (activateIfComplete) matches
      // zero rows instead of erroring: the WHERE carries the same predicate.
      const flip = () =>
        getPool().query(
          `UPDATE public.woocommerce_connections
              SET status = 'active', oauth_state = NULL
            WHERE id = $1 AND status = 'pending'
              AND consumer_key_encrypted IS NOT NULL
              AND consumer_secret_encrypted IS NOT NULL
              AND browser_confirmed_at IS NOT NULL
              AND created_at >= now() - interval '15 minutes'`,
          [id],
        )
      expect((await flip()).rowCount).toBe(0)

      // Return leg: confirmation. Now the flip succeeds, and only once.
      await getPool().query(
        `UPDATE public.woocommerce_connections SET browser_confirmed_at = now()
          WHERE id = $1 AND status = 'pending'`,
        [id],
      )
      expect((await flip()).rowCount).toBe(1)
      expect((await flip()).rowCount).toBe(0)

      const { rows } = await getPool().query(
        `SELECT status, oauth_state FROM public.woocommerce_connections WHERE id = $1`,
        [id],
      )
      expect(rows[0]).toEqual({ status: 'active', oauth_state: null })
    })

    it('never flips a pending row older than the handshake TTL, even with both signals present', async () => {
      const { userId, companyId } = await seedCompany()
      const id = await insertPending(companyId, userId, uniqueStore('stale'))
      // Initiator confirmed early, keys landed hours later.
      await getPool().query(
        `UPDATE public.woocommerce_connections
            SET browser_confirmed_at = now(),
                consumer_key_encrypted = 'enc:k', consumer_secret_encrypted = 'enc:s',
                created_at = now() - interval '20 minutes'
          WHERE id = $1`,
        [id],
      )
      const flip = await getPool().query(
        `UPDATE public.woocommerce_connections
            SET status = 'active', oauth_state = NULL
          WHERE id = $1 AND status = 'pending'
            AND consumer_key_encrypted IS NOT NULL
            AND consumer_secret_encrypted IS NOT NULL
            AND browser_confirmed_at IS NOT NULL
            AND created_at >= now() - interval '15 minutes'`,
        [id],
      )
      expect(flip.rowCount).toBe(0)
      const { rows } = await getPool().query(
        `SELECT status FROM public.woocommerce_connections WHERE id = $1`,
        [id],
      )
      expect(rows[0].status).toBe('pending')
    })

    it('refuses browser_confirmed_at from an end-user session, on insert and on update', async () => {
      const { userId, companyId } = await seedCompany()
      const id = await insertPending(companyId, userId, uniqueStore('server-only'))
      await getPool().query(
        `UPDATE public.woocommerce_connections
            SET consumer_key_encrypted = 'enc:k', consumer_secret_encrypted = 'enc:s'
          WHERE id = $1`,
        [id],
      )
      // One user block per statement: withUserContext is a single transaction
      // and the first refusal aborts it.
      await withUserContext(userId, async (client) => {
        // A member of the company (RLS passes) still cannot supply the signal.
        await expect(
          client.query(
            `UPDATE public.woocommerce_connections SET browser_confirmed_at = now() WHERE id = $1`,
            [id],
          ),
        ).rejects.toMatchObject({ code: '42501' })
      })
      await withUserContext(userId, async (client) => {
        await expect(
          client.query(
            `INSERT INTO public.woocommerce_connections
               (company_id, user_id, store_url, status, browser_confirmed_at)
             VALUES ($1, $2, $3, 'pending', now())`,
            [companyId, userId, uniqueStore('server-only-insert')],
          ),
        ).rejects.toMatchObject({ code: '42501' })
      })
      await withUserContext(userId, async (client) => {
        // Other columns stay member-writable (the disconnect/supersede paths).
        const ok = await client.query(
          `UPDATE public.woocommerce_connections SET error_message = 'x' WHERE id = $1`,
          [id],
        )
        expect(ok.rowCount).toBe(1)
      })
      // The server path (no end-user JWT) can.
      const server = await getPool().query(
        `UPDATE public.woocommerce_connections SET browser_confirmed_at = now()
          WHERE id = $1 RETURNING browser_confirmed_at`,
        [id],
      )
      expect(server.rows[0].browser_confirmed_at).not.toBeNull()
    })

    it('refuses an end-user session moving a fully staged row into active, but lets it leave active', async () => {
      const { userId, companyId } = await seedCompany()
      const id = await insertPending(companyId, userId, uniqueStore('user-activate'))
      // Both signals present, staged by the server, but already past the TTL:
      // the CHECK would pass, the server's conditional flip would not.
      await getPool().query(
        `UPDATE public.woocommerce_connections
            SET consumer_key_encrypted = 'enc:k', consumer_secret_encrypted = 'enc:s',
                browser_confirmed_at = now(), created_at = now() - interval '20 minutes'
          WHERE id = $1`,
        [id],
      )
      await withUserContext(userId, async (client) => {
        await expect(
          client.query(
            `UPDATE public.woocommerce_connections SET status = 'active' WHERE id = $1`,
            [id],
          ),
        ).rejects.toMatchObject({ code: '42501' })
      })
      await withUserContext(userId, async (client) => {
        await expect(
          client.query(
            `INSERT INTO public.woocommerce_connections
               (company_id, user_id, store_url, status, consumer_key_encrypted, consumer_secret_encrypted)
             VALUES ($1, $2, $3, 'active', 'enc:k', 'enc:s')`,
            [companyId, userId, uniqueStore('user-activate-insert')],
          ),
        ).rejects.toMatchObject({ code: '42501' })
      })
      // The server activates; the member may then disconnect (leave active).
      await getPool().query(
        `UPDATE public.woocommerce_connections SET status = 'active', created_at = now() WHERE id = $1`,
        [id],
      )
      await withUserContext(userId, async (client) => {
        const revoked = await client.query(
          `UPDATE public.woocommerce_connections
              SET status = 'revoked', consumer_key_encrypted = NULL, consumer_secret_encrypted = NULL
            WHERE id = $1`,
          [id],
        )
        expect(revoked.rowCount).toBe(1)
      })
    })

    it('lets a parked row drop its keys: the CHECK only constrains active rows', async () => {
      const { userId, companyId } = await seedCompany()
      const id = await insertPending(companyId, userId, uniqueStore('parked'))
      const parked = await getPool().query(
        `UPDATE public.woocommerce_connections
            SET status = 'error', oauth_state = NULL,
                consumer_key_encrypted = NULL, consumer_secret_encrypted = NULL
          WHERE id = $1 RETURNING status`,
        [id],
      )
      expect(parked.rows[0].status).toBe('error')
    })
  })
})
