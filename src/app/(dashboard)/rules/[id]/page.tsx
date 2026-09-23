import RuleDetail from '@/components/rules/RuleDetail'

export const dynamic = 'force-dynamic'

export default async function RulePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <RuleDetail id={id} />
}
