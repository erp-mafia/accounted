/**
 * The dashboard's budget doors (accounted#134, part 2), the /budget page's
 * API: list and create, update and delete, the grid, its save, spread, copy
 * actuals and the file import. The rules are the service's
 * (lib/budgets/service.ts, lib/import/budget/import-budget.ts, tested there
 * and through the v1 doors); these pin auth, validation, the budget id taken
 * from the path, the dry run, and how a refusal reaches the page.
 */
import { NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRequest, createTableMockSupabase } from '@/tests/helpers'

const mock = createTableMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))
vi.mock('@/lib/budgets/service', () => ({
  listBudgets: vi.fn(),
  createBudget: vi.fn(),
  updateBudget: vi.fn(),
  deleteBudget: vi.fn(),
  budgetGrid: vi.fn(),
  upsertBudgetLines: vi.fn(),
  spreadBudget: vi.fn(),
  copyActualsToBudget: vi.fn(),
}))
vi.mock('@/lib/import/budget/import-budget', () => ({ importBudgetFile: vi.fn() }))

import {
  budgetGrid,
  copyActualsToBudget,
  createBudget,
  deleteBudget,
  listBudgets,
  spreadBudget,
  updateBudget,
  upsertBudgetLines,
} from '@/lib/budgets/service'
import { importBudgetFile } from '@/lib/import/budget/import-budget'
import { GET as LIST, POST as CREATE } from '../route'
import { PATCH, DELETE } from '../[id]/route'
import { GET as GRID } from '../[id]/grid/route'
import { POST as LINES } from '../[id]/lines/route'
import { POST as SPREAD } from '../[id]/spread/route'
import { POST as COPY } from '../[id]/copy-actuals/route'
import { POST as IMPORT } from '../[id]/import/route'
import { POST as IMPORT_PREVIEW } from '../[id]/import/preview/route'

const BUDGET_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const PERIOD_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const noParams = { params: Promise.resolve({}) }
const idParams = (id = BUDGET_ID) => ({ params: Promise.resolve({ id }) })
const notFound = { ok: false as const, code: 'BUDGET_NOT_FOUND', details: { budget_id: BUDGET_ID } }
const counts = { budget_id: BUDGET_ID, inserted: 2, updated: 0, deleted: 0, unchanged: 0 }

function importRequest(fields: Record<string, string | File>, query = '') {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  return new Request(`http://localhost:3000/api/budgets/${BUDGET_ID}/import${query}`, { method: 'POST', body: form })
}

beforeEach(() => {
  vi.clearAllMocks()
  mock.reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: mock.supabase })
  requireWriteMock.mockResolvedValue({ ok: true })
})

describe('401 before anything is read or written', () => {
  it.each([
    ['GET /api/budgets', () => LIST(createMockRequest('/api/budgets'), noParams)],
    ['POST /api/budgets', () => CREATE(createMockRequest('/api/budgets', { method: 'POST', body: { fiscal_period_id: PERIOD_ID, name: 'B' } }), noParams)],
    ['PATCH /api/budgets/:id', () => PATCH(createMockRequest(`/api/budgets/${BUDGET_ID}`, { method: 'PATCH', body: { is_default: true } }), idParams())],
    ['DELETE /api/budgets/:id', () => DELETE(createMockRequest(`/api/budgets/${BUDGET_ID}`, { method: 'DELETE' }), idParams())],
    ['GET /api/budgets/:id/grid', () => GRID(createMockRequest(`/api/budgets/${BUDGET_ID}/grid`), idParams())],
    ['POST /api/budgets/:id/lines', () => LINES(createMockRequest(`/api/budgets/${BUDGET_ID}/lines`, { method: 'POST', body: { lines: [] } }), idParams())],
    ['POST /api/budgets/:id/spread', () => SPREAD(createMockRequest(`/api/budgets/${BUDGET_ID}/spread`, { method: 'POST', body: {} }), idParams())],
    ['POST /api/budgets/:id/copy-actuals', () => COPY(createMockRequest(`/api/budgets/${BUDGET_ID}/copy-actuals`, { method: 'POST', body: {} }), idParams())],
    ['POST /api/budgets/:id/import', () => IMPORT(importRequest({}), idParams())],
    ['POST /api/budgets/:id/import/preview', () => IMPORT_PREVIEW(importRequest({}), idParams())],
  ])('%s', async (_name, call) => {
    requireAuthMock.mockResolvedValue({ error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    const res = await call()
    expect(res.status).toBe(401)
    for (const fn of [listBudgets, createBudget, updateBudget, deleteBudget, budgetGrid, upsertBudgetLines, spreadBudget, copyActualsToBudget, importBudgetFile]) {
      expect(fn).not.toHaveBeenCalled()
    }
  })
})

describe('GET and POST /api/budgets', () => {
  it('lists the year\'s budgets for the company', async () => {
    vi.mocked(listBudgets).mockResolvedValue({ ok: true, data: { budgets: [] } })
    const res = await LIST(createMockRequest('/api/budgets', { searchParams: { fiscal_period_id: PERIOD_ID } }), noParams)
    expect(res.status).toBe(200)
    expect(vi.mocked(listBudgets).mock.calls[0]![0]).toMatchObject({ companyId: 'company-1', userId: 'user-1' })
    expect(vi.mocked(listBudgets).mock.calls[0]![1]).toEqual({ fiscal_period_id: PERIOD_ID })
  })

  it('400 for a fiscal year that is not an id, and for a create without a name', async () => {
    expect((await LIST(createMockRequest('/api/budgets', { searchParams: { fiscal_period_id: '2027' } }), noParams)).status).toBe(400)
    const res = await CREATE(createMockRequest('/api/budgets', { method: 'POST', body: { fiscal_period_id: PERIOD_ID } }), noParams)
    expect(res.status).toBe(400)
    expect(createBudget).not.toHaveBeenCalled()
  })

  it('201 creates; a taken name answers 409 with its code', async () => {
    vi.mocked(createBudget).mockResolvedValueOnce({ ok: true, data: { budget: { budget_id: BUDGET_ID } as never } })
    const created = await CREATE(createMockRequest('/api/budgets', { method: 'POST', body: { fiscal_period_id: PERIOD_ID, name: 'Budget 2027' } }), noParams)
    expect(created.status).toBe(201)

    vi.mocked(createBudget).mockResolvedValueOnce({ ok: false, code: 'BUDGET_NAME_TAKEN', details: { name: 'Budget 2027' } })
    const taken = await CREATE(createMockRequest('/api/budgets', { method: 'POST', body: { fiscal_period_id: PERIOD_ID, name: 'Budget 2027' } }), noParams)
    expect(taken.status).toBe(409)
    expect((await taken.json()).error.code).toBe('BUDGET_NAME_TAKEN')
  })
})

describe('PATCH and DELETE /api/budgets/:id', () => {
  it('sets the default with the id from the path', async () => {
    vi.mocked(updateBudget).mockResolvedValue({ ok: true, data: { budget: { budget_id: BUDGET_ID } as never } })
    const res = await PATCH(createMockRequest(`/api/budgets/${BUDGET_ID}`, { method: 'PATCH', body: { is_default: true, budget_id: 'ignored' } }), idParams())
    expect(res.status).toBe(200)
    expect(vi.mocked(updateBudget).mock.calls[0]![1]).toEqual({ budget_id: BUDGET_ID, is_default: true })
  })

  it('400 for an empty patch, 404 for an unknown or malformed id', async () => {
    expect((await PATCH(createMockRequest(`/api/budgets/${BUDGET_ID}`, { method: 'PATCH', body: {} }), idParams())).status).toBe(400)
    expect((await DELETE(createMockRequest('/api/budgets/x', { method: 'DELETE' }), idParams('x'))).status).toBe(404)
    vi.mocked(deleteBudget).mockResolvedValue(notFound)
    const res = await DELETE(createMockRequest(`/api/budgets/${BUDGET_ID}`, { method: 'DELETE' }), idParams())
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('BUDGET_NOT_FOUND')
  })

  it('deletes', async () => {
    vi.mocked(deleteBudget).mockResolvedValue({ ok: true, data: { deleted: true, budget_id: BUDGET_ID } })
    const res = await DELETE(createMockRequest(`/api/budgets/${BUDGET_ID}`, { method: 'DELETE' }), idParams())
    expect(res.status).toBe(200)
    expect(vi.mocked(deleteBudget).mock.calls[0]![1]).toBe(BUDGET_ID)
  })
})

describe('GET /api/budgets/:id/grid', () => {
  it('passes the view; 400 for half a tag; 404 for an unknown budget', async () => {
    vi.mocked(budgetGrid).mockResolvedValueOnce({ ok: true, data: { rows: [] } as never })
    const ok = await GRID(createMockRequest(`/api/budgets/${BUDGET_ID}/grid`, { searchParams: { dim_no: '6', dim_code: 'H1' } }), idParams())
    expect(ok.status).toBe(200)
    expect(vi.mocked(budgetGrid).mock.calls[0]![1]).toEqual({ budget_id: BUDGET_ID, dim_no: '6', dim_code: 'H1' })

    expect((await GRID(createMockRequest(`/api/budgets/${BUDGET_ID}/grid`, { searchParams: { dim_no: '6' } }), idParams())).status).toBe(400)

    vi.mocked(budgetGrid).mockResolvedValueOnce(notFound)
    expect((await GRID(createMockRequest(`/api/budgets/${BUDGET_ID}/grid`), idParams())).status).toBe(404)
  })
})

describe('POST /api/budgets/:id/lines, /spread, /copy-actuals', () => {
  it('saves the grid\'s changed cells', async () => {
    vi.mocked(upsertBudgetLines).mockResolvedValue({ ok: true, data: counts })
    const lines = [{ account_number: '3010', month: '2027-01', amount: -1000 }]
    const res = await LINES(createMockRequest(`/api/budgets/${BUDGET_ID}/lines`, { method: 'POST', body: { lines } }), idParams())
    expect(res.status).toBe(200)
    expect(vi.mocked(upsertBudgetLines).mock.calls[0]![1]).toEqual({ budget_id: BUDGET_ID, lines })
  })

  it('400 for a balance account, a number as account, or a bad month', async () => {
    for (const line of [
      { account_number: '1930', month: '2027-01', amount: 1 },
      { account_number: 3010, month: '2027-01', amount: 1 },
      { account_number: '3010', month: '2027-13', amount: 1 },
    ]) {
      const res = await LINES(createMockRequest(`/api/budgets/${BUDGET_ID}/lines`, { method: 'POST', body: { lines: [line] } }), idParams())
      expect(res.status).toBe(400)
    }
    expect(upsertBudgetLines).not.toHaveBeenCalled()
  })

  it('spreads and copies, dry run on ?dry_run=true', async () => {
    vi.mocked(spreadBudget).mockResolvedValue({ ok: true, dryRun: true, preview: { months: [] } })
    const spread = await SPREAD(
      createMockRequest(`/api/budgets/${BUDGET_ID}/spread`, { method: 'POST', body: { account_number: '3010', amount: -12000 }, searchParams: { dry_run: 'true' } }),
      idParams(),
    )
    expect(spread.status).toBe(200)
    expect(vi.mocked(spreadBudget).mock.calls[0]![2]).toEqual({ dryRun: true })

    vi.mocked(copyActualsToBudget).mockResolvedValue({ ok: false, code: 'BUDGET_SOURCE_YEAR_NOT_FOUND', details: {} })
    const copy = await COPY(createMockRequest(`/api/budgets/${BUDGET_ID}/copy-actuals`, { method: 'POST', body: { percent_change: 5 } }), idParams())
    expect(copy.status).toBe(404)
    expect(vi.mocked(copyActualsToBudget).mock.calls[0]![1]).toEqual({ budget_id: BUDGET_ID, percent_change: 5 })
    expect(vi.mocked(copyActualsToBudget).mock.calls[0]![2]).toEqual({ dryRun: false })
  })
})

describe('POST /api/budgets/:id/import', () => {
  const file = () => new File(['#PBUDGET 0 202701 3010 {} -1000\n'], 'fortnox.se')

  it('400 without a file or with an unknown sign', async () => {
    expect((await IMPORT(importRequest({ replace: 'true' }), idParams())).status).toBe(400)
    expect((await IMPORT(importRequest({ file: file(), sign: 'upside_down' }), idParams())).status).toBe(400)
    expect(importBudgetFile).not.toHaveBeenCalled()
  })

  it('404 for a malformed id and for the service\'s unknown budget', async () => {
    expect((await IMPORT(importRequest({ file: file() }), idParams('nope'))).status).toBe(404)
    vi.mocked(importBudgetFile).mockResolvedValue(notFound)
    expect((await IMPORT(importRequest({ file: file() }), idParams())).status).toBe(404)
  })

  it('previews with the file, the sign and replace through /preview, and imports through the door itself', async () => {
    vi.mocked(importBudgetFile).mockResolvedValue({ ok: true, dryRun: true, preview: { cells: 1 } as never })
    const res = await IMPORT_PREVIEW(importRequest({ file: file(), sign: 'revenue_positive', replace: 'true' }), idParams())
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ cells: 1 })
    const [, input, options] = vi.mocked(importBudgetFile).mock.calls[0]!
    expect(input).toMatchObject({ budget_id: BUDGET_ID, filename: 'fortnox.se', sign: 'revenue_positive', replace: true })
    expect(input.bytes.byteLength).toBeGreaterThan(0)
    expect(options).toEqual({ dryRun: true })

    vi.mocked(importBudgetFile).mockResolvedValue({ ok: true, data: { cells: 1 } as never })
    const saved = await IMPORT(importRequest({ file: file() }), idParams())
    expect(saved.status).toBe(200)
    expect(vi.mocked(importBudgetFile).mock.calls[1]![2]).toEqual({ dryRun: false })
  })
})
