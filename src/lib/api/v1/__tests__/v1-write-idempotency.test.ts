/**
 * Every v1 write is safe to send twice.
 *
 * A client whose call broke (timeout, dropped connection, a stateless MCP
 * bridge relaying the request again) recovers by resending it. In a ledger a
 * duplicated write can be a second verifikat, which then needs a storno and
 * leaves the series looking like it has a gap to explain. So a v1 write
 * either requires `Idempotency-Key` (withApiV1 refuses the request without
 * one and replays the first answer for a repeat), or it is listed below with
 * the reason a keyless repeat cannot write twice.
 *
 * What this pins, for every registered endpoint that is not a GET:
 *   1. it requires the key, or is listed in KEY_OPTIONAL_WRITES with a kind
 *      and a reason (a new write fails here until one of the two is true);
 *   2. nothing is listed that no longer needs to be (no grandfathering);
 *   3. a write without `:companyId` in its path replays the key itself
 *      (handlerIdempotency): withApiV1's cache is keyed by that segment, so
 *      without it the header is silently dropped, which is how
 *      POST /companies came to ignore it;
 *   4. the published `x-idempotent` tells the truth: true for a write that
 *      requires the key or cannot write twice, false for one that can.
 *
 * Reads that take a POST body (operations of kind 'read') write nothing and
 * are skipped; withApiV1 records them as readOnly.
 */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { listEndpoints, type EndpointDefinition } from '../registry'
import { v1HandlerContract, type V1HandlerContract } from '../with-api-v1'
// Side-effect import: populates the registry from every route file.
import '../load-routes'

type RetryExemption = {
  /**
   * idempotent: a keyless repeat cannot write twice (full replace, delete by
   * id, a status compare-and-set, a unique index, a dedupe key).
   * outside_books: a repeat repeats a side effect that never reaches the
   * books (a test ping, an upload slot, a provider form link, a redelivery).
   * compat: a keyless repeat can write twice, but requiring the key would
   * break callers that followed the earlier docs; the key is honoured when
   * sent and the reference tells callers to send one.
   */
  kind: 'idempotent' | 'outside_books' | 'compat'
  reason: string
}

/** `METHOD /path` of every v1 write that does not require Idempotency-Key. */
const KEY_OPTIONAL_WRITES: Record<string, RetryExemption> = {
  'POST /api/v1/companies': {
    kind: 'compat',
    reason:
      'Documented until 2026-10-15 as ignoring Idempotency-Key, so existing callers send none; requiring it would break them. Honoured when sent (handlerIdempotency), and the reference says to send one.',
  },
  'PATCH /api/v1/companies/:companyId/employees/:id': {
    kind: 'idempotent',
    reason: 'Sets the fields sent: a repeat writes the same values.',
  },
  'DELETE /api/v1/companies/:companyId/employees/:id': {
    kind: 'idempotent',
    reason: 'Soft delete (is_active=false): a repeat leaves the employee inactive.',
  },
  'PUT /api/v1/companies/:companyId/employees/:id/absence': {
    kind: 'idempotent',
    reason: 'Range upsert on the natural key (employee, date, type): a repeat converges on the same rows.',
  },
  'DELETE /api/v1/companies/:companyId/employees/:id/absence': {
    kind: 'idempotent',
    reason: 'Deletes the days in the range: a repeat finds nothing left to delete.',
  },
  'PUT /api/v1/companies/:companyId/employees/:id/worked-days': {
    kind: 'idempotent',
    reason: 'Range upsert on (employee, date): a repeat converges on the same rows.',
  },
  'DELETE /api/v1/companies/:companyId/employees/:id/worked-days': {
    kind: 'idempotent',
    reason: 'Deletes the days in the range: a repeat finds nothing left to delete.',
  },
  'PUT /api/v1/companies/:companyId/employees/:id/opening-balances': {
    kind: 'idempotent',
    reason: 'Full-replace upsert of one employee\'s cutover balances: a repeat writes the same values.',
  },
  'PUT /api/v1/companies/:companyId/employees/opening-balances': {
    kind: 'idempotent',
    reason: 'Bulk full-replace upsert of cutover balances: a repeat writes the same values.',
  },
  'PATCH /api/v1/companies/:companyId/salary-runs/:id': {
    kind: 'idempotent',
    reason: 'Sets payment_date, voucher_series or notes on a draft: a repeat writes the same values.',
  },
  'DELETE /api/v1/companies/:companyId/salary-runs/:id': {
    kind: 'idempotent',
    reason: 'Deletes a draft run: a repeat answers not found and deletes nothing more.',
  },
  'POST /api/v1/companies/:companyId/salary-runs/:id/approve': {
    kind: 'idempotent',
    reason: 'Optimistic-lock status flip review to approved: a repeat finds the run approved and changes nothing.',
  },
  'POST /api/v1/companies/:companyId/salary-runs/:id/calculate': {
    kind: 'idempotent',
    reason: 'Recomputes the run from its inputs, posts nothing: a repeat computes the same figures.',
  },
  'POST /api/v1/companies/:companyId/salary-runs/:id/book': {
    kind: 'idempotent',
    reason:
      'Atomic booking claim (salary_runs.booking_claim_id) and a status flip guarded on it: a repeat answers SALARY_RUN_ALREADY_BOOKED and never posts a second verifikat.',
  },
  'POST /api/v1/companies/:companyId/salary-runs/:id/mark-paid': {
    kind: 'idempotent',
    reason: 'Status compare-and-set approved to paid, posts nothing: a repeat answers SALARY_RUN_MARK_PAID_NOT_APPROVED.',
  },
  'POST /api/v1/companies/:companyId/salary-runs/:id/generate-agi': {
    kind: 'idempotent',
    reason: 'Upserts the run\'s agi_declarations row: a repeat regenerates the same declaration.',
  },
  'DELETE /api/v1/companies/:companyId/journal-entries/:id': {
    kind: 'idempotent',
    reason: 'Cancels a draft (no voucher number): idempotent on an already cancelled draft.',
  },
  'POST /api/v1/companies/:companyId/reports/vat-declaration/filings': {
    kind: 'idempotent',
    reason: 'Completes the period\'s moms deadline: a repeat finds it completed.',
  },
  'DELETE /api/v1/companies/:companyId/reports/vat-declaration/filings': {
    kind: 'idempotent',
    reason: 'Reopens a manually marked deadline: a repeat finds it open.',
  },
  'PATCH /api/v1/companies/:companyId/webhooks/:id': {
    kind: 'idempotent',
    reason: 'Sets the fields sent: a repeat writes the same values.',
  },
  'DELETE /api/v1/companies/:companyId/webhooks/:id': {
    kind: 'idempotent',
    reason: 'Deletes the webhook: a repeat answers not found.',
  },
  'POST /api/v1/companies/:companyId/webhooks/:id/verify': {
    kind: 'idempotent',
    reason: 'Ownership handshake with an already-verified short circuit and a cooldown: a repeat changes nothing.',
  },
  'POST /api/v1/companies/:companyId/imports/bank': {
    kind: 'idempotent',
    reason:
      'Rows dedupe on external_id and the import row upserts on (company_id, file_hash): a re-sent file imports nothing new.',
  },
  'POST /api/v1/companies/:companyId/imports/sie': {
    kind: 'idempotent',
    reason:
      'start_sie_import_job refuses a second active import of the same file (unique sie_imports (company_id, file_hash)): a repeat answers CONFLICT and posts no vouchers.',
  },
  'POST /api/v1/companies/:companyId/bank-connections/:connectionId/sync': {
    kind: 'idempotent',
    reason:
      'A durable 15-minute lease on the connection answers a repeat BANK_SYNC_COOLDOWN, and fetched rows dedupe on the bank\'s transaction id.',
  },
  'POST /api/v1/companies/:companyId/imports/sie/upload': {
    kind: 'outside_books',
    reason: 'Reserves a two-hour upload URL: a repeat reserves another slot that expires unused.',
  },
  'POST /api/v1/companies/:companyId/payment-orders/verification/start': {
    kind: 'outside_books',
    reason: 'Creates a provider form link for the company verification: a repeat replaces the stored link, nothing reaches the books.',
  },
  'POST /api/v1/companies/:companyId/webhooks/:id/test': {
    kind: 'outside_books',
    reason: 'Queues one synthetic webhook.test delivery: a repeat sends one more test event.',
  },
  'POST /api/v1/webhook-deliveries/:id/retry': {
    kind: 'outside_books',
    reason:
      'Queues a new delivery of an event already sent: a keyless repeat queues one more. Honours a supplied key (handlerIdempotency).',
  },
}

const SRC_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

/** `/api/v1/companies/:companyId/x` → `<src>/app/api/v1/companies/[companyId]/x/route.ts`. */
function routeFile(path: string): string {
  const segments = path
    .replace(/^\/api\/v1/, '')
    .split('/')
    .filter(Boolean)
    .map((segment) => (segment.startsWith(':') ? `[${segment.slice(1)}]` : segment))
  return join(SRC_ROOT, 'app', 'api', 'v1', ...segments, 'route.ts')
}

const keyOf = (endpoint: Pick<EndpointDefinition, 'method' | 'path'>) => `${endpoint.method} ${endpoint.path}`

/**
 * Everything wrong with the retry contract of these writes, one line each.
 * Pure, so the rogue cases at the bottom can prove the check has teeth.
 */
function retryContractProblems(
  writes: Array<{ endpoint: EndpointDefinition; contract: V1HandlerContract | undefined }>,
  exemptions: Record<string, RetryExemption>,
): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const { endpoint, contract } of writes) {
    const key = keyOf(endpoint)
    if (!contract) {
      problems.push(`${key}: the exported ${endpoint.method} is not a withApiV1 handler, so its retry contract is unknown`)
      continue
    }
    if (contract.readOnly) continue
    seen.add(key)
    const exemption = exemptions[key]
    if (contract.requireIdempotencyKey && exemption) {
      problems.push(`${key}: requires Idempotency-Key, so drop it from KEY_OPTIONAL_WRITES`)
    }
    if (!contract.requireIdempotencyKey && !exemption) {
      problems.push(
        `${key}: a write that does not require Idempotency-Key. Pass { requireIdempotencyKey: true } to withApiV1 ` +
          '(operations do by default), or list it in KEY_OPTIONAL_WRITES with the reason a keyless repeat cannot write twice.',
      )
    }
    if (!endpoint.path.includes(':companyId') && !contract.handlerIdempotency) {
      problems.push(
        `${key}: no :companyId in the path, so withApiV1 cannot replay Idempotency-Key here. Replay it in the handler ` +
          '(see POST /api/v1/companies) and declare { handlerIdempotency: true }.',
      )
    }
    const mayRepeat = !contract.requireIdempotencyKey && (exemption?.kind === 'outside_books' || exemption?.kind === 'compat')
    if (endpoint.idempotent === mayRepeat) {
      problems.push(
        `${key}: registers idempotent: ${endpoint.idempotent}, but ${mayRepeat ? 'a keyless repeat repeats its side effect' : 'a repeat cannot write twice'}; set idempotent: ${!mayRepeat}`,
      )
    }
    if (exemption && exemption.reason.trim().length < 20) problems.push(`${key}: give KEY_OPTIONAL_WRITES a real reason`)
  }
  for (const key of Object.keys(exemptions)) {
    if (!seen.has(key)) problems.push(`${key}: listed in KEY_OPTIONAL_WRITES but no such v1 write is registered`)
  }
  return problems
}

describe('v1 writes are safe to retry', () => {
  let writes: Array<{ endpoint: EndpointDefinition; contract: V1HandlerContract | undefined }> = []

  beforeAll(async () => {
    const endpoints = listEndpoints().filter((endpoint) => endpoint.method !== 'GET')
    writes = await Promise.all(
      endpoints.map(async (endpoint) => {
        const routeModule = (await import(routeFile(endpoint.path))) as Record<string, unknown>
        return { endpoint, contract: v1HandlerContract(routeModule[endpoint.method]) }
      }),
    )
  })

  it('requires Idempotency-Key on every write, or knows why a repeat cannot write twice', () => {
    expect(retryContractProblems(writes, KEY_OPTIONAL_WRITES)).toEqual([])
  })

  it('sees the whole surface (the check is not vacuous)', () => {
    const required = writes.filter((w) => w.contract?.requireIdempotencyKey)
    expect(writes.length).toBeGreaterThan(150)
    expect(required.length).toBeGreaterThan(120)
  })

  it('honours the key to create a company and lists why it stays optional, the write that made this guard', () => {
    const create = writes.find((w) => keyOf(w.endpoint) === 'POST /api/v1/companies')
    expect(create?.contract).toMatchObject({ requireIdempotencyKey: false, handlerIdempotency: true })
    expect(create?.endpoint.idempotent).toBe(false)
    expect(KEY_OPTIONAL_WRITES['POST /api/v1/companies']?.kind).toBe('compat')
  })

  describe('has teeth', () => {
    const endpoint = (overrides: Partial<EndpointDefinition>) =>
      ({ method: 'POST', path: '/api/v1/companies/:companyId/things', idempotent: true, ...overrides }) as EndpointDefinition
    const contract = (overrides: Partial<V1HandlerContract> = {}): V1HandlerContract => ({
      operation: 'things.create',
      requireIdempotencyKey: false,
      handlerIdempotency: false,
      readOnly: false,
      ...overrides,
    })

    it('fails a new write that neither requires the key nor is listed', () => {
      expect(retryContractProblems([{ endpoint: endpoint({}), contract: contract() }], {})).toEqual([
        expect.stringContaining('does not require Idempotency-Key'),
      ])
    })

    it('fails a company-less write whose handler does not replay the key', () => {
      const problems = retryContractProblems(
        [{ endpoint: endpoint({ path: '/api/v1/things' }), contract: contract({ requireIdempotencyKey: true }) }],
        {},
      )
      expect(problems).toEqual([expect.stringContaining('cannot replay Idempotency-Key')])
    })

    it('fails a stale exemption and an x-idempotent that lies', () => {
      const problems = retryContractProblems(
        [{ endpoint: endpoint({ idempotent: false }), contract: contract({ requireIdempotencyKey: true }) }],
        { 'POST /api/v1/companies/:companyId/gone': { kind: 'idempotent', reason: 'A reason long enough to pass.' } },
      )
      expect(problems).toEqual([
        expect.stringContaining('set idempotent: true'),
        expect.stringContaining('no such v1 write is registered'),
      ])
    })

    it('skips a read that takes a POST body', () => {
      expect(retryContractProblems([{ endpoint: endpoint({}), contract: contract({ readOnly: true }) }], {})).toEqual([])
    })
  })
})
