import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { softwareAgent } from '@/lib/documents/provenance'
import { ArkivProposeFactParamsSchema } from '@/lib/pending-operations/schemas/arkiv-propose-fact'
import { predicateDef } from './predicates'
import { recordFact } from './store'

/** The agent identity every approved proposal is asserted by. */
export const PROPOSER = { name: 'mcp.propose_fact', version: '1' } as const

export type ProposeFactCommitResult = { data: Record<string, unknown> } | { error: string; status: number }

/**
 * The commit of an approved arkiv_propose_fact: the fact is recorded with
 * the agent as asserter and the approver as approved_by. The subject must be
 * the company's own; an unknown predicate is refused here even if it slipped
 * past staging.
 */
export async function commitArkivProposeFact(supabase: SupabaseClient, userId: string, companyId: string, params: Record<string, unknown>): Promise<ProposeFactCommitResult> {
  let input
  try {
    input = ArkivProposeFactParamsSchema.parse(params)
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issue = err.issues[0]
      return { error: `Invalid ${issue?.path?.join('.') ?? 'params'}: ${issue?.message ?? 'validation failed'}`, status: 400 }
    }
    throw err
  }
  const def = predicateDef(input.predicate)
  if (!def) return { error: 'Okänt faktum: predikatet finns inte i vokabulären.', status: 400 }
  if (def.subject !== input.subject_kind) return { error: `Faktumet ${input.predicate} gäller ${def.subject}, inte ${input.subject_kind}.`, status: 400 }
  if (!(await subjectBelongs(supabase, companyId, input.subject_kind, input.subject_id))) return { error: 'Ämnet hittades inte i bolaget.', status: 404 }

  const factId = await recordFact(supabase, {
    companyId,
    subjectKind: input.subject_kind,
    subjectId: input.subject_id,
    predicate: input.predicate,
    value: input.value,
    singleValued: def.singleValued,
    validFrom: input.valid_from ?? null,
    validTo: input.valid_to ?? null,
    sourceKind: 'agent',
    sourceDocumentId: input.evidence?.document_id ?? null,
    evidence: input.evidence ? { document_id: input.evidence.document_id, page: input.evidence.page ?? null, quote: input.evidence.quote ?? null, at: new Date().toISOString() } : null,
    rationale: input.rationale,
    assertedByAgentId: await softwareAgent(supabase, PROPOSER.name, PROPOSER.version),
    approvedByUserId: userId,
  })
  return { data: { fact_id: factId, subject_kind: input.subject_kind, subject_id: input.subject_id, predicate: input.predicate, value: input.value } }
}

async function subjectBelongs(supabase: SupabaseClient, companyId: string, kind: 'company' | 'agreement' | 'party', id: string): Promise<boolean> {
  if (kind === 'company') return id === companyId
  const table = kind === 'agreement' ? 'agreements' : 'parties'
  const { data, error } = await supabase.from(table).select('id').eq('id', id).eq('company_id', companyId).maybeSingle()
  if (error) throw new Error(`subject lookup failed: ${error.message}`)
  return !!data
}
