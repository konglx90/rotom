import { forwardRef, useId } from 'react'
import type { ReactNode, SelectHTMLAttributes } from 'react'
import { Field } from '../Field/Field'
import styles from './Select.module.css'

export type SelectSize = 'sm' | 'md'

export interface SelectOption {
  value: string
  label: string
}

interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  label?: string
  required?: boolean
  error?: string
  helperText?: string
  size?: SelectSize
  options?: SelectOption[]
  children?: ReactNode
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, required, error, helperText, size = 'md', options, children, id, className = '', ...props },
  ref,
) {
  const autoId = useId()
  const selectId = id ?? autoId

  const classes = [
    styles.select,
    styles[size],
    error && styles.error,
    className,
  ].filter(Boolean).join(' ')

  return (
    <Field label={label} required={required} error={error} helperText={helperText} htmlFor={selectId}>
      <select id={selectId} ref={ref} className={classes} {...props}>
        {options
          ? options.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))
          : children}
      </select>
    </Field>
  )
})
