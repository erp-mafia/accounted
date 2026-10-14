'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { useMigratedDeductionStatus } from './use-migrated-deduction'

/**
 * One quiet line on /invoices/rot-rut for companies that moved from Visma:
 * their invoices only become requestable here after the deduction step on
 * /import (MigratedDeductionCard).
 */
export default function MigratedDeductionPointer() {
  const t = useTranslations('migrated_deduction')
  const status = useMigratedDeductionStatus()
  if (!status?.applicable) return null
  return (
    <p className="text-[12.5px] text-muted-foreground">
      {t.rich('pointer', {
        link: (chunks) => (
          <Link href="/import" className={QUIET_LINK_CLASS}>
            {chunks}
          </Link>
        ),
      })}
    </p>
  )
}
