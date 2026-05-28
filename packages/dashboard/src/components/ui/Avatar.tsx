import { useState } from 'react'
import { getAvatarUrl, getAvatarColor } from '../../utils/avatar'
import styles from './Avatar.module.css'

interface AvatarProps {
  name: string
  size?: number
  className?: string
}

export function Avatar({ name, size = 36, className }: AvatarProps) {
  const [failed, setFailed] = useState(false)

  if (failed) {
    return (
      <div
        className={`${styles.fallback} ${className || ''}`}
        style={{
          width: size,
          height: size,
          background: getAvatarColor(name),
          fontSize: size * 0.4,
        }}
        title={name}
      >
        {name.charAt(0).toUpperCase()}
      </div>
    )
  }

  return (
    <img
      src={getAvatarUrl(name)}
      alt={name}
      className={`${styles.avatar} ${className || ''}`}
      style={{ width: size, height: size }}
      onError={() => setFailed(true)}
    />
  )
}
