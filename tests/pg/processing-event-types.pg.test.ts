import { describe, it, expect, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getClient, getPool } from '@/tests/pg/setup'
import { seedCompany } from '@/tests/pg/fixtures'
import { PROCESSING_EVENT_TYPES } from '@/lib/processing-history/append'

/**
 * Anti-drift guard for behandlingshistorik event types.
 *
 * processing_history.event_type has an FK to processing_event_types, and every
 * appendProcessingHistory call site is best-effort try/catch by design (the
 * user's operation must not fail because its audit append did). An event type
 * that is missing from the catalog therefore fails the insert silently, and the
 * act it records leaves no durable trace at all.
 *
 * That drifted four times before this test existed: each production
 * investigation registered only the one type that had surfaced in the logs
 * (20260626120000, 20260721103000, 20260813033506, 20260828154800), and ten
 * emitted types were still unregistered afterwards. The list in
 * lib/processing-history/append.ts is now the code's half of the contract, and
 * this test is the DB's half: adding a literal there without a migration fails
 * here, naming exactly what is missing.
 */
describe('processing_event_types catalog', () => {
  let catalog: Set<string>

  beforeAll(async () => {
    const { rows } = await getPool().query<{ event_type: string }>(
      'SELECT event_type FROM public.processing_event_types',
    )
    catalog = new Set(rows.map((r) => r.event_type))
  })

  it('registers every event type the code can emit', () => {
    const missing = PROCESSING_EVENT_TYPES.filter((t) => !catalog.has(t)).sort()

    // Superset, never equality: the v0.2 seed deliberately holds aspirational
    // types with no emitter today (DocumentClassified, the Match* stream, the
    // Period* stream, ...). An unused catalog row is harmless; an unregistered
    // emitted type is a silently lost audit record.
    expect(missing).toEqual([])
  })

  it('accepts a row for every registered type through the event_type FK', async () => {
    const { companyId } = await seedCompany()
    const client = await getClient()
    try {
      await client.query('BEGIN')
      for (const eventType of PROCESSING_EVENT_TYPES) {
        const aggregateId = randomUUID()
        const { rows } = await client.query<{ event_type: string }>(
          `INSERT INTO public.processing_history
             (company_id, correlation_id, aggregate_type, aggregate_id, event_type,
              payload, actor, occurred_at)
           VALUES ($1, $2, 'System', $2, $3, '{}'::jsonb,
                   '{"type":"system","id":"processing-event-types-test"}', now())
           RETURNING event_type`,
          [companyId, aggregateId, eventType],
        )
        expect(rows).toEqual([{ event_type: eventType }])
      }
    } finally {
      // The catalog is what is under test; the sample rows are not worth
      // keeping, and rolling back leaves the shared database as it was.
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })

  // The application no longer sends `from` or `subject` for these two types,
  // but migrations land minutes before the replacement build is live, so an
  // old instance can still write them in that window. processing_history takes
  // no UPDATE and no DELETE and is excluded from the archive erasure path, so
  // such a row would be permanent. The strip is enforced in the database.
  it.each(['RateLimitedDropped', 'AttachmentsTruncated'])(
    'strips sender address and subject from a %s payload on insert',
    async (eventType) => {
      const { companyId } = await seedCompany()
      const client = await getClient()
      try {
        await client.query('BEGIN')
        const aggregateId = randomUUID()
        const { rows } = await client.query<{ payload: Record<string, unknown> }>(
          `INSERT INTO public.processing_history
             (company_id, correlation_id, aggregate_type, aggregate_id, event_type,
              payload, actor, occurred_at)
           VALUES ($1, $2, 'System', $2, $3,
                   $4::jsonb,
                   '{"type":"system","id":"processing-event-types-test"}', now())
           RETURNING payload`,
          [
            companyId,
            aggregateId,
            eventType,
            JSON.stringify({
              from: 'avsandare@example.com',
              subject: 'Faktura 12345',
              reason: 'rate_limited',
              count: 3,
            }),
          ],
        )
        expect(rows[0].payload).not.toHaveProperty('from')
        expect(rows[0].payload).not.toHaveProperty('subject')
        // Everything that is not PII survives: this is a strip, not a wipe.
        expect(rows[0].payload).toMatchObject({ reason: 'rate_limited', count: 3 })
      } finally {
        await client.query('ROLLBACK').catch(() => {})
        client.release()
      }
    },
  )

  it('leaves payloads for other event types untouched', async () => {
    const { companyId } = await seedCompany()
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const aggregateId = randomUUID()
      const { rows } = await client.query<{ payload: Record<string, unknown> }>(
        `INSERT INTO public.processing_history
           (company_id, correlation_id, aggregate_type, aggregate_id, event_type,
            payload, actor, occurred_at)
         VALUES ($1, $2, 'System', $2, 'DocumentDuplicateSkipped',
                 $3::jsonb,
                 '{"type":"system","id":"processing-event-types-test"}', now())
         RETURNING payload`,
        [companyId, aggregateId, JSON.stringify({ from: 'keep-me', subject: 'keep-me-too' })],
      )
      expect(rows[0].payload).toMatchObject({ from: 'keep-me', subject: 'keep-me-too' })
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })
})
