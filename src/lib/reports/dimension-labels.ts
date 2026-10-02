import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

/**
 * The registry's dimension names by SIE number ('1' is Kostnadsställe, '6'
 * Projekt), for labelling a line's tags in an export. Read-only: it never
 * seeds the system dimensions the way the registry service does, and it is
 * paginated like every registry read.
 */
export async function loadDimensionNames(
  supabase: SupabaseClient,
  companyId: string,
): Promise<Map<string, string>> {
  const rows = await fetchAllRows<{ sie_dim_no: number; name: string }>(({ from, to }) =>
    supabase
      .from('dimensions')
      .select('sie_dim_no, name')
      .eq('company_id', companyId)
      .order('sie_dim_no', { ascending: true })
      .range(from, to),
  )
  return new Map(rows.map((r) => [String(r.sie_dim_no), r.name]))
}

/**
 * One line's dimension tags as text, in SIE number order:
 * "Kostnadsställe KS01, Projekt P100". A number the registry does not name
 * reads "20: X1", so a tag is never dropped from the export. Empty for an
 * untagged line. Report surface: the names are the company's own, the
 * format carries no translated words.
 */
export function formatLineDimensions(
  dimensions: Record<string, string> | null | undefined,
  names: ReadonlyMap<string, string>,
): string {
  if (!dimensions) return ''
  return Object.entries(dimensions)
    .filter(([, code]) => typeof code === 'string' && code.trim().length > 0)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([dimNo, code]) => {
      const name = names.get(dimNo)
      return name ? `${name} ${code}` : `${dimNo}: ${code}`
    })
    .join(', ')
}
