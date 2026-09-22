import type { SupabaseClient } from '@supabase/supabase-js'
import { getSIEJob } from '@/lib/import/sie-jobs'
import { assessLegacySIEImport } from '@/lib/import/sie-legacy-recovery'

export const SIE_IMPORT_STATUS_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    import_id: { type: 'string' }, kind: { type: 'string', enum: ['durable', 'legacy'] },
    state: { type: 'string' }, chunks_done: { type: ['integer', 'null'] }, chunks_total: { type: ['integer', 'null'] },
    vouchers_written: { type: ['integer', 'null'] }, error_message: { type: ['string', 'null'] },
    result: { type: ['object', 'null'], additionalProperties: true },
    recovery: {
      type: 'object', additionalProperties: false,
      properties: {
        legacy_status: { type: 'string' }, period_resolution: { type: 'string' },
        entry_ownership: { type: 'string', enum: ['unverified'] }, mutation_available: { type: 'boolean', const: false },
        fiscal_period: {
          type: ['object', 'null'], additionalProperties: false,
          properties: {
            fiscal_period_id: { type: 'string' }, period_start: { type: 'string' }, period_end: { type: 'string' },
            is_closed: { type: 'boolean' }, locked_at: { type: ['string', 'null'] }, import_hold: { type: ['string', 'null'] },
          },
          required: ['fiscal_period_id', 'period_start', 'period_end', 'is_closed', 'locked_at', 'import_hold'],
        },
        period_entries: {
          type: ['object', 'null'], additionalProperties: false,
          description: 'Counts for the whole fiscal period, including drafts. These do not attribute entries to this import.',
          properties: { all: { type: 'integer' }, posted: { type: 'integer' }, importOrOpening: { type: 'integer' } },
          required: ['all', 'posted', 'importOrOpening'],
        },
        company_lock: {
          type: 'object', additionalProperties: false,
          properties: { known: { type: 'boolean' }, through: { type: ['string', 'null'] } }, required: ['known', 'through'],
        },
        archive_reference_present: { type: 'boolean', description: 'Stored pointer only. Source bytes and hash have not been verified.' },
        assessed_at: { type: 'string' }, review_url: { type: 'string' }, assessment_api_url: { type: 'string' },
      },
      required: ['legacy_status', 'period_resolution', 'entry_ownership', 'mutation_available', 'fiscal_period',
        'period_entries', 'company_lock', 'archive_reference_present', 'assessed_at', 'review_url', 'assessment_api_url'],
    },
  },
  required: ['import_id', 'kind', 'state', 'chunks_done', 'chunks_total', 'vouchers_written', 'error_message', 'result'],
  oneOf: [
    { type: 'object', properties: { kind: { const: 'durable' }, recovery: false }, required: ['kind'] },
    { type: 'object', properties: { kind: { const: 'legacy' }, recovery: { type: 'object' } }, required: ['kind', 'recovery'] },
  ],
}

export const SIE_IMPORT_LIST_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    kind: { type: 'string', const: 'list' },
    imports: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          import_id: { type: 'string' }, filename: { type: ['string', 'null'] }, status: { type: ['string', 'null'] },
          job_state: { type: ['string', 'null'] }, created_at: { type: 'string' }, replaced_at: { type: ['string', 'null'] },
        },
        required: ['import_id', 'filename', 'status', 'job_state', 'created_at', 'replaced_at'],
      },
    },
    count: { type: 'integer' },
    hint: { type: 'string' },
  },
  required: ['kind', 'imports', 'count', 'hint'],
}

/** The tool answers with progress for one import, or with the company's recent imports when none is named. */
export const SIE_IMPORT_STATUS_TOOL_SCHEMA = { type: 'object', oneOf: [SIE_IMPORT_STATUS_SCHEMA, SIE_IMPORT_LIST_SCHEMA] }

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isImportId(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

/**
 * An omitted import_id used to reach Postgres as the literal string
 * "undefined" and come back as "invalid input syntax for type uuid". The
 * agent that omits it is asking "which imports exist?", so answer that.
 */
export async function listRecentSIEImports(supabase: SupabaseClient, companyId: string, limit = 10) {
  const { data, error } = await supabase
    .from('sie_imports')
    .select('id, filename, status, job_state, created_at, replaced_at')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`Kunde inte läsa SIE-importer: ${error.message}`)
  const rows = (data ?? []) as Array<{
    id: string; filename: string | null; status: string | null; job_state: string | null; created_at: string; replaced_at: string | null
  }>
  const imports = rows.map((row) => ({
    import_id: row.id, filename: row.filename, status: row.status, job_state: row.job_state,
    created_at: row.created_at, replaced_at: row.replaced_at,
  }))
  return {
    kind: 'list', imports, count: imports.length,
    hint: imports.length === 0
      ? 'No SIE imports for this company yet.'
      : 'Pass import_id for durable progress or a legacy recovery assessment.',
  }
}

/** Keep the durable progress contract, and label legacy observations without inventing job progress. */
export async function readSIEImportStatus(supabase: SupabaseClient, companyId: string, importId: string) {
  const job = await getSIEJob(supabase, companyId, importId)
  if (job) return { import_id: job.id, kind: 'durable', state: job.job_state, chunks_done: job.chunks_done,
    chunks_total: job.chunks_total, vouchers_written: job.transactions_count, error_message: job.error_message, result: job.job_result }

  const assessment = await assessLegacySIEImport(supabase, companyId, importId)
  if (!assessment) throw Object.assign(new Error('SIE import not found'), { code: 'NOT_FOUND' })
  const { id: fiscalPeriodId, ...period } = assessment.period ?? { id: null }
  return {
    import_id: assessment.importId, kind: 'legacy', state: 'review_required',
    chunks_done: null, chunks_total: null, vouchers_written: null, error_message: null, result: null,
    recovery: {
      legacy_status: assessment.status, period_resolution: assessment.periodResolution,
      entry_ownership: 'unverified', mutation_available: false,
      fiscal_period: fiscalPeriodId ? { fiscal_period_id: fiscalPeriodId, ...period } : null,
      period_entries: assessment.entries, company_lock: assessment.companyLock,
      archive_reference_present: assessment.hasArchiveReference, assessed_at: assessment.assessedAt,
      review_url: '/import?mode=sie', assessment_api_url: `/api/import/sie/${assessment.importId}/recovery`,
    },
  }
}
