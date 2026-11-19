import type { Article } from '@/types'

/**
 * The language a customer-facing document is written in. The invoice PDF and
 * email follow the customer's language (customers.language), so an article
 * line follows it too.
 */
export type DocumentLanguage = 'sv' | 'en'

export function documentLanguageOf(customer: { language?: string | null } | null | undefined): DocumentLanguage {
  return customer?.language === 'en' ? 'en' : 'sv'
}

type ArticleNames = Pick<Article, 'name' | 'name_en'>

/**
 * The text an invoice line takes from an article (crm#1084): the English
 * benämning on an English-language document when the article has one, the
 * Swedish name otherwise. The one rule every door that fills a line from an
 * article uses: the invoice editor, the kundorder form and the agent's
 * create/update invoice and create sales order tools.
 */
export function articleLineName(article: ArticleNames, language: DocumentLanguage): string {
  const english = article.name_en?.trim()
  return language === 'en' && english ? english : article.name
}

type LineForSwap = {
  line_type?: string | null
  article_id?: string | null
  description?: string | null
}

/**
 * A draft whose language changes (another customer is picked) moves its
 * article lines to the new language, but only the lines whose text is still
 * exactly what the article gave them in the old language: a text the user
 * typed or edited stays as it is. Lines whose article has no English name, or
 * that are no longer linked to an article, have nothing to switch to.
 */
export function planArticleNameSwap(params: {
  items: ReadonlyArray<LineForSwap | null | undefined>
  articles: ReadonlyArray<ArticleNames & Pick<Article, 'id'>>
  from: DocumentLanguage
  to: DocumentLanguage
}): Array<{ index: number; description: string }> {
  const { items, articles, from, to } = params
  if (from === to) return []
  const byId = new Map(articles.map((article) => [article.id, article]))
  const swaps: Array<{ index: number; description: string }> = []
  items.forEach((item, index) => {
    if (!item?.article_id || item.line_type === 'text') return
    const article = byId.get(item.article_id)
    if (!article) return
    const previous = articleLineName(article, from)
    const next = articleLineName(article, to)
    if (previous !== next && (item.description ?? '') === previous) swaps.push({ index, description: next })
  })
  return swaps
}
