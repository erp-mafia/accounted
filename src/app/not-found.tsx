import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { Button } from '@/components/ui/button'
import { StandaloneMessage } from '@/components/standalone/StandalonePage'

/**
 * An address no route answers, outside the app shell: the standalone frame
 * of the sign-in pages with what happened, why, and the way back.
 * Server-rendered from `common` alone (the root serves only
 * ROOT_CLIENT_NAMESPACES to client code).
 */
export default async function NotFound() {
  const t = await getTranslations('common')
  return (
    <StandaloneMessage width="auth" title={t('page_not_found')} body={t('not_found_hint')}>
      <Button asChild variant="outline" size="lg" className="w-full">
        <Link href="/">{t('back_home')}</Link>
      </Button>
    </StandaloneMessage>
  )
}
