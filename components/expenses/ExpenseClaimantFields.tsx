'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { OWNER_FALLBACK_NAME, type ExpensePayer } from '@/lib/expenses/payer'

interface EmployeeOption {
  id: string
  first_name: string
  last_name: string
}

/**
 * Who the utlägg belongs to, once "Vem betalade?" is a person: the owner's
 * name (optional, the shared fallback label otherwise) or one of the
 * company's employees. Shared by the Underlag dialog and the supplier-invoice
 * form so both post the same claimant to the same claims writer. Employees
 * are fetched on first need; the host only sees the chosen id and name.
 */
export function ExpenseClaimantFields({
  payer,
  ownerName,
  onOwnerNameChange,
  employeeId,
  onEmployeeChange,
  disabled,
  idPrefix = 'claimant',
  className,
  labelClassName,
  inputClassName,
}: {
  payer: ExpensePayer
  ownerName: string
  onOwnerNameChange: (name: string) => void
  employeeId: string
  /** The picked employee's id and display name ('' when cleared). */
  onEmployeeChange: (id: string, name: string) => void
  disabled?: boolean
  idPrefix?: string
  className?: string
  labelClassName?: string
  inputClassName?: string
}) {
  const t = useTranslations('inbox_workspace')
  const [employees, setEmployees] = useState<EmployeeOption[]>([])
  const [employeesLoaded, setEmployeesLoaded] = useState(false)

  useEffect(() => {
    if (payer !== 'employee' || employeesLoaded) return
    let cancelled = false
    fetch('/api/salary/employees')
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (!cancelled) setEmployees((json?.data ?? []) as EmployeeOption[])
      })
      .catch(() => {
        if (!cancelled) setEmployees([])
      })
      .finally(() => {
        if (!cancelled) setEmployeesLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [payer, employeesLoaded])

  if (payer === 'owner') {
    return (
      <div className={cn('space-y-1.5', className)}>
        <Label htmlFor={`${idPrefix}-owner`} className={labelClassName}>
          {t('expense_owner_name')}
        </Label>
        <Input
          id={`${idPrefix}-owner`}
          value={ownerName}
          onChange={(e) => onOwnerNameChange(e.target.value)}
          placeholder={OWNER_FALLBACK_NAME}
          disabled={disabled}
          className={inputClassName}
        />
      </div>
    )
  }

  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={`${idPrefix}-employee`} className={labelClassName}>
        {t('expense_employee')}
      </Label>
      <Select
        value={employeeId}
        onValueChange={(id) => {
          const picked = employees.find((e) => e.id === id)
          onEmployeeChange(id, picked ? `${picked.first_name} ${picked.last_name}`.trim() : '')
        }}
        disabled={disabled}
      >
        <SelectTrigger id={`${idPrefix}-employee`} className={inputClassName}>
          <SelectValue
            placeholder={employeesLoaded && employees.length === 0 ? t('expense_no_employees') : t('expense_pick_employee')}
          />
        </SelectTrigger>
        <SelectContent>
          {employees.map((e) => (
            <SelectItem key={e.id} value={e.id}>
              {e.first_name} {e.last_name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
