/**
 * The INK2 page's "?" (UI-migration convention 7): what the declaration is
 * and how its SRU files are filed. Statutory Skatteverket surface, so it
 * stays Swedish in both locales (.claude/rules/i18n.md). A module of its own
 * so the report shell can render it without pulling in the lazily loaded
 * INK2DeclarationView.
 */
export function Ink2FilingHelp() {
  return (
    <div className="space-y-2">
      <p>
        Inkomstdeklaration 2 (INK2) visar det bokföringsmässiga resultatet baserat på din
        bokföring.
      </p>
      <ol className="list-decimal space-y-1 pl-4">
        <li>Ladda ner SRU-filerna (en ZIP med INFO.SRU och BLANKETTER.SRU).</li>
        <li>
          Ladda upp båda filerna till{' '}
          <a
            href="https://www1.skatteverket.se/fv/fv_web/start.do"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 text-foreground"
          >
            Skatteverkets filöverföringstjänst
          </a>
          .
        </li>
      </ol>
    </div>
  )
}
