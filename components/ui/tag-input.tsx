'use client'

import * as React from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

interface TagInputProps {
  value?: string
  onChange?: (value: string) => void
  placeholder?: string
  className?: string
  disabled?: boolean
}

const TagInput = React.forwardRef<HTMLInputElement, TagInputProps>(
  ({ value = '', onChange, placeholder, className, disabled }, ref) => {
    const [inputValue, setInputValue] = React.useState('')
    const inputRef = React.useRef<HTMLInputElement>(null)

    React.useImperativeHandle(ref, () => inputRef.current!)

    const tags = React.useMemo(
      () =>
        value
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
      [value]
    )

    function commitTag(raw: string) {
      const trimmed = raw.trim()
      if (!trimmed) return
      const next = [...tags, trimmed].join(', ')
      onChange?.(next)
      setInputValue('')
    }

    function removeTag(index: number) {
      const next = tags.filter((_, i) => i !== index).join(', ')
      onChange?.(next)
    }

    function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault()
        commitTag(inputValue)
      } else if (
        e.key === 'Backspace' &&
        inputValue === '' &&
        tags.length > 0
      ) {
        removeTag(tags.length - 1)
      }
    }

    function handleBlur() {
      if (inputValue.trim()) {
        commitTag(inputValue)
      }
    }

    function handlePaste(e: React.ClipboardEvent<HTMLInputElement>) {
      const pasted = e.clipboardData.getData('text')
      if (pasted.includes(',')) {
        e.preventDefault()
        const newTags = pasted
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
        const next = [...tags, ...newTags].join(', ')
        onChange?.(next)
        setInputValue('')
      }
    }

    return (
      <div
        className={cn(
          'flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-md border border-input bg-transparent px-3 py-1.5 text-sm transition-colors',
          'focus-within:ring-1 focus-within:ring-ring',
          disabled && 'cursor-not-allowed opacity-50',
          className
        )}
        onClick={() => inputRef.current?.focus()}
      >
        {tags.map((tag, i) => (
          <span
            key={`${tag}-${i}`}
            className="inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground"
          >
            {tag}
            {!disabled && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  removeTag(i)
                }}
                className="rounded-sm opacity-60 hover:opacity-100 focus:outline-none"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          onPaste={handlePaste}
          placeholder={tags.length === 0 ? placeholder : undefined}
          disabled={disabled}
          className="min-w-[80px] flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
        />
      </div>
    )
  }
)
TagInput.displayName = 'TagInput'

export { TagInput }
