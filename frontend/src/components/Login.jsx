import React, { useState } from 'react'
import API_URL from '../apiConfig'
import ThemeToggle from './ThemeToggle'
import { FaSignInAlt } from 'react-icons/fa'
import { FaMicrosoft } from 'react-icons/fa'
import { signInWithMicrosoft } from '../firebase/config'

function Login({ onLogin, theme, toggleTheme }) {
  // CAMBIO 1: Estado para username en vez de email
  const [username, setUsername] = useState('') 
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const response = await fetch(`${API_URL}/api/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        // CAMBIO 2: Enviamos username y password
        body: JSON.stringify({ username, password }),
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

  const handleMicrosoftLogin = async () => {
    // ... (Esta función queda igual, el login de Microsoft sigue siendo útil)
    setError('')
    setLoading(true)
    try {
      const result = await signInWithMicrosoft()
      if (!result.success) {
         setError(result.error || 'Error logging in')
         setLoading(false)
         return
      }
      const idToken = await result.user.getIdToken()
      const response = await fetch(`${API_URL}/api/auth/microsoft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      })
      const data = await response.json()
      if (response.ok && data.success) {
        onLogin(data.user, data.token)
      } else {
        setError(data.message || 'Authentication failed')
      }
    } catch (err) {
      setError('Error with Microsoft authentication')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className='min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800'>
      <div className='fixed top-4 right-4'>
        <ThemeToggle theme={theme} toggleTheme={toggleTheme} />
      </div>

      <div className='max-w-md w-full space-y-8'>
        <div className='text-center'>
          <h1 className='text-4xl font-bold text-gray-900 dark:text-white mb-2'>
            ACTS Law AI 🤖
          </h1>
          <p className='text-gray-600 dark:text-gray-400'>
            Smart Advocate Integration
          </p>
        </div>

        <div className='bg-white dark:bg-gray-800 shadow-md rounded-lg p-8'>
          <button
            onClick={handleMicrosoftLogin}
            disabled={loading}
            className='w-full bg-white dark:bg-gray-700 text-gray-900 dark:text-white py-3 px-4 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-600 border-2 border-gray-200 dark:border-gray-600 shadow-sm mb-6 flex items-center justify-center gap-3'
          >
             <FaMicrosoft className='text-[#00A4EF]' />
             <span>Sign in with Microsoft</span>
          </button>

          <div className='relative my-6'>
            <div className='absolute inset-0 flex items-center'>
              <div className='w-full border-t border-gray-300 dark:border-gray-600'></div>
            </div>
            <div className='relative flex justify-center text-sm'>
              <span className='px-2 bg-white dark:bg-gray-800 text-gray-500'>
                Or sign in with SA User
              </span>
            </div>
          </div>

          <form onSubmit={handleSubmit} className='space-y-6'>
            <div>
              <label
                htmlFor='username'
                className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'
              >
                SA Username
              </label>
              {/* CAMBIO 3: Input de Username */}
              <input
                id='username'
                type='text'
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className='w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white'
                placeholder='Username'
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
                className='w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white'
                placeholder='••••••••'
              />
            </div>

            {error && (
              <div className='bg-red-50 dark:bg-red-900/30 border border-red-200 text-red-700 dark:text-red-400 px-4 py-3 rounded-md text-sm'>
                {error}
              </div>
            )}

            <button
              type='submit'
              disabled={loading}
              className='w-full bg-blue-600 text-white py-2 px-4 rounded-md hover:bg-blue-700 transition-colors font-medium flex items-center justify-center gap-2'
            >
              {loading ? 'Verifying...' : 'Sign In'} <FaSignInAlt />
            </button>
          </form>

        </div>
      </div>
    </div>
  )
}

export default Login