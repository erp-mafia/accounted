/**
 * The company_settings read of Nordea's CCM agreement id while its column
 * may not exist yet (crm#1530). Server only: kept out of lib/payments/nordea.ts,
 * which Settings and the shared API schemas import into client bundles, since
 * isMissingColumnError lives beside node:async_hooks.
 */

import { isMissingColumnError } from '@/lib/pending-operations/agent-reason'

/**
 * Read company_settings with nordea_agreement_id (`read`), and when the
 * database does not know the column yet (Vercel serves main's code up to a
 * few hours before CI applies migration 20261102093417) read it once more
 * without it (`readWithoutColumn`) and take the row as having no agreement
 * id. A Nordea company is then asked for the id, every other company is
 * unaffected. Two literal selects, so the schema guard checks both.
 */
export async function tolerateMissingNordeaAgreementId<
  R extends { data: unknown; error: { code?: string } | null },
  F extends { data: unknown; error: { code?: string } | null },
>(read: () => PromiseLike<R>, readWithoutColumn: () => PromiseLike<F>): Promise<R | F> {
  const first = await read()
  if (!isMissingColumnError(first.error)) return first
  const second = await readWithoutColumn()
  const data =
    second.data && typeof second.data === 'object'
      ? { ...(second.data as Record<string, unknown>), nordea_agreement_id: null }
      : second.data
  return { ...second, data }
}
