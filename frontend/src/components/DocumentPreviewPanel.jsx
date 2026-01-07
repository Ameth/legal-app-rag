import React, { useState, useEffect, useRef } from 'react'
import { pdfjs } from 'react-pdf'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'
import API_URL from '../apiConfig' // <--- IMPORTANTE: Importamos la configuración

// Configurar worker de PDF.js
pdfjs.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.min.js`

export default function DocumentPreviewPanel({ document, onClose, token }) {
  const [content, setContent] = useState(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (document) {
      loadDocument()
    }
  }, [document])

  const loadDocument = async () => {
    setIsLoading(true)
    setError(null)

    try {
      const tokenParts = token.split('.')
      const payload = JSON.parse(atob(tokenParts[1]))
      const sessionId = payload.sessionId

      // ELIMINADO: La lógica manual de localhost
      // const isDev = import.meta.env.DEV
      // const baseUrl = isDev ? 'http://localhost:3001' : ''

      // 🚀 OPTIMIZACIÓN: Si ya viene blobPath, hacer fetch directo
      if (document.blobPath) {
        console.log('⚡ Using blobPath from index:', document.blobPath)

        // USAMOS API_URL AQUÍ
        const metadataResponse = await fetch(
          `${API_URL}/api/documents/get-url`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              filename: document.title,
              blobPath: document.blobPath,
            }),
          }
        )

        const metadata = await metadataResponse.json()

        if (!metadataResponse.ok) {
          console.error('❌ Error loading document:', metadata.error)
          if (metadata.error && metadata.error.includes('not found')) {
            throw new Error(
              `Document not found: ${document.title}\n\nThe file may have been moved or deleted from blob storage.`
            )
          }
          throw new Error(metadata.error || 'Could not load document')
        }

        if (!metadata.url) {
          throw new Error('No valid URL returned from server')
        }

        // USAMOS API_URL PARA EL PROXY TAMBIÉN
        const proxyUrl = `${API_URL}/api/proxy/${sessionId}/${encodeURIComponent(
          metadata.filename
        )}`

        console.log('✅ Document loaded successfully:', metadata.filename)

        setContent({
          url: metadata.url,
          proxyUrl: proxyUrl,
          metadata: metadata.metadata,
          blobPath: metadata.blobPath,
        })

        setIsLoading(false)
        return
      }

      // 🐢 FALLBACK: Sin blobPath (casos raros)
      console.log('🐢 No blobPath, searching by filename...')

      // USAMOS API_URL AQUÍ
      const metadataResponse = await fetch(`${API_URL}/api/documents/get-url`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          filename: document.title,
        }),
      })

      const metadata = await metadataResponse.json()

      if (!metadataResponse.ok) {
        console.error('❌ Error loading document:', metadata.error)
        if (metadata.error && metadata.error.includes('not found')) {
          throw new Error(
            `Document not found: ${document.title}\n\nThe file may have been moved or deleted from blob storage.`
          )
        }
        throw new Error(metadata.error || 'Could not load document')
      }

      if (!metadata.url) {
        throw new Error('No valid URL returned from server')
      }

      // USAMOS API_URL AQUÍ
      const proxyUrl = `${API_URL}/api/proxy/${sessionId}/${encodeURIComponent(
        metadata.filename
      )}`

      console.log('✅ Document loaded successfully:', metadata.filename)

      setContent({
        url: metadata.url,
        proxyUrl: proxyUrl,
        metadata: metadata.metadata,
        blobPath: metadata.blobPath,
      })
    } catch (err) {
      console.error('❌ Error loading document:', err)
      setError(err.message)
    } finally {
      setIsLoading(false)
    }
  }

  const getFileExtension = () => {
    if (!document?.title) return ''
    return document.title.split('.').pop().toLowerCase()
  }

  const renderContent = () => {
    if (isLoading || !content) {
      return (
        <div className='flex items-center justify-center h-full'>
          <div className='animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600'></div>
        </div>
      )
    }

    if (content.error) {
      return (
        <div className='flex items-center justify-center h-full p-8'>
          <div className='text-center'>
            <h3 className='text-lg font-semibold text-red-600 dark:text-red-400'>
              Error al cargar el documento
            </h3>
            <p className='text-sm text-gray-500 dark:text-gray-400 mt-2'>
              {content.error}
            </p>
          </div>
        </div>
      )
    }

    const filename = document.title || 'document'
    const lowerFilename = filename.toLowerCase()

    const isPdf = lowerFilename.endsWith('.pdf')
    const isEmail = lowerFilename.endsWith('.msg')
    const isOfficeDoc = lowerFilename.match(/\.(docx|doc|xlsx|xls|pptx|ppt)$/i)

    if (isEmail) {
      return <EmailViewer url={content.url} filename={filename} token={token} />
    }

    if (isOfficeDoc) {
      const officeViewerUrl = `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(
        content.url
      )}`
      return (
        <iframe
          src={officeViewerUrl}
          width='100%'
          height='100%'
          frameBorder='0'
          title='Office Document Viewer'
          className='bg-white'
        />
      )
    }

    if (isPdf) {
      return (
        <PDFViewer
          url={content.url}
          proxyUrl={content.proxyUrl}
          filename={filename}
          searchTerms={document.searchTerms}
          contextSnippets={document.contextSnippets}
        />
      )
    }

    return (
      <TextFileViewer
        url={content.proxyUrl || content.url}
        filename={filename}
        token={token}
      />
    )
  }

  const formatFileSize = (bytes) => {
    if (!bytes) return 'Unknown size'
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  }

  if (!document) return null

  return (
    <div className='fixed right-0 top-0 h-full w-2/5 bg-white dark:bg-gray-800 shadow-2xl border-l border-gray-200 dark:border-gray-700 z-50 flex flex-col animate-slide-in'>
      <div className='p-4 border-b border-gray-200 dark:border-gray-700 flex items-start justify-between bg-gray-50 dark:bg-gray-900'>
        <div className='flex-1 min-w-0 pr-4'>
          <h2 className='text-lg font-semibold text-gray-900 dark:text-white truncate mb-1'>
            📄 {document.title}
          </h2>
          {content?.metadata && (
            <div className='flex flex-wrap gap-3 text-xs text-gray-500 dark:text-gray-400'>
              <span>📦 {formatFileSize(content.metadata.size)}</span>
              {content.metadata.lastModified && (
                <span>
                  📅{' '}
                  {new Date(content.metadata.lastModified).toLocaleDateString()}
                </span>
              )}
              {content.metadata.contentType && (
                <span>🏷️ {content.metadata.contentType}</span>
              )}
            </div>
          )}
          {content?.blobPath && (
            <p className='text-xs text-gray-400 dark:text-gray-500 mt-1 font-mono truncate'>
              ⚡ {content.blobPath}
            </p>
          )}
        </div>
        <button
          onClick={onClose}
          className='flex-shrink-0 p-2 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-lg transition-colors text-gray-700 dark:text-gray-200'
          title='Close preview'
        >
          <span className='text-xl'>✕</span>
        </button>
      </div>

      <div className='flex-1 overflow-auto'>{renderContent()}</div>

      {content?.url && !error && (
        <div className='p-4 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 flex gap-2'>
          <a
            href={content.url}
            download={document.title}
            target='_blank'
            rel='noreferrer'
            className='flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-center font-medium text-sm'
          >
            📥 Download
          </a>
          <button
            onClick={() => {
              const ext = getFileExtension()
              let urlToOpen

              if (
                ext === 'docx' ||
                ext === 'doc' ||
                ext === 'xlsx' ||
                ext === 'xls'
              ) {
                urlToOpen = `https://view.officeapps.live.com/op/view.aspx?src=${encodeURIComponent(
                  content.url
                )}`
              } else {
                urlToOpen = content.proxyUrl
              }

              window.open(urlToOpen, '_blank')
            }}
            className='flex-1 px-4 py-2 bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-white rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors font-medium text-sm'
          >
            🔗 Open in New Tab
          </button>
        </div>
      )}
    </div>
  )
}

// Componente PDF Viewer
function PDFViewer({ url, filename, searchTerms, contextSnippets, proxyUrl }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [showContext, setShowContext] = useState(true)

  const relevantSnippets =
    contextSnippets?.filter(
      (s) =>
        s.source === filename ||
        s.source.includes(filename.split('.')[0]) ||
        filename.includes(s.source.split('.')[0])
    ) || []

  // 🔥 Usar proxyUrl si existe, sino usar url directa
  const pdfUrl = proxyUrl || url

  console.log('📄 Loading PDF from:', pdfUrl)

  return (
    <div className='h-full flex flex-col bg-gray-100 dark:bg-gray-900'>
      {relevantSnippets.length > 0 && showContext && (
        <div className='bg-blue-50 dark:bg-blue-900/30 border-b border-blue-200 dark:border-blue-800 p-3 max-h-48 overflow-y-auto'>
          <div className='flex items-start justify-between mb-2'>
            <span className='text-sm font-medium text-blue-800 dark:text-blue-200'>
              📝 Relevant context found in this document:
            </span>
            <button
              onClick={() => setShowContext(false)}
              className='text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-200'
            >
              ✕
            </button>
          </div>
          <div className='space-y-2'>
            {relevantSnippets.map((snippet, i) => (
              <div
                key={i}
                className='bg-white dark:bg-gray-800 rounded p-2 text-xs'
              >
                <p className='text-gray-700 dark:text-gray-300'>
                  ...{snippet.beforeContext}{' '}
                  <mark className='bg-yellow-300 dark:bg-yellow-600 px-1 rounded font-semibold'>
                    {snippet.term}
                  </mark>{' '}
                  {snippet.afterContext}...
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {loading && (
        <div className='absolute inset-0 flex items-center justify-center bg-white dark:bg-gray-900 z-10'>
          <div className='text-center'>
            <div className='animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4'></div>
            <p className='text-gray-600 dark:text-gray-400'>Loading PDF...</p>
          </div>
        </div>
      )}

      <iframe
        src={pdfUrl}
        className='w-full flex-1 border-0'
        title={filename}
        onLoad={() => {
          console.log('✅ PDF loaded successfully')
          setLoading(false)
        }}
        onError={(e) => {
          console.error('❌ PDF iframe error:', e)
          setError('Failed to load PDF')
          setLoading(false)
        }}
      />

      {error && (
        <div className='absolute inset-0 flex items-center justify-center bg-white dark:bg-gray-900'>
          <div className='p-4'>
            <div className='bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4'>
              <p className='text-red-800 dark:text-red-200 font-medium mb-2'>
                ⚠️ Error loading PDF
              </p>
              <p className='text-red-600 dark:text-red-400 text-sm'>{error}</p>
              <p className='text-xs text-gray-600 dark:text-gray-400 mt-2'>
                Try downloading the file instead.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// Componente Text File Viewer
function TextFileViewer({ url, token }) {
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error('Failed to load file')
        return res.text()
      })
      .then((data) => {
        setText(data)
        setLoading(false)
      })
      .catch((err) => {
        console.error('Error loading text file:', err)
        setText('Error loading file content: ' + err.message)
        setLoading(false)
      })
  }, [url, token])

  if (loading) {
    return (
      <div className='flex items-center justify-center h-full'>
        <div className='animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600'></div>
      </div>
    )
  }

  return (
    <div className='p-6 h-full overflow-auto bg-white dark:bg-gray-900'>
      <pre className='whitespace-pre-wrap text-sm font-mono text-gray-800 dark:text-gray-200 leading-relaxed'>
        {text}
      </pre>
    </div>
  )
}

// Componente Email Viewer
function EmailViewer({ url, filename, token }) {
  const [emailData, setEmailData] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setEmailData({
      filename: filename,
      message:
        'Email file detected. Download to view in Outlook or email client.',
    })
    setLoading(false)
  }, [url, filename])

  if (loading) {
    return (
      <div className='flex items-center justify-center h-full'>
        <div className='animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600'></div>
      </div>
    )
  }

  return (
    <div className='p-6'>
      <div className='bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-6'>
        <div className='text-6xl mb-4 text-center'>📧</div>
        <h3 className='text-lg font-semibold text-blue-900 dark:text-blue-100 mb-2'>
          Outlook Email Message
        </h3>
        <p className='text-blue-700 dark:text-blue-300 text-sm mb-4'>
          {emailData.message}
        </p>
        <div className='bg-white dark:bg-gray-800 rounded p-3 text-sm font-mono text-gray-600 dark:text-gray-400 break-all'>
          {filename}
        </div>
        <p className='text-xs text-blue-600 dark:text-blue-400 mt-4'>
          💡 Tip: Click "Download" below to open this email in Outlook
        </p>
      </div>
    </div>
  )
}
