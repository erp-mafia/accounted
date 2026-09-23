'use client'

import { useMemo, useState } from 'react'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { DestructiveConfirmDialog } from '@/components/ui/destructive-confirm-dialog'
import { Loader2, Trash2 } from 'lucide-react'
import {
  DIMENSION_CODE_PATTERN,
  PROJECT_DIM_NO,
  type DimensionDto,
  type DimensionValueDto,
} from '@/components/dimensions/types'

export interface DimensionValueFormInput {
  code: string
  name: string
  is_active: boolean
  start_date: string | null
  end_date: string | null
}

interface DimensionValueFormProps {
  /** The dimension the value belongs to (drives the Projekt date fields). */
  dimension: DimensionDto
  /** When set, the form edits this value (code becomes immutable). */
  value?: DimensionValueDto | null
  isSaving?: boolean
  onSubmit: (input: DimensionValueFormInput) => void | Promise<void>
  /** Rendered only when editing. The caller performs the DELETE and surfaces
   *  the retention-trigger error ("…arkivera det istället") as a toast. */
  onDelete?: () => void | Promise<void>
}

/**
 * Create/edit form for a dimension value (#OBJEKT), hosted in the
 * DimensionsManager dialog. Code is immutable in v1: the field is disabled
 * when editing. Start/end dates appear only for Projekt (dim 6), matching the
 * SIE model where projects span a date range while cost centres do not.
 */
export default function DimensionValueForm({
  dimension,
  value,
  isSaving = false,
  onSubmit,
  onDelete,
}: DimensionValueFormProps) {
  const t = useTranslations('dimensions')
  const isEditing = Boolean(value)
  const isProject = dimension.sie_dim_no === PROJECT_DIM_NO
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)

  const schema = useMemo(
    () =>
      z
        .object({
          // Legacy/backfilled codes can be looser than the strict format, so
          // the pattern is only enforced when the code is user-typed (create).
          code: isEditing
            ? z.string()
            : z.string().regex(DIMENSION_CODE_PATTERN, t('form_code_invalid')),
          name: z.string().min(1, t('form_name_invalid')).max(120, t('form_name_invalid')),
          is_active: z.boolean(),
          start_date: z.string().optional(),
          end_date: z.string().optional(),
        })
        .refine(
          (data) =>
            !data.start_date || !data.end_date || data.end_date >= data.start_date,
          { message: t('form_date_order_invalid'), path: ['end_date'] },
        ),
    [isEditing, t],
  )

  type FormData = z.infer<typeof schema>

  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      code: value?.code ?? '',
      name: value?.name ?? '',
      is_active: value?.is_active ?? true,
      start_date: value?.start_date ?? '',
      end_date: value?.end_date ?? '',
    },
  })

  function submit(data: FormData) {
    return onSubmit({
      code: data.code.trim(),
      name: data.name.trim(),
      is_active: data.is_active,
      start_date: isProject && data.start_date ? data.start_date : null,
      end_date: isProject && data.end_date ? data.end_date : null,
    })
  }

  return (
    <form onSubmit={handleSubmit(submit)} className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="dimension-value-code">{t('form_code_label')}</Label>
          <Input
            id="dimension-value-code"
            {...register('code')}
            disabled={isEditing}
            className="font-mono"
            autoComplete="off"
            autoFocus={!isEditing}
          />
          <p className="text-xs text-muted-foreground">
            {isEditing ? t('form_code_immutable_help') : t('form_code_help')}
          </p>
          {errors.code && (
            <p className="text-xs text-destructive">{errors.code.message}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="dimension-value-name">{t('form_name_label')}</Label>
          <Input
            id="dimension-value-name"
            {...register('name')}
            autoComplete="off"
            autoFocus={isEditing}
          />
          {errors.name && (
            <p className="text-xs text-destructive">{errors.name.message}</p>
          )}
        </div>
      </div>

      {isProject && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="dimension-value-start">{t('form_start_label')}</Label>
            <Input
              id="dimension-value-start"
              type="date"
              {...register('start_date')}
              className="tabular-nums"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="dimension-value-end">{t('form_end_label')}</Label>
            <Input
              id="dimension-value-end"
              type="date"
              {...register('end_date')}
              className="tabular-nums"
            />
            {errors.end_date && (
              <p className="text-xs text-destructive">{errors.end_date.message}</p>
            )}
          </div>
        </div>
      )}

      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Label htmlFor="dimension-value-active">{t('form_active_label')}</Label>
          <p className="text-xs text-muted-foreground max-w-md">
            {t('form_active_help')}
          </p>
        </div>
        <Controller
          name="is_active"
          control={control}
          render={({ field }) => (
            <Switch
              id="dimension-value-active"
              checked={field.value}
              onCheckedChange={field.onChange}
            />
          )}
        />
      </div>

      <div className="flex items-center justify-between gap-3 pt-2">
        {isEditing && onDelete ? (
          <Button
            type="button"
            variant="outline"
            className="text-destructive hover:text-destructive"
            disabled={isSaving}
            onClick={() => setConfirmDeleteOpen(true)}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            {t('form_delete')}
          </Button>
        ) : (
          <span />
        )}
        <Button type="submit" disabled={isSaving}>
          {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {isEditing ? t('form_save') : t('form_create')}
        </Button>
      </div>

      {onDelete && (
        <DestructiveConfirmDialog
          open={confirmDeleteOpen}
          onOpenChange={setConfirmDeleteOpen}
          title={t('delete_confirm_title')}
          description={t('delete_confirm_description', { code: value?.code ?? '' })}
          confirmLabel={t('delete_confirm_label')}
          cancelLabel={t('delete_cancel_label')}
          onConfirm={onDelete}
        />
      )}
    </form>
  )
}
