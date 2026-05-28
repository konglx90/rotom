import type { ReactNode, SelectHTMLAttributes } from 'react'
import styles from './Select.module.css'

export type SelectSize = 'sm' | 'md'

interface SelectOption {
  value: string
  label: string
}

interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  label?: string
  error?: string
  helperText?: string
  size?: SelectSize
  options?: SelectOption[]
  children?: ReactNode
}

export function Select({
  label,
  error,
  helperText,
  size = 'md',
  options,
  children,
  className = '',
  ...props
}: SelectProps) {
  const classes = [
    styles.select,
    styles[size],
    error && styles.error,
    className,
  ].filter(Boolean).join(' ')

  return (
    <div className={styles.container}>
      {label && <label className={styles.label}>{label}</label>}
      <select className={classes} {...props}>
        {options
          ? options.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))
          : children}
      </select>
      {error ? (
        <span className={styles.errorText}>{error}</span>
      ) : helperText ? (
        <span className={styles.helperText}>{helperText}</span>
      ) : null}
    </div>
  )
}
