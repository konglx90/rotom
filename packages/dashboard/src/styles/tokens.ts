// Design System Tokens — Wise-inspired (TS 对应 tokens.css)
export const colors = {
  // Brand
  wiseGreen: '#9fe870',
  wiseGreenHover: '#cdffad',
  darkGreen: '#163300',
  mint: '#e2f6d5',
  positive: '#054d28',

  // Canvas / text
  ink: '#0e0f0c',
  warmDark: '#454745',
  gray: '#868685',
  softSurface: '#e8ebe6',
  canvas: '#faf9f4',
  surface: '#ffffff',

  // Semantic
  warning: '#ffd11a',
  error: '#d03238',
  success: '#054d28',
  brightOrange: '#ffc091',

  // Legacy aliases (兼容旧代码)
  navy: '#0e0f0c',
  slate: '#454745',
  sage: '#054d28',
  background: '#faf9f4',
  info: '#054d28',
  accent: '#9fe870',
  'accent-dim': 'rgba(159, 232, 112, 0.18)',
  green: '#054d28',
  'green-dim': '#e2f6d5',
  teal: '#054d28',
  red: '#d03238',
  'red-dim': 'rgba(208, 50, 56, 0.08)',
} as const

export const spacing = {
  xs: '4px',
  sm: '8px',
  md: '16px',
  lg: '24px',
  xl: '32px',
  '2xl': '48px',
  '3xl': '64px',
} as const

export const borderRadius = {
  sm: '10px',
  DEFAULT: '16px',
  md: '16px',
  lg: '24px',
  xl: '30px',
  '2xl': '40px',
  pill: '9999px',
  full: '9999px',
} as const

export const fontSize = {
  xs: '12px',
  sm: '14px',
  base: '16px',
  lg: '18px',
  xl: '20px',
  '2xl': '24px',
  '3xl': '32px',
  '4xl': '40px',
  display: '64px',
  hero: '96px',
  mega: '126px',
} as const

export const shadows = {
  ring: 'rgba(14, 15, 12, 0.12) 0 0 0 1px',
  ringStrong: 'rgba(14, 15, 12, 0.24) 0 0 0 1px',
  inset: 'rgb(134, 134, 133) 0 0 0 1px inset',
  // legacy aliases
  sm: 'rgba(14, 15, 12, 0.12) 0 0 0 1px',
  DEFAULT: 'rgba(14, 15, 12, 0.12) 0 0 0 1px',
  md: 'rgba(14, 15, 12, 0.12) 0 0 0 1px',
  lg: 'rgba(14, 15, 12, 0.24) 0 0 0 1px',
} as const
