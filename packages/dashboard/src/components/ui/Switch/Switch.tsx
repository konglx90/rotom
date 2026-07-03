import { useId } from 'react'
import type { ReactNode } from 'react'
import styles from './Switch.module.css'

interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: ReactNode
  disabled?: boolean
  id?: string
  className?: string
  name?: string
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
  id,
  className = '',
  name,
}: SwitchProps) {
  const autoId = useId()
  const switchId = id ?? autoId

  return (
    <label
      className={[styles.wrapper, disabled && styles.disabled, className].filter(Boolean).join(' ')}
      htmlFor={switchId}
    >
      <span className={[styles.track, checked && styles.trackOn].filter(Boolean).join(' ')}>
        <span className={styles.knob} />
      </span>
      {label && <span className={styles.label}>{label}</span>}
      <input
        id={switchId}
        type="checkbox"
        role="switch"
        className={styles.input}
        checked={checked}
        disabled={disabled}
        name={name}
        onChange={e => onChange(e.target.checked)}
      />
    </label>
  )
}
