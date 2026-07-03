import { useId } from 'react'
import type { ReactNode } from 'react'
import { Radio } from '../Radio/Radio'
import styles from './RadioGroup.module.css'

export interface RadioGroupOption {
  value: string
  label: ReactNode
  disabled?: boolean
}

interface RadioGroupProps {
  name?: string
  value: string
  onChange: (value: string) => void
  options: RadioGroupOption[]
  label?: string
  orientation?: 'horizontal' | 'vertical'
  className?: string
}

export function RadioGroup({
  name,
  value,
  onChange,
  options,
  label,
  orientation = 'vertical',
  className = '',
}: RadioGroupProps) {
  const groupId = useId()
  const groupName = name ?? groupId

  return (
    <fieldset
      className={[styles.group, styles[orientation], className].filter(Boolean).join(' ')}
    >
      {label && <legend className={styles.legend}>{label}</legend>}
      <div className={styles.options}>
        {options.map(opt => (
          <Radio
            key={opt.value}
            name={groupName}
            value={opt.value}
            checked={value === opt.value}
            onChange={onChange}
            disabled={opt.disabled}
            label={opt.label}
          />
        ))}
      </div>
    </fieldset>
  )
}
