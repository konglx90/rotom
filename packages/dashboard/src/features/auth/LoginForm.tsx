import { useState, FormEvent } from 'react'
import { useAuth } from '../../context/AuthContext'
import { Button } from '../../components/ui/Button/Button'
import { Input } from '../../components/ui/Input/Input'
import styles from './LoginForm.module.css'

export function LoginForm() {
  const { login, loading, error } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    try {
      await login(username, password)
    } catch (err) {
      // Error is handled by AuthContext
    }
  }

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <h1 className={styles.title}>A2A Gateway Dashboard</h1>
        <p className={styles.subtitle}>Digital Employee Mesh Management</p>

        <form onSubmit={handleSubmit} className={styles.form}>
          <Input
            type="text"
            label="用户名"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="请输入用户名"
            required
            autoFocus
          />
          <Input
            type="password"
            label="密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="请输入密码"
            required
          />

          {error && (
            <div className={styles.error}>
              {error}
            </div>
          )}

          <Button
            type="submit"
            variant="primary"
            size="lg"
            disabled={loading || !username || !password}
            className={styles.button}
          >
            {loading ? '登录中...' : '登录'}
          </Button>
        </form>

        <div className={styles.footer}>
          <p>默认凭证: admin / admin123</p>
        </div>
      </div>
    </div>
  )
}
