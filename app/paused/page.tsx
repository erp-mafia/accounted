import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { Lock } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { getActiveCompanyId } from '@/lib/company/context'
import { PausedSignOutButton } from './sign-out-button'

/**
 * Multi-user seat gate: the landing for a user whose EVERY membership is
 * frozen (non-owner in companies whose multi_user entitlement lapsed past
 * its 20-day grace). Middleware routes here instead of onboarding, so a
 * locked-out colleague is told what happened and who can fix it rather than
 * being walked into creating a pointless company.
 *
 * Self-healing on purpose: the page re-runs the gated resolution first, so
 * the moment an owner pays, a reload lands the user straight back in the
 * company. Nothing here is stateful.
 */
export default async function PausedPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Anything accessible after all (an owner upgraded, or the user was made
  // owner somewhere) leaves this page immediately.
  const companyId = await getActiveCompanyId(supabase, user.id).catch(() => null)
  if (companyId) redirect('/')

  const { data: memberships } = await supabase
    .from('company_members')
    .select('company_id, companies:company_id(name, archived_at)')
    .eq('user_id', user.id)
  type Row = { company_id: string; companies: { name: string; archived_at: string | null } | null }
  const rows = ((memberships ?? []) as unknown as Row[]).filter(
    (m) => m.companies && m.companies.archived_at === null,
  )

  // Current display names (company_settings.company_name; companies.name is
  // frozen at creation). RLS scopes the read to the user's own companies.
  const { data: settingsNames } = await supabase
    .from('company_settings')
    .select('company_id, company_name')
    .in('company_id', rows.map((m) => m.company_id))
  const nameByCompany = new Map(
    (settingsNames ?? []).map((s) => [s.company_id, s.company_name as string | null]),
  )
  const companyNames = rows.map(
    (m) => nameByCompany.get(m.company_id) || m.companies?.name || '',
  )

  // No memberships at all means this page is the wrong destination.
  if (companyNames.length === 0) redirect('/')

  const t = await getTranslations('paused')

  return (
    <div className="flex min-h-dvh items-center justify-center bg-frame px-4">
      <div className="w-full max-w-md rounded-xl border border-border bg-background p-8 text-center">
        <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-secondary">
          <Lock className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        </div>
        <h1 className="font-display text-2xl leading-8 tracking-tight">{t('title')}</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          {companyNames.length === 1
            ? t('body_single', { companyName: companyNames[0] })
            : t('body_multiple', { companyNames: companyNames.join(', ') })}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">{t('body_action')}</p>
        <div className="mt-6">
          <PausedSignOutButton label={t('sign_out')} />
        </div>
      </div>
    </div>
  )
}
