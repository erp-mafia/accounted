/**
 * Spec-snapshot test.
 *
 * Locks down the high-level shape of the v1 endpoint registry so an
 * unintentional Zod-schema change can't ship a silent API break. CI fails
 * if any of the following invariants drift unexpectedly:
 *
 *   - Endpoint count
 *   - Endpoint key set (method + path tuples)
 *   - Set of distinct scopes referenced across all endpoints
 *
 * When you intentionally add or remove an endpoint, run the test once
 * locally with `--update` to refresh the snapshot, review the diff, and
 * commit the new snapshot alongside the route change. The diff itself
 * becomes a self-describing API changelog entry.
 *
 * Why this lives here and not in tests/: the snapshot must be loaded
 * relative to a path the load-routes side-effect import resolves from.
 * Co-locating with the registry keeps the dependency cycle minimal.
 */

import { describe, expect, it } from 'vitest'
import { listEndpoints } from '../registry'
// Side-effect import: every route file's registerEndpoint() runs at
// module load time and populates the shared ENDPOINTS map.
import '../load-routes'

describe('v1 spec snapshot', () => {
  const endpoints = listEndpoints()

  it('matches the recorded endpoint count', () => {
    // Update intentionally when adding/removing endpoints. The count is
    // the cheapest first-line check: if it changes unexpectedly, CI
    // surfaces the surprise before reviewers have to spot it in the diff.
    expect(endpoints.length).toMatchSnapshot('endpoint-count')
  })

  it('matches the recorded endpoint key set', () => {
    const keys = endpoints
      .map((e) => `${e.method} ${e.path}`)
      .sort()
    expect(keys).toMatchSnapshot('endpoint-keys')
  })

  it('matches the recorded scope catalogue', () => {
    const scopes = Array.from(
      new Set(endpoints.map((e) => e.scope ?? 'public')),
    ).sort()
    expect(scopes).toMatchSnapshot('endpoint-scopes')
  })

  it('every endpoint has the agent-facing metadata that the docs depend on', () => {
    // The /docs/api/reference pages and /llms-full.txt aggregator both
    // assume every endpoint registers complete metadata. A registerEndpoint
    // call that omits any of these fields would render a page with empty
    // sections: surface the omission here instead.
    for (const ep of endpoints) {
      const ctx = `${ep.method} ${ep.path}`
      expect(ep.summary, `${ctx}: missing summary`).toBeTruthy()
      expect(ep.description, `${ctx}: missing description`).toBeTruthy()
      expect(ep.useWhen, `${ctx}: missing useWhen`).toBeTruthy()
      expect(ep.doNotUseFor, `${ctx}: missing doNotUseFor`).toBeTruthy()
      expect(Array.isArray(ep.pitfalls), `${ctx}: pitfalls must be an array`).toBe(true)
      expect(ep.example, `${ctx}: missing example`).toBeTruthy()
      expect(ep.example.response, `${ctx}: example.response is required`).toBeTruthy()

      // Defense-in-depth: every endpoint MUST explicitly declare its
      // scope (or the literal sentinel `null` for genuinely public
      // endpoints: e.g. /api/v1/health). `undefined` means the
      // registerEndpoint call silently dropped the field, which would
      // make the wrapper treat the route as unauthenticated. CC6.3:
      // surfacing the omission in CI prevents accidental public
      // exposure of new endpoints.
      expect(
        ep.scope !== undefined,
        `${ctx}: scope must be explicitly declared (use null for genuinely public endpoints)`,
      ).toBe(true)
    }
  })
})
