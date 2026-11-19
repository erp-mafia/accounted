/**
 * Unit tests for commitSubmitVatDeclaration / commitSubmitAgi.
 * Driven through the public commitPendingOperation dispatcher.
 *
 * The MCP submit tools stage submit_vat_declaration / submit_agi ops; this
 * dispatcher resolves the skatteverket extension's commit services via the
 * registry and translates their SkvSubmitResult into the op lifecycle:
 *   - ok                    → committed (signing_url in result_data)
 *   - recoverable failure   → released back to 'pending' (re-approve works)
 *   - non-recoverable / SKV business error → rejected
 *
 * A FAKE extension is registered in the registry so no real SKV/extension
 * code runs: this isolates the core wiring (registry resolution + lifecycle).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { extensionRegistry } from '@/lib/extensions/registry'
import type { Extension } from '@/lib/extensions/types'
import type { SkvSubmitResult } from '@/lib/pending-operations/skatteverket-commit'
import type { PendingOperation } from '@/types'
import { commitPendingOperation } from '../commit'

// The commit-time capability gate (PR: gate paid MCP tools) runs hasCapability
// before the atomic claim for submit_vat_declaration/submit_agi. These tests
// isolate the registry/lifecycle wiring, so make the gate transparent here;
// its enforcement is covered by commit-capability-gate.test.ts.
// The sandbox read in front of a paid operation: an ordinary company here.
vi.mock('@/lib/sandbox/guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/sandbox/guard')>()),
  isSandboxCompany: vi.fn().mockResolvedValue(false),
}))

vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, hasCapability: vi.fn().mockResolvedValue(true) }
})

function makePendingOp(overrides: Partial<PendingOperation>): PendingOperation {
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'submit_vat_declaration',
    status: 'pending',
    title: 'test',
    params: {},
    preview_data: {},
    result_data: null,
    actor_type: 'user',
    actor_id: null,
    actor_label: null,
    risk_level: 'high',
    created_at: '2026-06-01T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  } as PendingOperation
}

function registerFakeSkatteverket(
  services: Record<string, (...a: unknown[]) => Promise<SkvSubmitResult>>,
): void {
  extensionRegistry.register({
    id: 'skatteverket',
    name: 'fake-skatteverket',
    version: '0.0.0',
    services,
  } as unknown as Extension)
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})
afterEach(() => {
  extensionRegistry.clear()
})

describe('commitPendingOperation: submit_vat_declaration / submit_agi', () => {
  it('happy VAT path → committed with signing_url + awaiting_signature status', async () => {
    const vat = vi.fn().mockResolvedValue({
      ok: true, signing_url: 'https://skv.test/sign/abc', redovisningsperiod: '202503',
    })
    registerFakeSkatteverket({ commitSubmitVatDeclaration: vat, commitSubmitAgi: vi.fn() })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null })           // dispatcher commit update

    const op = makePendingOp({ params: { period_type: 'monthly', year: 2025, period: 3 } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ signing_url: 'https://skv.test/sign/abc', status: 'awaiting_signature' })
    expect(vat).toHaveBeenCalledWith(expect.anything(), 'user-1', 'company-1', {
      period_type: 'monthly', year: 2025, period: 3,
    })
  })

  it('happy AGI path → committed with signing_url', async () => {
    const agi = vi.fn().mockResolvedValue({ ok: true, signing_url: 'https://skv.test/agi/xyz', period: '202503' })
    registerFakeSkatteverket({ commitSubmitVatDeclaration: vi.fn(), commitSubmitAgi: agi })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({ data: null, error: null })

    const op = makePendingOp({ operation_type: 'submit_agi', params: { salary_run_id: 'sr-1' } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ signing_url: 'https://skv.test/agi/xyz' })
    expect(agi).toHaveBeenCalledWith(expect.anything(), 'user-1', 'company-1', { salary_run_id: 'sr-1' })
  })

  it('AGI path with a regenerated underlag → the flag and the note reach the approver', async () => {
    const agi = vi.fn().mockResolvedValue({
      ok: true,
      signing_url: 'https://skv.test/agi/xyz',
      period: '202503',
      underlag_regenerated: true,
      note: 'Review it in Mina sidor before signing.',
    })
    registerFakeSkatteverket({ commitSubmitVatDeclaration: vi.fn(), commitSubmitAgi: agi })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({ data: null, error: null })

    const op = makePendingOp({ operation_type: 'submit_agi', params: { salary_run_id: 'sr-1' } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      status: 'awaiting_signature',
      underlag_regenerated: true,
      note: 'Review it in Mina sidor before signing.',
    })
  })

  it('no service registered → failed EXTENSION_DISABLED, op released to pending', async () => {
    // registry is empty (afterEach cleared it; nothing registered here)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null })           // release-to-pending update

    const op = makePendingOp({ params: { period_type: 'monthly', year: 2025, period: 3 } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.code).toBe('EXTENSION_DISABLED')
    expect(result.http_status).toBe(503)
  })

  it('recoverable service result → released to pending with the structured code', async () => {
    const vat = vi.fn().mockResolvedValue({
      ok: false, code: 'SKATTEVERKET_NOT_CONNECTED', http_status: 401, recoverable: true, error: 'no connection',
    })
    registerFakeSkatteverket({ commitSubmitVatDeclaration: vat, commitSubmitAgi: vi.fn() })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({ data: null, error: null }) // release-to-pending update

    const op = makePendingOp({ params: { period_type: 'monthly', year: 2025, period: 3 } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.code).toBe('SKATTEVERKET_NOT_CONNECTED')
    expect(result.http_status).toBe(401)
  })

  it('non-recoverable service result → op rejected (consumed)', async () => {
    const vat = vi.fn().mockResolvedValue({
      ok: false, code: 'SKATTEVERKET_SUBMIT_REJECTED', http_status: 400, recoverable: false, error: 'SKV rejected the draft',
    })
    registerFakeSkatteverket({ commitSubmitVatDeclaration: vat, commitSubmitAgi: vi.fn() })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({ data: null, error: null }) // reject update

    const op = makePendingOp({ params: { period_type: 'monthly', year: 2025, period: 3 } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/rejected/i)
  })

  // The submit chain's completeness verdict refused the books as they are at
  // approval: the op is consumed with the findings, never released.
  it('VAT books incomplete at approval → op rejected (consumed) with the completeness findings', async () => {
    const findings = [{ code: 'RC_BASIS_MISSING', status: 'ERROR', message: 'Basbelopp saknas', rutor: ['ruta21'] }]
    const vat = vi.fn().mockResolvedValue({
      ok: false, code: 'VAT_DECLARATION_INCOMPLETE', http_status: 422, recoverable: false,
      error: 'Momsdeklarationen är ofullständig.', details: { completeness_checks: findings },
    } satisfies SkvSubmitResult)
    registerFakeSkatteverket({ commitSubmitVatDeclaration: vat, commitSubmitAgi: vi.fn() })
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null })           // reject update

    // The params shape every already-staged submit_vat_declaration carries.
    const op = makePendingOp({ params: { period_type: 'monthly', year: 2025, period: 3 } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result).toMatchObject({
      status: 'failed', http_status: 422, code: 'VAT_DECLARATION_INCOMPLETE', operation_status: 'rejected',
      data: { completeness_checks: findings },
    })
    const persisted = findCalls('pending_operations', 'update').at(-1)?.[0] as { result_data: Record<string, unknown> }
    expect(persisted.result_data.error_code).toBe('VAT_DECLARATION_INCOMPLETE')
  })

  it('AGI rejected at kontroll → details carry the kontrollrapport, personnummer masked (agent feedback seq 948847)', async () => {
    // Synthetic personnummer; the employer id (16 + org nr) must survive.
    const PNR = '190001010000'
    const agi = vi.fn().mockResolvedValue({
      ok: false,
      code: 'AGI_KONTROLL_REJECTED',
      http_status: 422,
      recoverable: false,
      error: `Skatteverket avvisade AGI-underlaget vid kontroll: Fel för ${PNR}. Åtgärda felen och generera om AGI:n.`,
      details: {
        kontrollrapport: {
          kontrollresultat_status: 'DONE_REJECTED',
          status: 'FAILED',
          antalFel: 1,
          valideringsfel: [{ felmeddelande: `Ruta 001 saknas för ${PNR} hos 165560000000.` }],
          bearbetningsfel: [],
          redovisningsperioder: [
            {
              period: '202610',
              antalFel: 1,
              antalVarningar: 0,
              kontrollfel: [{ felkategori: 'X', uppgiftsTyp: 'IU', textNyckel: 'k', identifierare: PNR, felmeddelande: 'Fel', felstatus: 'STOPP' }],
            },
          ],
        },
      },
    } satisfies SkvSubmitResult)
    registerFakeSkatteverket({ commitSubmitVatDeclaration: vi.fn(), commitSubmitAgi: agi })
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null })           // reject update

    const op = makePendingOp({ operation_type: 'submit_agi', params: { salary_run_id: 'sr-1' } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(422)
    expect(result.code).toBe('AGI_KONTROLL_REJECTED')
    expect(result.operation_status).toBe('rejected')
    const rapport = (result.data as { kontrollrapport: Record<string, unknown> }).kontrollrapport
    expect(rapport.antalFel).toBe(1)
    expect((rapport.valideringsfel as Array<{ felmeddelande: string }>)[0].felmeddelande).toBe(
      'Ruta 001 saknas för 19000101-XXXX hos 165560000000.',
    )
    const perioder = rapport.redovisningsperioder as Array<{ kontrollfel: Array<{ identifierare: string }> }>
    expect(perioder[0].kontrollfel[0].identifierare).toBe('19000101-XXXX')
    expect(result.error).toContain('19000101-XXXX')
    expect(JSON.stringify(result)).not.toContain(PNR)

    // Persisted on the rejected op too, masked.
    const updates = findCalls('pending_operations', 'update')
    const persisted = updates.at(-1)?.[0] as { result_data: Record<string, unknown> }
    expect(persisted.result_data.error_code).toBe('AGI_KONTROLL_REJECTED')
    expect(persisted.result_data.details).toMatchObject({ kontrollrapport: { antalFel: 1 } })
    expect(JSON.stringify(persisted)).not.toContain(PNR)
  })

  it('recoverable failure → released to pending with any personnummer in the message masked', async () => {
    const agi = vi.fn().mockResolvedValue({
      ok: false, code: 'SKATTEVERKET_PROCESSING', http_status: 202, recoverable: true,
      error: 'Skatteverket bearbetar fortfarande underlaget för 190001010000 och 000101-0000.',
    } satisfies SkvSubmitResult)
    registerFakeSkatteverket({ commitSubmitVatDeclaration: vi.fn(), commitSubmitAgi: agi })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null })           // release-to-pending update

    const op = makePendingOp({ operation_type: 'submit_agi', params: { salary_run_id: 'sr-1' } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.code).toBe('SKATTEVERKET_PROCESSING')
    expect(result.error).toBe('Skatteverket bearbetar fortfarande underlaget för 19000101-XXXX och 000101-XXXX.')
  })

  it('missing params → 400 without resolving the extension service', async () => {
    const vat = vi.fn()
    registerFakeSkatteverket({ commitSubmitVatDeclaration: vat, commitSubmitAgi: vi.fn() })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({ data: null, error: null }) // reject update

    const op = makePendingOp({ params: { year: 2025 } }) // missing period_type + period
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(vat).not.toHaveBeenCalled()
  })
})
