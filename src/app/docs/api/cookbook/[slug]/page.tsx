import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { DocsLayout } from '@/components/docs/DocsLayout'
import { DocsMarkdown } from '@/lib/docs/markdown'
import { findRecipe, COOKBOOK_SLUGS, buildPlaceholderMd } from '@/lib/docs/content/cookbook'

export function generateStaticParams() {
  return COOKBOOK_SLUGS.map((slug) => ({ slug }))
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params
  const entry = findRecipe(slug)
  if (!entry) return { title: 'Not found' }
  return {
    title: `${entry.title} · accounted API cookbook`,
    description: entry.description,
  }
}

export default async function DocsApiCookbookRecipePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const entry = findRecipe(slug)
  if (!entry) notFound()
  const md = entry.markdown ?? buildPlaceholderMd(entry)
  return (
    <DocsLayout currentPath={`/docs/api/cookbook/${slug}`}>
      <DocsMarkdown source={md} />
    </DocsLayout>
  )
}
