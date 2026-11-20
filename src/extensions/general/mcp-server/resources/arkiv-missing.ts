import type { McpResource } from './types'
import { isArkivBrainEnabled } from '@/lib/arkiv/flag'
import { EXPECTATION_RULES } from '@/lib/arkiv/lint/checks'
import { resolveInboxAddress } from '@/lib/documents/inbox-address'

/**
 * Arkiv phase 9, the agent door. What the books say should exist in the
 * archive but does not, with the evidence, where such a document usually
 * lives, and the address to forward it to. A customer's own agent reads this,
 * searches the mail and drives it already has access to, uploads what it
 * finds, and closes the request with gnubok_resolve_missing.
 */
interface ExpectedRow {
  id: string
  key: string
  detail: Record<string, unknown>
  first_seen_at: string
}

export const arkivMissingResource: McpResource = {
  uri: 'Accounted://arkiv/missing',
  name: 'Arkiv Missing Documents',
  description:
    'Documents the bookkeeping says should exist but the archive lacks (a loan with interest but no loan agreement, rent paid but no rental agreement), each with its evidence, where it usually lives, and the intake address to forward it to. Close one with gnubok_resolve_missing.',
  mimeType: 'application/json',
  read: async ({ supabase, companyId }) => {
    if (!isArkivBrainEnabled(companyId)) return { enabled: false, reason: 'Arkiv is not switched on for this company.' }
    const [findings, inboxAddress] = await Promise.all([
      supabase
        .from('arkiv_findings')
        .select('id, key, detail, first_seen_at')
        .eq('company_id', companyId)
        .eq('kind', 'document_expected')
        .eq('status', 'open')
        .order('first_seen_at', { ascending: true })
        .limit(50),
      resolveInboxAddress(supabase, companyId),
    ])
    if (findings.error) throw new Error(`findings fetch failed: ${findings.error.message}`)
    const rows = (findings.data ?? []) as ExpectedRow[]
    return {
      company: { record_ref: `company:${companyId}` },
      intake: {
        // Forwarding a document here walks the same pipe as an upload: read, classified, landed.
        email: inboxAddress,
      },
      missing: rows.map((r) => {
        const rule = EXPECTATION_RULES.find((x) => x.id === r.detail.rule)
        return {
          finding_id: r.id,
          rule: r.detail.rule ?? null,
          expected_type: r.detail.expected_type ?? rule?.expectedType ?? null,
          label: rule?.label ?? String(r.detail.expected_type ?? ''),
          evidence: r.detail.evidence ?? null,
          hint: rule?.hint ?? null,
          since: r.first_seen_at,
        }
      }),
      how_to: [
        'Search the mailboxes and drives you have access to with the hint; ask the person before uploading anything.',
        'Upload with gnubok_create_document_upload and gnubok_complete_document_upload, or forward the mail to the intake address; the document is read and lands by itself.',
        'Then gnubok_resolve_missing with resolution uploaded and the document record_ref. If the person says the document does not exist or the item does not apply, resolve with not_exists or not_applicable; that answer is remembered.',
      ],
    }
  },
}
