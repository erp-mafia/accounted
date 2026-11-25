/**
 * The rows a proposal's approval builds at the click (verifikatBuiltAtApproval),
 * asked of the server for the card beside its Godkänn in Rutin
 * (GET /api/pending-operations/[id]/verifikat, which works them out with the
 * approval's own code).
 *
 * Asked once the card has been open BUILT_VERIFIKAT_ASK_AFTER_MS, so a page
 * load or a pointer passing over the rows asks nothing, and asked again at
 * every opening: what the approval books can change between two openings
 * (the company's VAT registration or accounting method, the supplier, the
 * fiscal year), and an answer kept from an earlier one could show rows the
 * click would no longer book.
 */
import type { ApprovalVerifikatAnswer } from '@/lib/pending-operations/built-at-approval'

/** How long the card stays open before it asks. */
export const BUILT_VERIFIKAT_ASK_AFTER_MS = 200

/** Every kind of answer the route gives; any other body is a failure. */
const ANSWERS: ReadonlySet<unknown> = new Set<ApprovalVerifikatAnswer['posts']>(['verifikat', 'nothing', 'at_approval', 'refused'])

/** What approving the proposal would post, as the server works it out now. */
export async function askBuiltVerifikat(id: string): Promise<ApprovalVerifikatAnswer> {
  const res = await fetch(`/api/pending-operations/${encodeURIComponent(id)}/verifikat`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = (await res.json()) as { data?: { posts?: unknown } }
  if (!ANSWERS.has(json.data?.posts)) throw new Error('unexpected answer')
  return json.data as ApprovalVerifikatAnswer
}
