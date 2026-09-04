export function AccountNub({ account }: { account: string | null }) {
  if (!account) return <span className="text-muted-foreground">·</span>
  return <span className="rounded-sm bg-secondary px-1 py-px font-mono text-[12px] tabular-nums">{account}</span>
}
