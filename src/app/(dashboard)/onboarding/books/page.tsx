import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import { getActiveCompanyId } from '@/lib/company/context'
import { resolveBooksResume, type LatestImportJob } from '@/lib/onboarding-books/resume'
import BooksJourney from '@/components/onboarding/books/BooksJourney'

export const dynamic = 'force-dynamic'

/**
 * /onboarding/books: act two of the onboarding journey (issue #2438).
 *
 * The company exists (the dashboard layout above resolved it and mounted
 * the company context); this act brings the books in, then the bank and
 * Skatteverket, inside the journey chrome. The layout renders its bare
 * shell for this path. The station and the OAuth landing parameters arrive
 * in the query string: the first-session gate rewrites /settings/banking
 * and /import onto this page with their query intact, and the Skatteverket
 * callback returns here through its return_to.
 *
 * The act's position is browser memory; the import's is the database. On
 * every load the page reads the company's latest import job and whether
 * posted entries exist, so a reload mid-import follows the job and a reload
 * after one opens on the genomlysning (lib/onboarding-books/resume).
 */
export default async function BooksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const params = await searchParams
  const first = (key: string) => {
    const v = params[key]
    return Array.isArray(v) ? v[0] : v
  }

  const companyId = await getActiveCompanyId(supabase, user.id)
  const [{ data: latestJob, error: jobError }, { count: postedEntries, error: entriesError }] = await Promise.all([
    supabase
      .from('sie_imports')
      .select('id, job_state, job_kind')
      .eq('company_id', companyId)
      .not('job_state', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('journal_entries')
      .select('*', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .in('status', ['posted', 'reversed']),
  ])
  // An unavailable read is not an empty company. Let the route boundary retry.
  if (jobError || entriesError) throw new Error('Unable to load onboarding progress')
  const resume = resolveBooksResume((latestJob as LatestImportJob | null) ?? null, postedEntries ?? 0)

  return (
    <BooksJourney
      key={`${user.id}:${companyId}`}
      draftScope={`books:${user.id}:${companyId}`}
      resumeImportId={resume.kind === 'active' ? resume.importId : null}
      hasBooks={resume.kind === 'books'}
      initialStation={first('station') ?? null}
      initialProvider={first('provider') ?? null}
      landedFromProvider={Boolean(first('migration') || first('handoff') || first('consentId'))}
      selectAccounts={first('select_accounts') ?? null}
      skvConnected={first('skv_connected') === 'true'}
      landedError={first('bank_error') ?? first('skv_error') ?? null}
      hasMigration={ENABLED_EXTENSION_IDS.has('arcim-migration')}
      hasBanking={ENABLED_EXTENSION_IDS.has('enable-banking')}
      hasSkatteverket={ENABLED_EXTENSION_IDS.has('skatteverket')}
    />
  )
}
