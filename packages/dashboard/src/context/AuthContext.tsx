import { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import { api } from '../api/client'
import { authApi } from '../api/auth'

interface AuthContextType {
  isAuthenticated: boolean
  isPreview: boolean
  login: (username: string, password: string) => Promise<void>
  enterPreview: () => Promise<void>
  logout: () => void
  loading: boolean
  error: string | null
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

// 解 JWT payload 看 sub。base64url decode 不做严格校验——这里只是给 UI 看的提示,
// 真正的访问控制在后端中间件。
function decodeSub(token: string): string | undefined {
  try {
    const part = token.split('.')[1]
    if (!part) return undefined
    const padded = part.replace(/-/g, '+').replace(/_/g, '/')
    const json = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
    const payload = JSON.parse(json) as { sub?: string }
    return payload.sub
  } catch {
    return undefined
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [isPreview, setIsPreview] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Check for existing token on mount
  useEffect(() => {
    const token = api.getToken()
    if (token) {
      setIsAuthenticated(true)
      setIsPreview(decodeSub(token) === 'preview')
    }
    setLoading(false)
  }, [])

  const login = async (username: string, password: string) => {
    setError(null)
    setLoading(true)
    try {
      const { token } = await authApi.login(username, password)
      api.setToken(token)
      setIsAuthenticated(true)
      setIsPreview(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Login failed'
      setError(message)
      setIsAuthenticated(false)
      setIsPreview(false)
      throw err
    } finally {
      setLoading(false)
    }
  }

  const enterPreview = async () => {
    setError(null)
    setLoading(true)
    try {
      const { token } = await authApi.previewLogin()
      api.setToken(token)
      setIsAuthenticated(true)
      setIsPreview(true)
    } catch (err) {
      const message = err instanceof Error ? err.message : '进入预览失败'
      setError(message)
      throw err
    } finally {
      setLoading(false)
    }
  }

  const logout = () => {
    authApi.logout()
    setIsAuthenticated(false)
    setIsPreview(false)
    setError(null)
  }

  return (
    <AuthContext.Provider value={{ isAuthenticated, isPreview, login, enterPreview, logout, loading, error }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider')
  }
  return context
}
