import React, { useState, useRef, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import ThemeToggle from './ThemeToggle'
import { useExportChat } from '../hooks/useExportChat'

function Chat({ user, onLogout, theme, toggleTheme }) {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [showAllCitations, setShowAllCitations] = useState(false)
  const messagesEndRef = useRef(null)
  const exportDropdownRef = useRef(null)

  // Custom hook para exportar chat
  const {
    showExportDropdown,
    setShowExportDropdown,
    exportAsMarkdown,
    exportAsPlainText,
    hasValidMessages,
  } = useExportChat(messages, user)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (
        exportDropdownRef.current &&
        !exportDropdownRef.current.contains(event.target)
      ) {
        setShowExportDropdown(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [setShowExportDropdown])

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!input.trim() || loading) return

    const userMessage = input.trim()
    setInput('')

    // Agregar mensaje del usuario
    const newMessages = [
      ...messages,
      {
        role: 'user',
        content: userMessage,
      },
    ]
    setMessages(newMessages)
    setLoading(true)

    try {
      const token = localStorage.getItem('token')
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          message: userMessage,
          conversationHistory: newMessages,
        }),
      })

      const data = await response.json()

      if (response.ok) {
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: data.message,
            citations: data.citations,
          },
        ])
      } else {
        setMessages((prev) => [
          ...prev,
          {
            role: 'error',
            content: data.error || 'Error processing query',
          },
        ])
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          role: 'error',
          content: 'Connection error with server',
        },
      ])
    } finally {
      setLoading(false)
    }
  }

  const clearChat = () => {
    setMessages([])
  }

  const CustomLink = (props) => {
    return React.createElement(
      'a',
      {
        href: props.href,
        className: 'text-blue-600 dark:text-blue-400 hover:underline',
        target: '_blank',
        rel: 'noopener noreferrer',
      },
      props.children
    )
  }

  const markdownComponents = {
    p: (props) =>
      React.createElement('p', { className: 'mb-3 last:mb-0' }, props.children),
    strong: (props) =>
      React.createElement(
        'strong',
        { className: 'font-semibold' },
        props.children
      ),
    ul: (props) =>
      React.createElement(
        'ul',
        { className: 'list-disc pl-5 mb-3 space-y-1' },
        props.children
      ),
    ol: (props) =>
      React.createElement(
        'ol',
        { className: 'list-decimal pl-5 mb-3 space-y-1' },
        props.children
      ),
    li: (props) =>
      React.createElement('li', { className: 'mb-1' }, props.children),
    h1: (props) =>
      React.createElement(
        'h1',
        { className: 'text-xl font-bold mb-2 mt-4' },
        props.children
      ),
    h2: (props) =>
      React.createElement(
        'h2',
        { className: 'text-lg font-bold mb-2 mt-3' },
        props.children
      ),
    h3: (props) =>
      React.createElement(
        'h3',
        { className: 'text-base font-bold mb-2 mt-2' },
        props.children
      ),
    code: (props) => {
      const isInline = !props.className
      if (isInline) {
        return React.createElement(
          'code',
          {
            className:
              'bg-gray-100 dark:bg-gray-700 px-1 py-0.5 rounded text-sm',
          },
          props.children
        )
      }
      return React.createElement(
        'code',
        {
          className:
            'block bg-gray-100 dark:bg-gray-700 p-2 rounded text-sm mb-2',
        },
        props.children
      )
    },
    a: CustomLink,
  }

  return (
    <div className='h-screen flex flex-col bg-gray-50 dark:bg-gray-900'>
      {/* Header */}
      <div className='bg-white dark:bg-gray-800 shadow-sm border-b border-gray-200 dark:border-gray-700 px-6 py-4'>
        <div className='max-w-5xl mx-auto flex justify-between items-center'>
          <div>
            <h1 className='text-2xl font-bold text-gray-900 dark:text-white'>
              ACTS Law RAG
            </h1>
            <p className='text-sm text-gray-600 dark:text-gray-400 mt-1'>
              User: <span className='font-medium'>{user.name}</span> | Access to
              cases:{' '}
              <span className='font-medium'>{user.cases.join(', ')}</span>
            </p>
          </div>
          <div className='flex gap-3 items-center'>
            <ThemeToggle theme={theme} toggleTheme={toggleTheme} />

            {/* Export Button with Dropdown */}
            <div className='relative' ref={exportDropdownRef}>
              <button
                onClick={() => setShowExportDropdown(!showExportDropdown)}
                disabled={!hasValidMessages()}
                className='px-4 py-2 text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-md hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed'
              >
                📥 Export Chat
              </button>

              {showExportDropdown && (
                <div className='absolute right-0 mt-2 w-48 bg-white dark:bg-gray-800 rounded-md shadow-lg border border-gray-200 dark:border-gray-700 z-10'>
                  <button
                    onClick={exportAsMarkdown}
                    className='w-full text-left px-4 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors rounded-t-md'
                  >
                    📝 Markdown (.md)
                  </button>
                  <button
                    onClick={exportAsPlainText}
                    className='w-full text-left px-4 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors rounded-b-md'
                  >
                    📄 Plain Text (.txt)
                  </button>
                </div>
              )}
            </div>

            <button
              onClick={clearChat}
              className='px-4 py-2 text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-md hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors'
            >
              Clear Chat
            </button>
            <button
              onClick={onLogout}
              className='px-4 py-2 text-white bg-red-600 rounded-md hover:bg-red-700 transition-colors'
            >
              Sign Out
            </button>
          </div>
        </div>
      </div>

      {/* Messages Area */}
      <div className='flex-1 overflow-y-auto bg-gray-50 dark:bg-gray-900 px-6 py-6'>
        <div className='max-w-5xl mx-auto space-y-6'>
          {messages.length === 0 ? (
            <div className='text-center py-12'>
              <div className='text-6xl mb-4'>💬</div>
              <h2 className='text-2xl font-semibold text-gray-700 dark:text-gray-300 mb-2'>
                Welcome to the Legal Assistant
              </h2>
              <p className='text-gray-600 dark:text-gray-400 mb-6'>
                Ask a question about the case documents
              </p>
              <div className='grid grid-cols-1 md:grid-cols-2 gap-3 max-w-2xl mx-auto'>
                {[
                  'What information is available about Mitra Farokhpay?',
                  'What is the property address?',
                  'What types of legal documents are available?',
                  'Who is Wilshire Regent Homeowners Association?',
                ].map((suggestion, i) => (
                  <button
                    key={i}
                    onClick={() => setInput(suggestion)}
                    className='text-left p-3 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 hover:border-blue-500 dark:hover:border-blue-400 hover:shadow-md transition-all text-sm text-gray-900 dark:text-gray-100'
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((msg, index) => (
              <div
                key={index}
                className={`flex ${
                  msg.role === 'user' ? 'justify-end' : 'justify-start'
                }`}
              >
                <div
                  className={`max-w-3xl rounded-lg px-4 py-3 ${
                    msg.role === 'user'
                      ? 'bg-blue-600 text-white'
                      : msg.role === 'error'
                      ? 'bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-400 border border-red-200 dark:border-red-800'
                      : 'bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 shadow-sm border border-gray-200 dark:border-gray-700'
                  }`}
                >
                  {msg.role === 'assistant' && (
                    <div className='flex items-center gap-2 mb-2 pb-2 border-b border-gray-200 dark:border-gray-700'>
                      <span className='text-xl'>🤖</span>
                      <span className='font-semibold text-sm'>
                        Legal Assistant
                      </span>
                    </div>
                  )}
                  <div className='prose prose-sm dark:prose-invert max-w-none'>
                    {msg.role === 'assistant' ? (
                      <ReactMarkdown components={markdownComponents}>
                        {msg.content}
                      </ReactMarkdown>
                    ) : (
                      msg.content
                    )}
                  </div>
                  {msg.citations && msg.citations.length > 0 && (
                    <div className='mt-3 pt-3 border-t border-gray-200 dark:border-gray-700'>
                      <p className='text-xs font-semibold text-gray-600 dark:text-gray-400 mb-2'>
                        📎 References ({msg.citations.length}):
                      </p>
                      <div className='space-y-2'>
                        {msg.citations
                          .slice(
                            0,
                            showAllCitations[index] ? msg.citations.length : 5
                          )
                          .map((citation, i) => (
                            <div
                              key={i}
                              className='text-xs bg-gray-50 dark:bg-gray-700/50 p-2 rounded'
                            >
                              <div className='font-medium text-gray-900 dark:text-gray-100'>
                                {i + 1}. {citation.title}
                              </div>
                              {citation.filepath && (
                                <div className='text-gray-500 dark:text-gray-400 mt-1 font-mono text-[10px] break-all overflow-hidden'>
                                  📁 {citation.filepath}
                                </div>
                              )}
                            </div>
                          ))}
                        {msg.citations.length > 5 && (
                          <button
                            onClick={() =>
                              setShowAllCitations((prev) => ({
                                ...prev,
                                [index]: !prev[index],
                              }))
                            }
                            className='text-xs text-blue-600 dark:text-blue-400 hover:underline mt-2 font-medium'
                          >
                            {showAllCitations[index]
                              ? '↑ Show less'
                              : `↓ Show all ${msg.citations.length} references`}
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
          {loading && (
            <div className='flex justify-start'>
              <div className='bg-white dark:bg-gray-800 rounded-lg px-4 py-3 shadow-sm border border-gray-200 dark:border-gray-700'>
                <div className='flex items-center gap-2'>
                  <div className='animate-pulse text-2xl'>💭</div>
                  <span className='text-gray-600 dark:text-gray-400'>
                    Thinking...
                  </span>
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input Area */}
      <div className='bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 px-6 py-4'>
        <form onSubmit={handleSubmit} className='max-w-5xl mx-auto'>
          <div className='flex gap-3'>
            <input
              type='text'
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder='Type your question about the case...'
              className='flex-1 px-4 py-3 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400'
              disabled={loading}
            />
            <button
              type='submit'
              disabled={loading || !input.trim()}
              className='px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-blue-300 dark:disabled:bg-blue-800 disabled:cursor-not-allowed transition-colors font-medium'
            >
              {loading ? '⏳' : '📤'} Send
            </button>
          </div>
          <p className='text-xs text-gray-500 dark:text-gray-400 mt-2'>
            🔒 You can only access information from cases:{' '}
            {user.cases.join(', ')}
          </p>
        </form>
      </div>
    </div>
  )
}

export default Chat
