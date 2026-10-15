import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { sieImportCommitActor, submitSIEJob } from '../sie-jobs'
import type { SIEJob } from '../sie-job-contract'
import type { AccountMapping } from '../types'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'

/**
 * WHO an SIE import's verifikat record as committer: the actor that submitted
 * the job, sealed into the job manifest as commit_actor. The worker that
 * writes the chunks later (often under a cron) is not who imported the books;
 * import_sie_chunk stamps the sealed actor (migration 20261015235000,
 * tests/pg/sie-import-commit-actor.pg.test.ts).
 */
const options = { filename: 'ledger.se', createFiscalPeriod: false, importOpeningBalances: false, importTransactions: true }
const mappings: AccountMapping[] = ['1930', '3001'].map((number) => ({
  sourceAccount: number, targetAccount: number, sourceName: 'Account', targetName: 'Account',
  confidence: 1, matchType: 'exact', isOverride: false,
}))
const file = '#FLAGGA 0\n#SIETYP 4\n#FNAMN "Example AB"\n#RAR 0 20260101 20261231\n#VER "" "" 20260201 "Sale"\n{\n#TRANS 1930 {} 100\n#TRANS 3001 {} -100\n}'

describe('sieImportCommitActor', () => {
  it('names a key or OAuth client in an import label', () => {
    expect(sieImportCommitActor({ type: 'mcp_oauth', label: 'Claude (Anthropic)' })).toEqual({
      type: 'mcp_oauth', label: 'SIE import: Claude (Anthropic)',
    })
    expect(sieImportCommitActor({ type: 'api_key', label: 'Byrånyckel' })).toEqual({
      type: 'api_key', label: 'SIE import: Byrånyckel',
    })
  })

  it('labels a signed-in user\'s import as an import', () => {
    expect(sieImportCommitActor({ type: 'user' })).toEqual({ type: 'user', label: 'SIE import' })
  })

  it('says a provider migration came in that way', () => {
    expect(sieImportCommitActor({ type: 'user' }, 'provider_migration')).toEqual({
      type: 'user', label: 'Provider migration (SIE import)',
    })
  })

  it('records nothing outside an actor scope', () => {
    expect(sieImportCommitActor(undefined)).toBeNull()
  })
})

describe('submitSIEJob: commit_actor in the job manifest', () => {
  afterEach(() => vi.unstubAllEnvs())

  function admitting() {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    const job = { id: 'import-1', job_state: 'queued' } as unknown as SIEJob
    // The period, the predecessor and the start RPC (the file has no #ORGNR).
    enqueueMany([{ data: { id: 'period-1' } }, { data: null }, { data: job }])
    return { supabase, job }
  }
  const manifestOf = (supabase: ReturnType<typeof createQueuedMockSupabase>['supabase']) =>
    vi.mocked(supabase.rpc).mock.calls[0][1].p_manifest

  it('seals the submitting actor beside the input, so a retry by someone else is the same import', async () => {
    vi.stubEnv('SIE_IMPORT_JOBS', 'true')
    const { supabase, job } = admitting()

    await expect(
      runWithActor({ type: 'mcp_oauth', label: 'ChatGPT (OpenAI)' }, () =>
        submitSIEJob(supabase as unknown as SupabaseClient, 'company-1', 'user-1', file, mappings, options),
      ),
    ).resolves.toEqual(job)

    const manifest = manifestOf(supabase)
    expect(manifest.commit_actor).toEqual({ type: 'mcp_oauth', label: 'SIE import: ChatGPT (OpenAI)' })
    expect(manifest.input).not.toHaveProperty('commit_actor')
    expect(manifest.input.options).not.toHaveProperty('commit_actor')
  })

  it('labels a provider migration', async () => {
    vi.stubEnv('SIE_IMPORT_JOBS', 'true')
    const { supabase } = admitting()

    await runWithActor({ type: 'user' }, () =>
      submitSIEJob(supabase as unknown as SupabaseClient, 'company-1', 'user-1', file, mappings, options,
        undefined, 'provider_migration'),
    )

    expect(manifestOf(supabase).commit_actor).toEqual({ type: 'user', label: 'Provider migration (SIE import)' })
  })

  it('leaves commit_actor out without an actor scope', async () => {
    vi.stubEnv('SIE_IMPORT_JOBS', 'true')
    const { supabase } = admitting()

    await submitSIEJob(supabase as unknown as SupabaseClient, 'company-1', 'user-1', file, mappings, options)

    expect(manifestOf(supabase)).not.toHaveProperty('commit_actor')
  })
})
