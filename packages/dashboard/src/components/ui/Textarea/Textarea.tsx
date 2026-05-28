import type { TextareaHTMLAttributes } from 'react'
import styles from './Textarea.module.css'

export type TextareaSize = 'sm' | 'md'

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string
  error?: string
  helperText?: string
  size?: TextareaSize
  /** 占位接口：未来实现自动伸高；当前为 noop，textarea 仍可通过 rows / CSS resize 调整 */
  autoSize?: boolean
}

export function Textarea({
  label,
  error,
  helperText,
  size = 'md',
  autoSize: _autoSize,
  className = '',
  ...props
}: TextareaProps) {
  const classes = [
    styles.textarea,
    styles[size],
    error && styles.error,
    className,
  ].filter(Boolean).join(' ')

  return (
    <div className={styles.container}>
      {label && <label className={styles.label}>{label}</label>}
      <textarea className={classes} {...props} />
      {error ? (
        <span className={styles.errorText}>{error}</span>
      ) : helperText ? (
        <span className={styles.helperText}>{helperText}</span>
      ) : null}
    </div>
  )
}
