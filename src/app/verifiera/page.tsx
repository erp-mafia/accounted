import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { VerifyPage } from '@/components/signing/VerifyPage'

// Public, no account: whoever holds a PDF signed through Accounted checks it
// here. The file never leaves the browser; only its SHA-256 is sent.
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('verify_page')
  return { title: t('meta_title'), description: t('meta_description') }
}

export default function VerifieraPage() {
  return <VerifyPage />
}
