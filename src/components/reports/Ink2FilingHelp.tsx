import { useTranslations } from 'next-intl'

/**
 * The INK2 page's "?" (UI-migration convention 7): what the declaration is
 * and how its SRU files are filed. The help is chrome and follows the user's
 * language; the form's own field codes and labels stay Swedish.
 * A module of its own so the report shell can render
 * it without pulling in the lazily loaded INK2DeclarationView.
 */
export function Ink2FilingHelp() {
  const t = useTranslations('reports')
  return (
    <div className="space-y-2">
      <p>{t('ink2_help_intro')}</p>
      <ol className="list-decimal space-y-1 pl-4">
        <li>{t('ink2_help_download')}</li>
        <li>
          {t.rich('ink2_help_upload', {
            link: (chunks) => (
              <a
                href="https://www1.skatteverket.se/fv/fv_web/start.do"
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2 text-foreground"
              >
                {chunks}
              </a>
            ),
          })}
        </li>
      </ol>
    </div>
  )
}
