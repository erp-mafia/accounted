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
