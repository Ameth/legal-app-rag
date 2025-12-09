import React, { useState } from 'react'
import ThemeToggle from './ThemeToggle'
import { FaSignInAlt } from 'react-icons/fa'
import { FaMicrosoft } from 'react-icons/fa' // Nuevo icono
import { signInWithMicrosoft } from '../firebase/config' // Importar función

function Login({ onLogin, theme, toggleTheme }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email, password }),
      })

      const data = await response.json()

      if (response.ok) {
        onLogin(data.user, data.token)
      } else {
        setError(data.error || 'Error logging in')
      }
    } catch (err) {
      setError('Connection error. Verify that the backend is running.')
    } finally {
      setLoading(false)
    }
  }

  // Nueva función para login con Microsoft
  const handleMicrosoftLogin = async () => {
    setError('')
    setLoading(true)

    try {
      const result = await signInWithMicrosoft()

      if (!result.success) {
        setError(result.error || 'Error logging in with Microsoft')
        setLoading(false)
        return
      }

      // Obtener el ID token del usuario autenticado
      const idToken = await result.user.getIdToken()

      // Enviar el token al backend para validación
      const response = await fetch('/api/auth/microsoft', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ idToken }),
      })

      const data = await response.json()

      if (response.ok && data.success) {
        // Autenticación exitosa
        onLogin(data.user, data.token)
      } else {
        // Error de autenticación
        setError(data.message || data.error || 'Authentication failed')
      }
    } catch (err) {
      console.error('Microsoft login error:', err)
      setError('Error with Microsoft authentication. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const demoUsers = [
    {
      email: 'acohen@actslaw.com',
      name: 'Alexander Cohen',
      cases: ['25092', '25096', '25160'],
    },
    {
      email: 'dabir@actslaw.com',
      name: 'Danny Abir',
      cases: ['25092', '25096'],
    },
    {
      email: 'ldowney@actslaw.com',
      name: 'Lindsey Downey',
      cases: ['25092', '25096'],
    },
    {
      email: 'apoberezhskiy@actslaw.com',
      name: 'Alex Poberezhskiy',
      cases: ['25096'],
    },
    {
      email: 'steichberg@actslaw.com',
      name: 'Samuel Teichberg',
      cases: ['25092', '25096'],
    },
  ]

  return (
    <div className='min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800'>
      <div className='fixed top-4 right-4'>
        <ThemeToggle theme={theme} toggleTheme={toggleTheme} />
      </div>

      <div className='max-w-md w-full space-y-8'>
        <div className='text-center'>
          <h1 className='text-4xl font-bold text-gray-900 dark:text-white mb-2'>
            ACTS Law RAG
          </h1>
          <p className='text-gray-600 dark:text-gray-400'>
            Legal query system with access control
          </p>
        </div>

        <div className='bg-white dark:bg-gray-800 shadow-md rounded-lg p-8'>
          {/* Botón de Microsoft Login */}
          <button
            onClick={handleMicrosoftLogin}
            disabled={loading}
            className='w-full bg-white dark:bg-gray-700 text-gray-900 dark:text-white py-3 px-4 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 font-semibold flex items-center justify-center gap-3 border-2 border-gray-200 dark:border-gray-600 shadow-sm hover:shadow-md mb-6'
          >
            <div className='w-5 h-5 flex items-center justify-center'>
              <FaMicrosoft className='text-lg text-[#00A4EF]' />
            </div>
            <span>{loading ? 'Signing in...' : 'Sign in with Microsoft'}</span>
          </button>

          {/* Divisor */}
          <div className='relative my-6'>
            <div className='absolute inset-0 flex items-center'>
              <div className='w-full border-t border-gray-300 dark:border-gray-600'></div>
            </div>
            <div className='relative flex justify-center text-sm'>
              <span className='px-2 bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-400'>
                Or continue with email
              </span>
            </div>
          </div>

          <form onSubmit={handleSubmit} className='space-y-6'>
            <div>
              <label
                htmlFor='email'
                className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'
              >
                Email
              </label>
              <input
                id='email'
                type='email'
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className='w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white dark:bg-gray-700 text-gray-900 dark:text-white'
                placeholder='user@actslaw.com'
              />
            </div>

            <div>
              <label
                htmlFor='password'
                className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'
              >
                Password
              </label>
              <input
                id='password'
                type='password'
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className='w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white dark:bg-gray-700 text-gray-900 dark:text-white'
                placeholder='••••••••'
              />
            </div>

            {error && (
              <div className='bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 px-4 py-3 rounded-md text-sm'>
                {error}
              </div>
            )}

            <button
              type='submit'
              disabled={loading}
              className='w-full bg-blue-600 text-white py-2 px-4 rounded-md hover:bg-blue-700 disabled:bg-blue-300 dark:disabled:bg-blue-800 disabled:cursor-not-allowed transition-colors font-medium flex items-center justify-center gap-2'
            >
              {loading ? 'Signing in...' : 'Sign In'} <FaSignInAlt />
            </button>
          </form>

          <div className='mt-6 pt-6 border-t border-gray-200 dark:border-gray-700'>
            <p className='text-sm text-gray-600 dark:text-gray-400 mb-3 font-medium'>
              Demo users (password: password123):
            </p>
            <div className='space-y-2'>
              {demoUsers.map((user, index) => (
                <div
                  key={index}
                  onClick={() => {
                    setEmail(user.email)
                    setPassword('test123')
                  }}
                  className='text-sm bg-gray-50 dark:bg-gray-700 p-2 rounded cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors'
                >
                  <span className='font-medium text-blue-600 dark:text-blue-400'>
                    {user.name || user.email}
                  </span>
                  <span className='text-gray-500 dark:text-gray-400 text-xs ml-2'>
                    (Cases: {user.cases.join(', ')})
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default Login
