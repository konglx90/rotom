import { useEffect, useId, useRef } from 'react'
import type { InputHTMLAttributes, ReactNode } from 'react'
import styles from './Checkbox.module.css'

interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange' | 'checked'> {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: ReactNode
  disabled?: boolean
  indeterminate?: boolean
}

export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
  indeterminate,
  id,
  className = '',
  ...rest
}: CheckboxProps) {
  const autoId = useId()
  const inputId = id ?? autoId
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.indeterminate = !!indeterminate
    }
  }, [indeterminate])

  return (
    <label
      className={[styles.wrapper, disabled && styles.disabled, className].filter(Boolean).join(' ')}
      htmlFor={inputId}
    >
      <span className={[styles.box, checked && styles.boxChecked, indeterminate && styles.boxIndeterminate].filter(Boolean).join(' ')}>
        {checked && !indeterminate && (
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <polyline
              points="3 8 7 12 13 4"
              fill="none"
              stroke="var(--color-dark-green)"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
        {indeterminate && (
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <line
              x1="4"
              y1="8"
              x2="12"
              y2="8"
              stroke="var(--color-dark-green)"
              strokeWidth="2.5"
              strokeLinecap="round"
            />
          </svg>
        )}
      </span>
      {label && <span className={styles.label}>{label}</span>}
      <input
        ref={inputRef}
        id={inputId}
        type="checkbox"
        className={styles.input}
        checked={checked}
        disabled={disabled}
        onChange={e => onChange(e.target.checked)}
        {...rest}
      />
    </label>
  )
}
