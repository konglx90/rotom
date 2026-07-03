import { forwardRef, useId } from 'react'
import type { TextareaHTMLAttributes } from 'react'
import { Field } from '../Field/Field'
import styles from './Textarea.module.css'

export type TextareaSize = 'sm' | 'md'

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string
  required?: boolean
  error?: string
  helperText?: string
  size?: TextareaSize
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, required, error, helperText, size = 'md', id, className = '', ...props },
  ref,
) {
  const autoId = useId()
  const textareaId = id ?? autoId

  const classes = [
    styles.textarea,
    styles[size],
    error && styles.error,
    className,
  ].filter(Boolean).join(' ')

  return (
    <Field label={label} required={required} error={error} helperText={helperText} htmlFor={textareaId}>
      <textarea id={textareaId} ref={ref} className={classes} {...props} />
    </Field>
  )
})
