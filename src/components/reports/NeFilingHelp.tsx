import { useTranslations } from 'next-intl'

/**
 * The NE-bilaga page's "?" (UI-migration convention 7): what the file holds
 * and how it reaches Inkomstdeklaration 1. Skatteverket's e-tjänst imports
 * blanketter.sru under Bilagor and shows what is left to fill in, so the
 * steps end with sida 2. The help follows the user's language; the form's
 * own rutor stay Swedish.
 */
export function NeFilingHelp() {
  const t = useTranslations('reports')
  return (
    <div className="space-y-2">
      <p>{t('ne_help_intro')}</p>
      <ol className="list-decimal space-y-1 pl-4">
        <li>{t('ne_help_download')}</li>
        <li>{t('ne_help_import')}</li>
        <li>{t('ne_help_complete')}</li>
      </ol>
    </div>
  )
}
