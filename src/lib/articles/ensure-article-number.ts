import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Assign an article number to an article row via the generate_article_number
 * RPC. Idempotent: if the row already has a number, the RPC returns it unchanged
 * without consuming a sequence number. Concurrency is handled inside the RPC via
 * a row lock on the article plus an atomic counter on company_settings: two
 * callers racing on the same article both return the same number and the counter
 * advances by exactly one.
 *
 * Mirrors lib/invoices/ensure-invoice-number.ts. Unlike invoice numbers, article
 * numbers are master data and carry no BFL sequence/immutability obligation, so
 * a gap is harmless.
 */
export async function ensureArticleNumber(
  supabase: SupabaseClient,
  companyId: string,
  articleId: string,
): Promise<string> {
  const { data, error } = await supabase.rpc('generate_article_number', {
    p_company_id: companyId,
    p_article_id: articleId,
  })

  if (error || !data) {
    throw new Error(`Failed to assign article number: ${error?.message ?? 'no value returned'}`)
  }

  return data as string
}
