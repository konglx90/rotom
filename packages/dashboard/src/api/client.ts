/**
 * API Client for A2A Gateway Dashboard
 * Handles authentication and HTTP requests to the backend API
 */

export class ApiClient {
  private baseUrl: string
  private token: string | null = null

  constructor(baseUrl: string = '/api') {
    this.baseUrl = baseUrl
  }

  setToken(token: string): void {
    this.token = token
    // Store in localStorage for persistence
    if (typeof window !== 'undefined') {
      localStorage.setItem('auth_token', token)
    }
  }

  clearToken(): void {
    this.token = null
    if (typeof window !== 'undefined') {
      localStorage.removeItem('auth_token')
    }
  }

  getToken(): string | null {
    if (!this.token && typeof window !== 'undefined') {
      this.token = localStorage.getItem('auth_token')
    }
    return this.token
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
    }

    // Add authorization header if token exists
    const token = this.getToken()
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }

    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        ...options,
        headers,
      })

      // Handle 401 Unauthorized - token expired or invalid
      if (response.status === 401) {
        this.clearToken()
        throw new Error('Authentication failed. Please login again.')
      }

      // Handle 403 in preview mode: writes are rejected by the server even
      // though the token is valid. UI should mark write controls disabled,
      // but this is the safety net for any control we missed.
      if (response.status === 403) {
        let msg = '预览模式下无法执行写操作'
        try {
          const data = JSON.parse(await response.clone().text()) as { error?: string }
          if (data?.error) msg = data.error
        } catch { /* ignore */ }
        throw new Error(msg)
      }

      // Safely parse JSON response
      let data: T | undefined
      const text = await response.text()
      if (text) {
        try {
          data = JSON.parse(text)
        } catch {
          throw new Error(`Server returned non-JSON response (HTTP ${response.status})`)
        }
      }

      // Check for API errors
      if (!response.ok) {
        throw new Error(
          (data as Record<string, string>)?.error || `HTTP ${response.status}: ${response.statusText}`
        )
      }

      return data as T
    } catch (error) {
      if (error instanceof Error) {
        throw error
      }
      throw new Error('Network error: Failed to connect to the server')
    }
  }

  async get<T>(endpoint: string): Promise<T> {
    return this.request<T>(endpoint, { method: 'GET' })
  }

  async post<T>(endpoint: string, data?: unknown): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'POST',
      body: data ? JSON.stringify(data) : undefined,
    })
  }

  async put<T>(endpoint: string, data?: unknown): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'PUT',
      body: data ? JSON.stringify(data) : undefined,
    })
  }

  async patch<T>(endpoint: string, data?: unknown): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'PATCH',
      body: data ? JSON.stringify(data) : undefined,
    })
  }

  async delete<T>(endpoint: string, data?: unknown): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'DELETE',
      body: data ? JSON.stringify(data) : undefined,
    })
  }
}

// Create singleton instance
export const api = new ApiClient()
