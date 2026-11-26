/**
 * Proof that the uuid-path-param guard catches a session route that hands an
 * id segment to the database unchecked, accepts every way a route checks it,
 * catches a declared name the path lacks, and that the repository holds no
 * such route outside the shrinking allowlist.
 */
import { describe, it, expect } from 'vitest'
import path from 'node:path'
import {
  findMisdeclaredUuidParams,
  findUndeclaredUuidPathParams,
  isUndeclaredUuidPathParam as flagged,
  misdeclaredUuidParamsInSource as misdeclared,
  UUID_PATH_PARAM_ALLOWED,
} from '../uuid-path-param.mjs'

const ROUTE = 'app/api/assets/[id]/route.ts'
const session = (body: string) =>
  `import { withRouteContext } from '@/lib/api/with-route-context'\n` +
  `export const GET = withRouteContext('assets.get', async (_r, ctx, { params }) => {\n${body}\n})`

describe('uuid-path-param: a route file', () => {
  it('flags a session route whose id segment reaches the handler unchecked', () => {
    expect(flagged(ROUTE, session(`const { id } = await params`))).toBe(true)
    expect(flagged('app/api/salary/runs/[id]/employees/[employeeId]/route.ts', session(''))).toBe(true)
  })

  it('accepts the wrapper option and the checks routes wrote before it', () => {
    expect(flagged(ROUTE, session('') + `, { uuidParams: { id: 'ASSET_NOT_FOUND' } })`)).toBe(false)
    expect(flagged(ROUTE, session(`if (!isUuid(id)) return notFound()`))).toBe(false)
    expect(flagged(ROUTE, session(`const ParamsSchema = z.object({ id: z.uuid() })`))).toBe(false)
    expect(flagged(ROUTE, session(`const ParamsSchema = z.object({ id: z.string().uuid() })`))).toBe(false)
  })

  it('leaves alone a segment that is not named like an id', () => {
    expect(flagged('app/api/reports/trial-balance/account/[accountNumber]/sources/route.ts', session(''))).toBe(false)
    expect(flagged('app/api/bolaget/owner-tax/k10/[year]/route.ts', session(''))).toBe(false)
    expect(flagged('app/api/assets/route.ts', session(''))).toBe(false)
  })

  it('leaves v1 (its wrapper checks typed path ids) and routes outside the session wrapper alone', () => {
    expect(flagged('app/api/v1/companies/[companyId]/assets/[id]/route.ts', session(''))).toBe(false)
    expect(flagged('app/api/attest/[token]/[id]/route.ts', `export async function GET() {}`)).toBe(false)
  })
})

describe('uuid-path-param: the repository', () => {
  const findings = findUndeclaredUuidPathParams(path.resolve(__dirname, '..', '..', '..', 'src'))

  it('has no unchecked id route outside the allowlist', () => {
    expect(findings.filter((f: string) => !UUID_PATH_PARAM_ALLOWED.has(f))).toEqual([])
  })
})

describe('uuid-path-param: a declared name the path lacks', () => {
  it('names a uuidParams key that is none of the route path segments', () => {
    expect(misdeclared(ROUTE, `{ uuidParams: { idd: 'ASSET_NOT_FOUND' } }`)).toEqual(['idd'])
    expect(
      misdeclared(
        'app/api/salary/runs/[id]/lines/[lineId]/route.ts',
        `{ requireWrite: true, uuidParams: { id: 'SALARY_RUN_NOT_FOUND', line: 'SALARY_LINE_NOT_FOUND' } }`,
      ),
    ).toEqual(['line'])
  })

  it('accepts names the path spells, on every call in the file', () => {
    const source = `GET, { uuidParams: { id: 'A', componentId: 'B' } }\nPATCH, { requireWrite: true, uuidParams: { id: 'A' } }`
    expect(misdeclared('app/api/assets/[id]/components/[componentId]/route.ts', source)).toEqual([])
    expect(misdeclared(ROUTE, `withRouteContext('assets.get', handler)`)).toEqual([])
  })

  it('finds none in the repository', () => {
    expect(findMisdeclaredUuidParams(path.resolve(__dirname, '..', '..', '..', 'src'))).toEqual([])
  })
})
