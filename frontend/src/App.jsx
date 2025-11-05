import { useState, useEffect } from 'react'
import Login from './components/Login'
import Chat from './components/Chat'
import { useTheme } from './hooks/useTheme'

function App() {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const { theme, toggleTheme } = useTheme()

  useEffect(() => {
    const token = localStorage.getItem('token')
    if (token) {
      fetch('/api/me', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      })
        .then(res => res.json())
        .then(data => {
          if (data.email) {
            setUser(data)
          } else {
            localStorage.removeItem('token')
          }
        })
        .catch(() => {
          localStorage.removeItem('token')
        })
        .finally(() => {
          setLoading(false)
        })
    } else {
      setLoading(false)
    }
  }, [])

  const handleLogin = (userData, token) => {
    localStorage.setItem('token', token)
    setUser(userData)
  }

  const handleLogout = () => {
    localStorage.removeItem('token')
    setUser(null)
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <div className="text-xl text-gray-600 dark:text-gray-300">Cargando...</div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      {user ? (
        <Chat user={user} onLogout={handleLogout} theme={theme} toggleTheme={toggleTheme} />
      ) : (
        <Login onLogin={handleLogin} theme={theme} toggleTheme={toggleTheme} />
      )}
    </div>
  )
}

export default App