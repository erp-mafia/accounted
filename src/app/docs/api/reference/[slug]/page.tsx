import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { DocsLayout } from '@/components/docs/DocsLayout'
import { DocsMarkdown } from '@/lib/docs/markdown'
import { buildResourcePages, RESOURCE_SLUGS } from '@/lib/docs/content/reference'

export function generateStaticParams() {
  return RESOURCE_SLUGS.map((slug) => ({ slug }))
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params
  const page = buildResourcePages().find((p) => p.slug === slug)
  if (!page) return { title: 'Not found' }
  return {
    title: `${page.label} · accounted API`,
    description: page.description,
  }
}

export default async function DocsApiReferenceResourcePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const page = buildResourcePages().find((p) => p.slug === slug)
  if (!page) notFound()

  return (
    <DocsLayout currentPath={`/docs/api/reference/${slug}`}>
      <DocsMarkdown source={page.markdown} />
    </DocsLayout>
  )
}
