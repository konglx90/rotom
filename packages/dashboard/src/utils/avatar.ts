const AVATAR_BG_COLORS = [
  'ff6b6b', 'ffd93d', '6bcf7f', '4d96ff', '9b59b6',
  'ff8a65', '4dd0e1', 'aed581', 'f06292', '7986cb',
];

function hashString(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash)
  }
  return hash
}

export function getAvatarUrl(name: string): string {
  const color = AVATAR_BG_COLORS[Math.abs(hashString(name)) % AVATAR_BG_COLORS.length]
  return `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(name)}&backgroundColor=${color}`
}

export function getAvatarColor(name: string): string {
  const colors = [
    '#4285f4', '#34a853', '#fbbc05', '#ea4335',
    '#9c27b0', '#00bcd4', '#ff5722', '#607d8b',
  ]
  return colors[Math.abs(hashString(name)) % colors.length]
}
