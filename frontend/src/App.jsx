import { useState, useEffect } from 'react'
import Login from './components/Login'
import Chat from './components/Chat'
import { useTheme } from './hooks/useTheme'
import { signOut as firebaseSignOut } from './firebase/config'

function App() {
  const [user, setUser] = useState(null)
  const [token, setToken] = useState(null)
  const [loading, setLoading] = useState(true)
  const { theme, toggleTheme } = useTheme()

  // Verificar sesión al cargar la app
  useEffect(() => {
    const storedToken = localStorage.getItem('token')
    const storedUser = localStorage.getItem('user')

    if (storedToken && storedUser) {
      try {
        const parsedUser = JSON.parse(storedUser)

        // Verificar que el token siga siendo válido
        fetch('/api/me', {
          headers: {
            Authorization: `Bearer ${storedToken}`,
          },
        })
          .then((res) => {
            if (res.ok) {
              return res.json()
            }
            throw new Error('Invalid token')
          })
          .then((data) => {
            if (data.email) {
              // Token válido, restaurar sesión
              setToken(storedToken)
              setUser({
                ...data,
                photoURL: parsedUser.photoURL || null, // Preservar foto si existe
              })
            } else {
              // Token inválido
              throw new Error('Invalid user data')
            }
          })
          .catch((error) => {
            console.error('Session restoration failed:', error)
            // Limpiar todo si hay error
            localStorage.removeItem('token')
            localStorage.removeItem('user')
            setToken(null)
            setUser(null)
          })
          .finally(() => {
            setLoading(false)
          })
      } catch (error) {
        console.error('Error parsing stored user:', error)
        localStorage.removeItem('token')
        localStorage.removeItem('user')
        setLoading(false)
      }
    } else {
      setLoading(false)
    }
  }, [])

  const handleLogin = (userData, authToken) => {
    // Guardar en localStorage
    localStorage.setItem('token', authToken)
    localStorage.setItem('user', JSON.stringify(userData))

    // Actualizar estado
    setToken(authToken)
    setUser(userData)
  }

  const handleLogout = async () => {
    try {
      // Intentar cerrar sesión de Firebase (si está autenticado con Microsoft)
      await firebaseSignOut()
      console.log('✅ Firebase session closed')
    } catch (error) {
      console.log('ℹ️ No Firebase session to close')
    }

    // Limpiar localStorage
    localStorage.removeItem('token')
    localStorage.removeItem('user')

    // Limpiar estado
    setToken(null)
    setUser(null)

    console.log('✅ Session closed successfully')
  }

  if (loading) {
    return (
      <div className='min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800'>
        <div className='text-center'>
          <div className='animate-spin rounded-full h-16 w-16 border-b-4 border-blue-600 mx-auto mb-4'></div>
          <div className='text-xl text-gray-600 dark:text-gray-300 font-medium'>
            Loading...
          </div>
          <div className='text-sm text-gray-500 dark:text-gray-400 mt-2'>
            Verifying your session
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className='min-h-screen bg-gray-50 dark:bg-gray-900'>
      {user && token ? (
        <Chat
          user={user}
          onLogout={handleLogout}
          theme={theme}
          toggleTheme={toggleTheme}
        />
      ) : (
        <Login onLogin={handleLogin} theme={theme} toggleTheme={toggleTheme} />
      )}
    </div>
  )
}

export default App
