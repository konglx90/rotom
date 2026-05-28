import type { ButtonHTMLAttributes, ReactNode } from 'react'
import styles from './Button.module.css'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'success' | 'danger'
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** 透明底 + 描边文字色变体；只对 primary/success/danger 生效 */
  outline?: boolean
  /** 方形 padding，给单字符 ×/+/⚙️ 用 */
  iconOnly?: boolean
  /** disable 并显示忙碌态；当前最小实现仅 disable */
  loading?: boolean
  children: ReactNode
}

export function Button({
  variant = 'secondary',
  size = 'md',
  outline = false,
  iconOnly = false,
  loading = false,
  disabled,
  className = '',
  children,
  ...rest
}: ButtonProps) {
  const classes = [
    styles.button,
    styles[variant],
    styles[size],
    outline && (variant === 'primary' || variant === 'success' || variant === 'danger') && styles.outline,
    iconOnly && styles.iconOnly,
    className,
  ].filter(Boolean).join(' ')

  return (
    <button className={classes} disabled={disabled || loading} {...rest}>
      {children}
    </button>
  )
}
