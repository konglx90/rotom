// Design System Tokens based on DESIGN.md
export const colors = {
  // Primary
  navy: '#0F172A',
  slate: '#64748B',
  sage: '#059669',

  // Backgrounds
  background: '#F8FAFC',
  surface: '#FFFFFF',

  // Status
  success: '#22C55E',
  warning: '#EAB308',
  error: '#EF4444',
  info: '#0EA5E9',

  // Legacy compatibility
  accent: '#6c8cff',
  'accent-dim': 'rgba(108, 140, 255, 0.1)',
  green: '#059669',
  'green-dim': 'rgba(5, 150, 105, 0.1)',
  teal: '#0d9488',
  red: '#ef4444',
  'red-dim': 'rgba(239, 68, 68, 0.1)',
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
  sm: '4px',
  DEFAULT: '8px',
  md: '12px',
  lg: '16px',
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
} as const

export const shadows = {
  sm: '0 1px 3px rgba(15, 23, 42, 0.03)',
  DEFAULT: '0 2px 6px rgba(15, 23, 42, 0.05)',
  md: '0 4px 16px rgba(15, 23, 42, 0.07)',
  lg: '0 8px 32px rgba(15, 23, 42, 0.1)',
} as const
