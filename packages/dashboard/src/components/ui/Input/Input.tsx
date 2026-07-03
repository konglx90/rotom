import { forwardRef, useId } from 'react'
import type { InputHTMLAttributes } from 'react'
import { Field } from '../Field/Field'
import styles from './Input.module.css'

export type InputSize = 'sm' | 'md'

interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: string
  required?: boolean
  error?: string
  helperText?: string
  size?: InputSize
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, required, error, helperText, size = 'md', id, className = '', ...props },
  ref,
) {
  const autoId = useId()
  const inputId = id ?? autoId

  const classes = [
    styles.input,
    styles[size],
    error && styles.error,
    className,
  ].filter(Boolean).join(' ')

  return (
    <Field label={label} required={required} error={error} helperText={helperText} htmlFor={inputId}>
      <input id={inputId} ref={ref} className={classes} {...props} />
    </Field>
  )
})
