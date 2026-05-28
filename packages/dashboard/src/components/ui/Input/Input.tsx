import type { InputHTMLAttributes } from 'react'
import styles from './Input.module.css'

export type InputSize = 'sm' | 'md'

interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: string
  error?: string
  helperText?: string
  size?: InputSize
}

export function Input({ label, error, helperText, size = 'md', className = '', ...props }: InputProps) {
  const classes = [
    styles.input,
    styles[size],
    error && styles.error,
    className,
  ].filter(Boolean).join(' ')

  return (
    <div className={styles.container}>
      {label && <label className={styles.label}>{label}</label>}
      <input className={classes} {...props} />
      {error ? (
        <span className={styles.errorText}>{error}</span>
      ) : helperText ? (
        <span className={styles.helperText}>{helperText}</span>
      ) : null}
    </div>
  )
}
