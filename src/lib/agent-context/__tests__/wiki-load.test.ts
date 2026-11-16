import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const getMock = vi.fn()
vi.mock('@/lib/agent/tools/registry', () => ({
  agentToolRegistry: { get: (...args: unknown[]) => getMock(...args) },
}))
const brainMock = vi.fn()
vi.mock('@/lib/arkiv/flag', () => ({
  isArkivBrainEnabled: (...args: unknown[]) => brainMock(...args),
}))

import { BRIEFING_TOOL, RECORD_TOOL, loadAgentContext, loadWikiRecord } from '../wiki-load'
import { DEFAULT_OAUTH_SCOPES } from '@/lib/auth/scope-catalog'

const supabase = {} as SupabaseClient
const ID = '11111111-1111-4111-8111-111111111111'

beforeEach(() => {
  vi.clearAllMocks()
  brainMock.mockReturnValue(false)
})

describe('loadAgentContext', () => {
  it('runs the briefing tool itself, with the connector default scopes, and describes its answer', async () => {
    const briefing = { company: { company_id: 'c1', name: 'Bolaget' }, memory: [], atoms: [] }
    const execute = vi.fn().mockResolvedValue(briefing)
    getMock.mockResolvedValue({ name: BRIEFING_TOOL, execute })
    const result = await loadAgentContext(supabase, 'c1', 'u1')
    expect(getMock).toHaveBeenCalledWith(BRIEFING_TOOL)
    expect(execute).toHaveBeenCalledWith({ __keyScopes: [...DEFAULT_OAUTH_SCOPES] }, 'c1', 'u1', supabase, { type: 'user', id: 'u1' })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.text).toBe(JSON.stringify(briefing, null, 2))
    expect(result.window.scope.company.name).toBe('Bolaget')
    expect(result.window.memory_budget.budget).toBe(60_000)
  })

  it('says unavailable when no extension registered the tool', async () => {
    getMock.mockResolvedValue(undefined)
    expect(await loadAgentContext(supabase, 'c1', 'u1')).toEqual({ status: 'unavailable' })
  })

  it('lets a failed briefing throw', async () => {
    getMock.mockResolvedValue({ execute: vi.fn().mockRejectedValue(new Error('db down')) })
    await expect(loadAgentContext(supabase, 'c1', 'u1')).rejects.toThrow('db down')
  })
})

describe('loadWikiRecord', () => {
  it('runs get_record on the record_ref and describes the answer', async () => {
    const answer = { record_ref: `journal_entry:${ID}`, kind: 'journal_entry', journal_entry: { voucher: 'A1', documents: [] } }
    const execute = vi.fn().mockResolvedValue(answer)
    getMock.mockResolvedValue({ name: RECORD_TOOL, execute })
    const result = await loadWikiRecord(supabase, 'c1', 'u1', 'journal_entry', ID)
    expect(getMock).toHaveBeenCalledWith(RECORD_TOOL)
    expect(execute).toHaveBeenCalledWith({ record_ref: `journal_entry:${ID}` }, 'c1', 'u1', supabase, { type: 'user', id: 'u1' })
    expect(result).toMatchObject({ status: 'ok', record: { title: 'A1' }, text: JSON.stringify(answer, null, 2) })
  })

  it('maps the tool NOT_FOUND to not_found', async () => {
    getMock.mockResolvedValue({ execute: vi.fn().mockRejectedValue(Object.assign(new Error('Record not found'), { code: 'NOT_FOUND' })) })
    expect(await loadWikiRecord(supabase, 'c1', 'u1', 'document', ID)).toEqual({ status: 'not_found' })
  })

  it('answers not_enabled for a brain kind outside the rollout without calling the tool', async () => {
    expect(await loadWikiRecord(supabase, 'c1', 'u1', 'agreement', ID)).toEqual({ status: 'not_enabled' })
    expect(getMock).not.toHaveBeenCalled()
  })

  it('opens a brain kind inside the rollout', async () => {
    brainMock.mockReturnValue(true)
    getMock.mockResolvedValue({ execute: vi.fn().mockResolvedValue({ party: { display_name: 'Leverantör AB', documents: [], agreements: [] } }) })
    expect(await loadWikiRecord(supabase, 'c1', 'u1', 'party', ID)).toMatchObject({ status: 'ok', record: { title: 'Leverantör AB' } })
  })

  it('maps ARKIV_NOT_ENABLED from the tool, and rethrows anything else', async () => {
    brainMock.mockReturnValue(true)
    getMock.mockResolvedValue({ execute: vi.fn().mockRejectedValue(Object.assign(new Error('off'), { code: 'ARKIV_NOT_ENABLED' })) })
    expect(await loadWikiRecord(supabase, 'c1', 'u1', 'fact', ID)).toEqual({ status: 'not_enabled' })
    getMock.mockResolvedValue({ execute: vi.fn().mockRejectedValue(new Error('db down')) })
    await expect(loadWikiRecord(supabase, 'c1', 'u1', 'document', ID)).rejects.toThrow('db down')
  })

  it('says unavailable when no extension registered the tool', async () => {
    getMock.mockResolvedValue(undefined)
    expect(await loadWikiRecord(supabase, 'c1', 'u1', 'document', ID)).toEqual({ status: 'unavailable' })
  })
})
