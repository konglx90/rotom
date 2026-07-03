import type { ReactNode } from 'react'
import styles from './Field.module.css'

interface FieldProps {
  label?: string
  required?: boolean
  helperText?: string
  error?: string
  htmlFor?: string
  children: ReactNode
  className?: string
}

export function Field({
  label,
  required,
  helperText,
  error,
  htmlFor,
  children,
  className = '',
}: FieldProps) {
  const containerClasses = [styles.container, className].filter(Boolean).join(' ')

  return (
    <div className={containerClasses} data-field={error ? 'error' : undefined}>
      {label && (
        <label className={styles.label} htmlFor={htmlFor}>
          {label}
          {required && <span className={styles.required} aria-hidden="true"> *</span>}
        </label>
      )}
      {children}
      {error ? (
        <span className={styles.errorText}>{error}</span>
      ) : helperText ? (
        <span className={styles.helperText}>{helperText}</span>
      ) : null}
    </div>
  )
}
