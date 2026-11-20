import { getTranslations } from 'next-intl/server'
import { NotFoundState } from '@/components/ui/empty-state'

/**
 * A page or record that does not exist, inside the panel (Stil v3 states:
 * one sentence where the content would be, and the way back) instead of the
 * framework's bare English 404.
 */
export default async function DashboardNotFound() {
  const t = await getTranslations('common')
  return <NotFoundState title={t('page_not_found')} backHref="/" backLabel={t('back_home')} />
}
