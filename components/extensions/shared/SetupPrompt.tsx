'use client'

import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Settings } from 'lucide-react'
import { useState } from 'react'

interface SetupField {
  key: string
  label: string
  type?: 'number' | 'text'
  placeholder?: string
}

interface SetupPromptProps {
  title: string
  description: string
  fields: SetupField[]
  onSave: (values: Record<string, string>) => Promise<void>
}

export default function SetupPrompt({ title, description, fields, onSave }: SetupPromptProps) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [isSaving, setIsSaving] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSaving(true)
    try {
      await onSave(values)
    } finally {
      setIsSaving(false)
    }
  }

  const allFilled = fields.every(f => values[f.key]?.trim())

  return (
    <div className="flex items-center justify-center py-12">
      <Card className="w-full max-w-md">
        <CardContent className="pt-6">
          <div className="text-center mb-6">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-muted mb-3">
              <Settings className="h-6 w-6 text-muted-foreground" />
            </div>
            <h3 className="font-semibold">{title}</h3>
            <p className="text-sm text-muted-foreground mt-1">{description}</p>
          </div>
          <form onSubmit={handleSubmit} className="space-y-4">
            {fields.map(field => (
              <div key={field.key} className="space-y-2">
                <Label htmlFor={`setup-${field.key}`}>{field.label}</Label>
                <Input
                  id={`setup-${field.key}`}
                  type={field.type ?? 'text'}
                  placeholder={field.placeholder}
                  value={values[field.key] ?? ''}
                  onChange={e => setValues(prev => ({ ...prev, [field.key]: e.target.value }))}
                />
              </div>
            ))}
            <Button type="submit" className="w-full" disabled={!allFilled || isSaving}>
              {isSaving ? 'Sparar...' : 'Kom igång'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
