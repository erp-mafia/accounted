/**
 * Publish a sealed year-seal from this workshop instance to hosted Books SoR.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { generateYearSeal } from '@/lib/export/obx-year-seal'
import type { ObxApprovalMethod } from '@/lib/obx/export-approval'
import { getHostedPublishConfig } from '@/lib/obx/ledger-mode'
import { runPublishChecklist } from '@/lib/obx/publish-checklist'

export type PublishToHostedInput = {
  fiscalYear: number
  userId: string
  companyId: string
  /** Hosted company id override; falls back to OMBRA_HOSTED_COMPANY_ID */
  hostedCompanyId?: string
  approvalMethod?: ObxApprovalMethod
  passphrase?: string
  includeDocuments?: boolean
  /** Skip checklist (tests only) */
  skipChecklist?: boolean
}

export type PublishToHostedResult = {
  ok: boolean
  manifest_hash?: string
  hosted_status?: number
  hosted_body?: unknown
  checklist?: Awaited<ReturnType<typeof runPublishChecklist>>
  error?: string
}

export async function publishYearSealToHosted(
  supabase: SupabaseClient,
  input: PublishToHostedInput,
): Promise<PublishToHostedResult> {
  const config = getHostedPublishConfig()
  if (!config) {
    return {
      ok: false,
      error: 'Hybrid publish is not configured (OMBRA_LEDGER_MODE / hosted URL / API key)',
    }
  }

  const hostedCompanyId = input.hostedCompanyId ?? config.companyId
  if (!hostedCompanyId) {
    return {
      ok: false,
      error: 'OMBRA_HOSTED_COMPANY_ID (or hostedCompanyId) is required',
    }
  }

  if (!input.skipChecklist) {
    const checklist = await runPublishChecklist(supabase, input.companyId, input.fiscalYear)
    if (!checklist.can_publish) {
      return { ok: false, checklist, error: 'Pre-publish checklist failed' }
    }
  }

  const approvalMethod: ObxApprovalMethod = input.approvalMethod ?? 'passphrase'
  if (approvalMethod === 'passphrase' && (input.passphrase?.trim().length ?? 0) < 4) {
    return { ok: false, error: 'Passphrase must be at least 4 characters' }
  }

  const { bundle, meta } = await generateYearSeal(supabase, input.companyId, {
    fiscal_year: input.fiscalYear,
    userId: input.userId,
    include_documents: input.includeDocuments ?? true,
    approval_method: approvalMethod,
    seal: approvalMethod === 'passphrase' ? { passphrase: input.passphrase } : undefined,
  })

  const form = new FormData()
  const bytes = Buffer.from(bundle)
  form.set(
    'file',
    new Blob([bytes], { type: 'application/vnd.ombra.obx+zip' }),
    `obx_${input.fiscalYear}.obx`,
  )
  form.set('module_type', 'year')
  if (input.passphrase) form.set('passphrase', input.passphrase)

  const url = `${config.baseUrl}/api/integrations/ombra/import/obx`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'X-Company-Id': hostedCompanyId,
    },
    body: form,
  })

  let hosted_body: unknown
  const contentType = res.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    hosted_body = await res.json().catch(() => null)
  } else {
    hosted_body = await res.text().catch(() => null)
  }

  if (!res.ok) {
    return {
      ok: false,
      manifest_hash: meta.manifest_hash,
      hosted_status: res.status,
      hosted_body,
      error: `Hosted import failed with HTTP ${res.status}`,
    }
  }

  return {
    ok: true,
    manifest_hash: meta.manifest_hash,
    hosted_status: res.status,
    hosted_body,
  }
}
