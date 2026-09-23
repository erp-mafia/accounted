/**
 * Response-envelope contract test.
 *
 * Every v1 handler returns the canonical `{ data, meta }` envelope: `ok()` and
 * `created()` wrap a single object, `paginated()` wraps an array, both stamping
 * the shared `meta` block (see `lib/api/v1/response.ts`). The OpenAPI generator,
 * however, derives each endpoint's documented body purely from its registered
 * `response.success` Zod schema, and that schema is NOT validated at runtime:
 * so nothing stops a route from declaring a shape the handler never sends.
 *
 * That is exactly what issue #794 found: every list endpoint declared a bare
 * `{ <name>: [...] }` object that no handler emits. #802 fixed the list
 * endpoints (via `listEnvelope`/`dataEnvelope`); the same drift was latent on
 * the single-resource and write endpoints, which declared the bare resource
 * schema instead of `{ data, meta }`.
 *
 * This test is the regression guard the issue asked for. It asserts EVERY
 * JSON-returning endpoint declares the `{ data, meta }` envelope with the shared
 * `ResponseMetaSchema`: so a new endpoint that forgets to wrap its schema
 * (list OR single) fails CI here instead of shipping a lying spec. Binary
 * downloads (`response.contentType`) and 204 No Content endpoints
 * (`NoBodyResponse`) carry no JSON body and are the only exemptions.
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { listEndpoints, ResponseMetaSchema, NoBodyResponse, listEnvelope, dataEnvelope } from '../registry'
// Side-effect import: every route file's registerEndpoint() runs at module
// load time and populates the shared ENDPOINTS map.
import '../load-routes'

/** Binary downloads (PDF, SIE text) declare a non-JSON contentType. */
function isBinary(success: { contentType?: string }): boolean {
  return !!success.contentType && success.contentType !== 'application/json'
}

describe('v1 response envelope contract', () => {
  const endpoints = listEndpoints()

  it('every JSON endpoint declares the { data, meta } envelope with the shared meta schema', () => {
    // Accumulate every violation so a failing run names ALL offending endpoints
    // at once (a fresh route that forgets to wrap, plus any that drift later),
    // instead of failing one-at-a-time across many edit cycles.
    const violations: string[] = []

    for (const ep of endpoints) {
      const ctx = `${ep.method} ${ep.path} (${ep.operation})`

      // Exemptions: binary bodies and 204-no-content have no JSON envelope.
      if (isBinary(ep.response)) continue
      if (ep.response.success === NoBodyResponse) continue

      const success = ep.response.success
      if (!(success instanceof z.ZodObject)) {
        violations.push(`${ctx}: response.success is not a { data, meta } object: wrap it with listEnvelope()/dataEnvelope() (or use NoBodyResponse for 204 / response.contentType for binary).`)
        continue
      }

      const shape = (success as z.ZodObject<z.ZodRawShape>).shape
      const keys = Object.keys(shape).sort()
      if (keys.length !== 2 || keys[0] !== 'data' || keys[1] !== 'meta') {
        violations.push(`${ctx}: top-level keys must be [data, meta]: found [${keys.join(', ')}]. The handler returns { data, meta }; declare it with listEnvelope()/dataEnvelope().`)
        continue
      }

      // Reference equality: both envelope helpers wire in this exact schema, so
      // a hand-rolled `{ data, meta: z.object({...}) }` that drifts from the
      // real meta block is rejected too.
      if (shape.meta !== ResponseMetaSchema) {
        violations.push(`${ctx}: meta is not the shared ResponseMetaSchema (use listEnvelope()/dataEnvelope(), don't hand-roll the envelope).`)
      }
    }

    expect(
      violations,
      `\n${violations.length} v1 endpoint(s) declare a response.success that doesn't match the { data, meta } envelope the handler actually returns:\n\n${violations.map((v) => `  • ${v}`).join('\n')}\n`,
    ).toEqual([])
  })

  it('list endpoints expose data as an array (the paginated() envelope)', () => {
    // Detect list endpoints structurally: their `data` is a Zod array. This is
    // the half of the contract that maps onto paginated() specifically: guards
    // against a list endpoint drifting from `{ data: [...] }` back to a bare
    // `{ <name>: [...] }` (which would drop the array out of `data` entirely).
    const arrayDataEndpoints = endpoints.filter((ep) => {
      const s = ep.response.success
      return s instanceof z.ZodObject && (s as z.ZodObject<z.ZodRawShape>).shape.data instanceof z.ZodArray
    })

    // The 10 cursor-paginated list endpoints (companies, customers, suppliers,
    // invoices, supplier-invoices, journal-entries, transactions, employees,
    // salary-runs, webhook deliveries). accounts/fiscal-periods/webhooks nest
    // their array under a named key inside `data`, so they use dataEnvelope and
    // are intentionally NOT counted here. A drop below this floor means a
    // paginated endpoint silently lost its `data: [...]` shape.
    expect(
      arrayDataEndpoints.length,
      `expected the known paginated list endpoints to keep data: z.array(...); found only ${arrayDataEndpoints.length}`,
    ).toBeGreaterThanOrEqual(10)

    for (const ep of arrayDataEndpoints) {
      const shape = (ep.response.success as z.ZodObject<z.ZodRawShape>).shape
      expect(
        shape.meta === ResponseMetaSchema,
        `${ep.method} ${ep.path}: list envelope meta must be the shared ResponseMetaSchema`,
      ).toBe(true)
    }
  })

  it('listEnvelope() and dataEnvelope() produce the canonical { data, meta } shape', () => {
    const list = listEnvelope(z.object({ id: z.string() }))
    expect(list instanceof z.ZodObject).toBe(true)
    expect(Object.keys(list.shape).sort()).toEqual(['data', 'meta'])
    expect(list.shape.data instanceof z.ZodArray).toBe(true)
    expect(list.shape.meta === ResponseMetaSchema).toBe(true)

    const data = dataEnvelope(z.object({ id: z.string() }))
    expect(data instanceof z.ZodObject).toBe(true)
    expect(Object.keys(data.shape).sort()).toEqual(['data', 'meta'])
    expect(data.shape.data instanceof z.ZodObject).toBe(true)
    expect(data.shape.meta === ResponseMetaSchema).toBe(true)
  })

  it('the shared meta schema carries request_id + api_version', () => {
    // The envelope helpers are only correct if meta itself is well-formed.
    expect(ResponseMetaSchema instanceof z.ZodObject).toBe(true)
    const metaKeys = Object.keys(ResponseMetaSchema.shape)
    expect(metaKeys).toContain('request_id')
    expect(metaKeys).toContain('api_version')
  })
})
