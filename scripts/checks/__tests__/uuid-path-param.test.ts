/**
 * Proof that the uuid-path-param guard catches a session route that hands an
 * id segment to the database unchecked, judges each segment and each wrapper
 * call, accepts the ways routes check a segment by hand, catches a declared
 * name the path lacks, and that the repository holds no such route outside
 * the shrinking allowlist.
 */
import { describe, it, expect } from 'vitest'
import path from 'node:path'
import {
  findMisdeclaredUuidParams,
  findUndeclaredUuidPathParams,
  isUndeclaredUuidPathParam as flagged,
  misdeclaredUuidParamsInSource as misdeclared,
  NOT_A_UUID,
  UUID_PATH_PARAM_ALLOWED,
} from '../uuid-path-param.mjs'

const ROUTE = 'app/api/assets/[id]/route.ts'
const TWO = 'app/api/salary/runs/[id]/employees/[employeeId]/route.ts'
const IMPORT = `import { withRouteContext } from '@/lib/api/with-route-context'\n`
/** One exported handler, as a route file writes it: `options` is the wrapper's third argument. */
const handler = (method: string, body = '', options = '') =>
  `export const ${method} = withRouteContext('op.${method}', async (_r, ctx, { params }) => {\n${body}\n}${options ? `, ${options}` : ''})\n`
const file = (...handlers: string[]) => IMPORT + handlers.join('')

describe('uuid-path-param: a route on the option', () => {
  it('passes when every call declares every id segment', () => {
    expect(flagged(ROUTE, file(handler('GET', '', `{ uuidParams: { id: 'ASSET_NOT_FOUND' } }`)))).toBe(false)
    const both = `{ requireWrite: true, uuidParams: { id: 'A', employeeId: 'B' } }`
    expect(flagged(TWO, file(handler('GET', '', both), handler('DELETE', '', both)))).toBe(false)
  })

  it('flags a call without the option next to one that has it', () => {
    const declared = handler('GET', '', `{ uuidParams: { id: 'ASSET_NOT_FOUND' } }`)
    expect(flagged(ROUTE, file(declared, handler('DELETE', '', '{ requireWrite: true }')))).toBe(true)
  })

  it('flags a declaration that leaves an id segment out', () => {
    expect(flagged(TWO, file(handler('GET', '', `{ uuidParams: { id: 'SALARY_RUN_NOT_FOUND' } }`)))).toBe(true)
  })
})

describe('uuid-path-param: a route checking by hand, before the option', () => {
  it('flags a session route whose id segment reaches the handler unchecked', () => {
    expect(flagged(ROUTE, file(handler('GET', 'const { id } = await params')))).toBe(true)
    expect(flagged(TWO, file(handler('GET')))).toBe(true)
  })

  it('accepts the checks routes wrote by hand', () => {
    for (const body of [
      'if (!isUuid(id)) return notFound()',
      'if (!UUID_RE.test(id)) return notFound()',
      'const parsed = z.object({ id: z.uuid() }).safeParse(await params)',
      'const parsed = z.object({ id: z.string().uuid() }).safeParse(await params)',
      'const id = z.uuid().parse((await params).id)',
      'const { id: runId } = await params\nif (!isUuid(runId)) return notFound()',
    ]) {
      expect(flagged(ROUTE, file(handler('GET', body))), body).toBe(false)
    }
    const named = `const RunId = z.string().uuid()\n` + handler('GET', 'if (!RunId.safeParse(id).success) return notFound()')
    expect(flagged(ROUTE, IMPORT + named)).toBe(false)
  })

  it('does not count a uuid check of a body or query field, or of another segment', () => {
    expect(flagged(ROUTE, file(handler('PATCH', 'const Body = z.object({ company_ids: z.array(z.string().uuid()) })')))).toBe(true)
    expect(flagged(ROUTE, file(handler('POST', 'if (!isUuid(body.invoice_id)) return bad()')))).toBe(true)
    expect(flagged(TWO, file(handler('GET', 'if (!isUuid(id)) return notFound()')))).toBe(true)
  })

  it('does not count a check named only in a comment', () => {
    expect(flagged(ROUTE, file(handler('GET', '// isUuid(id) is checked by the service')))).toBe(true)
  })
})

describe('uuid-path-param: what it leaves alone', () => {
  it('leaves alone a segment that is not named like an id, and a route without one', () => {
    expect(flagged('app/api/reports/trial-balance/account/[accountNumber]/sources/route.ts', file(handler('GET')))).toBe(false)
    expect(flagged('app/api/bolaget/owner-tax/k10/[year]/route.ts', file(handler('GET')))).toBe(false)
    expect(flagged('app/api/assets/route.ts', file(handler('GET')))).toBe(false)
  })

  it('leaves v1 (its wrapper checks typed path ids) and routes outside the session wrapper alone', () => {
    expect(flagged('app/api/v1/companies/[companyId]/assets/[id]/route.ts', file(handler('GET')))).toBe(false)
    expect(flagged('app/api/attest/[token]/[id]/route.ts', `export async function GET() {}`)).toBe(false)
  })

  it('leaves alone a route whose id-named segment holds something else, with its reason', () => {
    for (const [route, reason] of Object.entries(NOT_A_UUID)) {
      expect(reason).toBeTruthy()
      expect(flagged(route, file(handler('POST')))).toBe(false)
    }
  })
})

describe('uuid-path-param: a declared name the path lacks', () => {
  it('names a uuidParams key that is none of the route path segments, quoted or not', () => {
    expect(misdeclared(ROUTE, file(handler('GET', '', `{ uuidParams: { idd: 'ASSET_NOT_FOUND' } }`)))).toEqual(['idd'])
    expect(misdeclared(ROUTE, file(handler('GET', '', `{ uuidParams: { 'idd': 'ASSET_NOT_FOUND' } }`)))).toEqual(['idd'])
    const line = `{ requireWrite: true, uuidParams: { id: 'SALARY_RUN_NOT_FOUND', line: 'SALARY_LINE_NOT_FOUND' } }`
    expect(misdeclared('app/api/salary/runs/[id]/lines/[lineId]/route.ts', file(handler('PATCH', '', line)))).toEqual(['line'])
  })

  it('accepts names the path spells, on every call in the file', () => {
    const source = file(
      handler('GET', '', `{ uuidParams: { id: 'A', componentId: 'B' } }`),
      handler('PATCH', '', `{ requireWrite: true, uuidParams: { id: 'A', componentId: 'B' } }`),
    )
    expect(misdeclared('app/api/assets/[id]/components/[componentId]/route.ts', source)).toEqual([])
    expect(misdeclared(ROUTE, file(handler('GET')))).toEqual([])
  })
})

describe('uuid-path-param: the repository', () => {
  const sourceRoot = path.resolve(__dirname, '..', '..', '..', 'src')

  it('has no unchecked id route outside the allowlist', () => {
    expect(findUndeclaredUuidPathParams(sourceRoot).filter((f: string) => !UUID_PATH_PARAM_ALLOWED.has(f))).toEqual([])
  })

  it('declares no name a route path lacks', () => {
    expect(findMisdeclaredUuidParams(sourceRoot)).toEqual([])
  })
})
