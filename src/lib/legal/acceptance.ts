import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { ACCEPTED_DOCUMENTS, LEGAL_DOCUMENTS, type LegalDocumentKey } from './documents'

const log = createLogger('legal.acceptance')

/**
 * Where a person stands with the legal documents: which ones they still have
 * to accept at the current version (src/lib/legal/documents.ts), and their
 * analytics choice. Read for the acceptance prompt (LegalAcceptanceGate) and
 * the account settings.
 */
export interface AcceptanceState {
  /** Documents not accepted at their current acceptanceVersion. Empty: nothing to ask. */
  pending: LegalDocumentKey[]
  /** user_preferences.analytics_consent: null when never asked. */
  analyticsConsent: boolean | null
}

export type AcceptanceMethod = 'accept_all' | 'accept_documents'

/** The current version of every document a person accepts, in the order the prompt lists them. */
export function currentAcceptanceVersions(): Array<{ key: LegalDocumentKey; version: string }> {
  return ACCEPTED_DOCUMENTS.map((key) => ({ key, version: LEGAL_DOCUMENTS[key].acceptanceVersion as string }))
}

/**
 * Read with the person's own client (RLS: their rows only). A failed read
 * answers "nothing pending": the prompt is a request, and a database hiccup
 * must not put a wall in front of someone's books. The analytics read is its
 * own query, so a failure there leaves analytics off, never on.
 */
export async function readAcceptanceState(supabase: SupabaseClient, userId: string): Promise<AcceptanceState> {
  const [acceptances, prefs] = await Promise.all([
    supabase
      .from('legal_acceptances')
      .select('document_key, version')
      .eq('user_id', userId)
      .in('document_key', ACCEPTED_DOCUMENTS),
    supabase.from('user_preferences').select('analytics_consent').eq('user_id', userId).maybeSingle(),
  ])

  let pending: LegalDocumentKey[] = []
  if (acceptances.error) {
    log.warn('acceptance read failed; not prompting', { userId, reason: acceptances.error.message })
  } else {
    const rows = (acceptances.data ?? []) as Array<{ document_key: string; version: string }>
    pending = ACCEPTED_DOCUMENTS.filter(
      (key) => !rows.some((r) => r.document_key === key && r.version === LEGAL_DOCUMENTS[key].acceptanceVersion),
    )
  }

  const consent = prefs.error ? null : ((prefs.data as { analytics_consent?: boolean | null } | null)?.analytics_consent ?? null)
  return { pending, analyticsConsent: consent }
}

/**
 * Record the documents a person accepted. Idempotent: a version already
 * accepted stays as first recorded (ON CONFLICT DO NOTHING), which is also all
 * the append-only table allows. One literal write per document, so the
 * schema guard can check every column; a failure part-way leaves the rest
 * pending and the prompt asks again. Throws on a failed write.
 */
export async function recordAcceptances(
  supabase: SupabaseClient,
  input: { userId: string; companyId: string | null; method: AcceptanceMethod; documents: Array<{ key: LegalDocumentKey; version: string }> },
): Promise<void> {
  for (const doc of input.documents) {
    const { error } = await supabase.from('legal_acceptances').upsert(
      {
        user_id: input.userId,
        company_id: input.companyId,
        document_key: doc.key,
        version: doc.version,
        method: input.method,
      },
      { onConflict: 'user_id,document_key,version', ignoreDuplicates: true },
    )
    if (error) throw new Error(`Failed to record legal acceptance: ${error.message}`)
  }
}

/** Store the person's analytics choice and when it was made. Throws on a failed write. */
export async function storeAnalyticsConsent(supabase: SupabaseClient, userId: string, granted: boolean): Promise<void> {
  const { error } = await supabase
    .from('user_preferences')
    .upsert(
      { user_id: userId, analytics_consent: granted, analytics_consent_at: new Date().toISOString() },
      { onConflict: 'user_id' },
    )
  if (error) throw new Error(`Failed to store analytics consent: ${error.message}`)
}
