import { useId } from 'react'
import type { InputHTMLAttributes, ReactNode } from 'react'
import styles from './Radio.module.css'

interface RadioProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange' | 'checked'> {
  checked: boolean
  onChange: (value: string) => void
  label?: ReactNode
  disabled?: boolean
  value: string
}

export function Radio({
  checked,
  onChange,
  label,
  disabled,
  value,
  id,
  className = '',
  ...rest
}: RadioProps) {
  const autoId = useId()
  const inputId = id ?? autoId

  return (
    <label
      className={[styles.wrapper, disabled && styles.disabled, className].filter(Boolean).join(' ')}
      htmlFor={inputId}
    >
      <span className={[styles.outer, checked && styles.outerChecked].filter(Boolean).join(' ')}>
        {checked && <span className={styles.dot} />}
      </span>
      {label && <span className={styles.label}>{label}</span>}
      <input
        id={inputId}
        type="radio"
        className={styles.input}
        checked={checked}
        disabled={disabled}
        value={value}
        onChange={() => onChange(value)}
        {...rest}
      />
    </label>
  )
}
