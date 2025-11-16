import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import jwt from 'jsonwebtoken'
import fs from 'fs'
import { AIProjectClient } from '@azure/ai-projects'
import { DefaultAzureCredential } from '@azure/identity'
import { AzureKeyCredential } from '@azure/core-auth'
import {
  BlobServiceClient,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
  StorageSharedKeyCredential,
} from '@azure/storage-blob'

dotenv.config()

const app = express()
const PORT = process.env.PORT || 3001

// Middleware
app.use(cors())
app.use(express.json())

// ===== PERMISSIONS MANAGEMENT =====
const PERMISSIONS_FILE = './permissions-cache.json'
let userPermissions = {}
let permissionsMetadata = {}

/**
 * Carga los permisos desde el archivo JSON
 */
function loadPermissions() {
  try {
    if (!fs.existsSync(PERMISSIONS_FILE)) {
      console.warn(
        '⚠️  No se encontró permissions-cache.json. Usando permisos demo.'
      )
      return loadDemoPermissions()
    }

    const data = JSON.parse(fs.readFileSync(PERMISSIONS_FILE, 'utf-8'))

    userPermissions = data.permissions
    permissionsMetadata = data.metadata

    // Agregar passwords temporales para testing
    Object.keys(userPermissions).forEach((email) => {
      if (!userPermissions[email].password) {
        userPermissions[email].password = 'test123'
      }
    })

    console.log('\n✅ Permisos cargados exitosamente:')
    console.log(`   📊 Total usuarios: ${Object.keys(userPermissions).length}`)
    console.log(`   📁 Total casos: ${permissionsMetadata.totalCases}`)
    console.log(
      `   🕐 Última sincronización: ${new Date(
        permissionsMetadata.lastSync
      ).toLocaleString()}`
    )
    console.log(`   🔑 Password temporal para testing: test123`)

    return true
  } catch (error) {
    console.error('❌ Error cargando permisos:', error.message)
    console.warn('⚠️  Usando permisos demo como respaldo')
    return loadDemoPermissions()
  }
}

/**
 * Permisos demo para desarrollo/pruebas
 */
function loadDemoPermissions() {
  userPermissions = {
    'abogado1@actslaw.com': {
      password: 'password123',
      cases: ['25092', '25096'],
      name: 'Attorney 1',
    },
    'abogado2@actslaw.com': {
      password: 'password123',
      cases: ['25092'],
      name: 'Attorney 2',
    },
    'abogado3@actslaw.com': {
      password: 'password123',
      cases: ['25097'],
      name: 'Attorney 3',
    },
    'cliente@example.com': {
      password: 'password123',
      cases: ['25092'],
      name: 'Demo Client',
    },
    'admin@actslaw.com': {
      password: 'admin123',
      cases: ['*'], // Access to all cases
      name: 'Administrator',
    },
  }

  permissionsMetadata = {
    lastSync: new Date().toISOString(),
    totalUsers: Object.keys(userPermissions).length,
    totalCases: 3,
    mode: 'DEMO',
  }

  return false
}

/**
 * Recarga los permisos desde el archivo (útil para actualizaciones)
 */
function reloadPermissions() {
  console.log('\n🔄 Recargando permisos...')
  loadPermissions()
}

// Cargar permisos al iniciar
loadPermissions()

// ===== AZURE AI FOUNDRY CONFIGURATION =====
const AZURE_AI_PROJECT_ENDPOINT = process.env.AZURE_AI_PROJECT_ENDPOINT
const AZURE_AGENT_ID = process.env.AZURE_AGENT_ID
const AZURE_AI_PROJECT_KEY = process.env.AZURE_AI_PROJECT_KEY

// Inicializar cliente de Azure AI Foundry
let aiProjectClient
try {
  // Opción 1: Si hay API Key, usarla (más simple y directo)
  if (AZURE_AI_PROJECT_KEY) {
    aiProjectClient = new AIProjectClient(
      AZURE_AI_PROJECT_ENDPOINT,
      new AzureKeyCredential(AZURE_AI_PROJECT_KEY)
    )
    console.log('✅ Azure AI Foundry client initialized with API Key')
  }
  // Opción 2: Si no hay API Key, usar DefaultAzureCredential
  else {
    aiProjectClient = new AIProjectClient(
      AZURE_AI_PROJECT_ENDPOINT,
      new DefaultAzureCredential()
    )
    console.log(
      '✅ Azure AI Foundry client initialized with DefaultAzureCredential'
    )
  }
} catch (error) {
  console.error('❌ Error initializing Azure AI Foundry client:', error.message)
  console.error('   Solutions:')
  console.error(
    '   1. Add AZURE_AI_PROJECT_KEY to your .env file (RECOMMENDED)'
  )
  console.error(
    '   2. Or run "az login" if you want to use DefaultAzureCredential'
  )
}

// ===== AZURE BLOB STORAGE CONFIGURATION =====
const AZURE_STORAGE_CONNECTION_STRING =
  process.env.AZURE_STORAGE_CONNECTION_STRING
const AZURE_CONTAINER_NAME =
  process.env.AZURE_CONTAINER_NAME || 'testragdocuments'

let blobServiceClient
let containerClient

try {
  if (AZURE_STORAGE_CONNECTION_STRING) {
    blobServiceClient = BlobServiceClient.fromConnectionString(
      AZURE_STORAGE_CONNECTION_STRING
    )
    containerClient = blobServiceClient.getContainerClient(AZURE_CONTAINER_NAME)
    console.log(
      `✅ Azure Blob Storage client initialized for container: ${AZURE_CONTAINER_NAME}`
    )
  } else {
    console.warn(
      '⚠️  AZURE_STORAGE_CONNECTION_STRING not found - document preview will not work'
    )
  }
} catch (error) {
  console.error(
    '❌ Error initializing Azure Blob Storage client:',
    error.message
  )
}

// ===== UTILITIES =====
const JWT_SECRET = process.env.JWT_SECRET

// Store active threads per user session (in production, use Redis or similar)
const userThreads = new Map()

/**
 * Get or create thread for user session
 */
async function getOrCreateThread(sessionId) {
  if (userThreads.has(sessionId)) {
    console.log(`   ♻️  Reusing existing thread: ${userThreads.get(sessionId)}`)
    return userThreads.get(sessionId)
  }

  console.log('   🆕 Creating new thread...')
  const thread = await aiProjectClient.agents.threads.create()
  userThreads.set(sessionId, thread.id)
  console.log(`   ✅ Thread created: ${thread.id}`)
  return thread.id
}

/**
 * Delete thread for user session
 */
async function deleteThread(sessionId) {
  if (userThreads.has(sessionId)) {
    const threadId = userThreads.get(sessionId)
    try {
      await aiProjectClient.agents.threads.delete(threadId)
      userThreads.delete(sessionId)
      console.log(`   🗑️  Thread deleted: ${threadId}`)
      return true
    } catch (error) {
      console.error(`   ⚠️  Error deleting thread: ${error.message}`)
      userThreads.delete(sessionId)
      return false
    }
  }
  return false
}

/**
 * Run agent conversation and wait for completion
 */
async function runAgentConversation(threadId, userMessage, userCases) {
  try {
    // Add user's allowed cases to the message context
    const contextMessage = userCases.includes('*')
      ? userMessage
      : `[User has access to cases: ${userCases.join(', ')}]\n\n${userMessage}`

    // Create message in thread
    await aiProjectClient.agents.messages.create(
      threadId,
      'user',
      contextMessage
    )

    console.log('   📩 Message added to thread')

    // Create and run the agent
    let run = await aiProjectClient.agents.runs.create(threadId, AZURE_AGENT_ID)
    console.log(`   🏃 Run started: ${run.id}`)

    // Poll until completion
    let iterations = 0
    const maxIterations = 60 // 60 seconds timeout

    while (run.status === 'queued' || run.status === 'in_progress') {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      run = await aiProjectClient.agents.runs.get(threadId, run.id)
      iterations++

      if (iterations >= maxIterations) {
        throw new Error('Agent run timeout after 60 seconds')
      }

      if (iterations % 5 === 0) {
        console.log(`   ⏳ Still processing... (${iterations}s)`)
      }
    }

    console.log(`   ✅ Run completed with status: ${run.status}`)

    if (run.status === 'failed') {
      throw new Error(
        `Agent run failed: ${run.lastError?.message || 'Unknown error'}`
      )
    }

    // Get the latest messages for the assistant's response
    const messages = await aiProjectClient.agents.messages.list(threadId, {
      order: 'desc',
      limit: 1,
    })

    let assistantMessage = ''
    let messageAnnotations = []

    for await (const message of messages) {
      if (message.role === 'assistant') {
        for (const content of message.content) {
          if (content.type === 'text' && 'text' in content) {
            assistantMessage = content.text.value

            // Extract annotations from the message
            if (
              content.text.annotations &&
              content.text.annotations.length > 0
            ) {
              messageAnnotations = content.text.annotations
              console.log(
                `   📎 Found ${messageAnnotations.length} annotations in message`
              )
            }
          }
        }
        break
      }
    }

    // Extract citations from annotations
    console.log('   📋 Extracting citations from annotations...')
    let citations = []

    if (messageAnnotations.length > 0) {
      for (const annotation of messageAnnotations) {
        try {
          let citationInfo = {
            title: 'Reference',
            content: '',
            filepath: null,
          }

          // Check for url_citation type (Azure AI Search results)
          if (annotation.type === 'url_citation' && annotation.urlCitation) {
            citationInfo.title =
              annotation.urlCitation.title ||
              annotation.urlCitation.url ||
              'Document Reference'
            citationInfo.filepath = annotation.urlCitation.url
            citationInfo.content = `Document from Azure AI Search`

            console.log(`   ✅ Extracted citation: ${citationInfo.title}`)
            console.log(`   📂 Filepath: ${citationInfo.filepath}`)
          }
          // Check for file_citation type (file-based search)
          else if (
            annotation.type === 'file_citation' &&
            annotation.file_citation
          ) {
            const fileId = annotation.file_citation.file_id
            const quote = annotation.file_citation.quote || ''

            citationInfo.content = quote
            citationInfo.filepath = fileId

            // Try to extract filename from quote
            const filenamePattern =
              /\b\d{5}_\d{8}_\d+\.txt\b|\b[\w-]+\.(txt|pdf|msg|docx)\b/gi
            const filenameMatch = quote.match(filenamePattern)

            if (filenameMatch && filenameMatch[0]) {
              citationInfo.title = filenameMatch[0]
            } else {
              citationInfo.title = quote.substring(0, 50) || fileId
            }

            console.log(`   ✅ Extracted citation: ${citationInfo.title}`)
          }
          // Check for file_path type
          else if (annotation.type === 'file_path' && annotation.file_path) {
            citationInfo.title =
              annotation.file_path.file_id || 'File Reference'
            citationInfo.filepath = annotation.file_path.file_id
          }
          // Fallback: Use annotation text
          else if (annotation.text) {
            citationInfo.title = annotation.text.substring(0, 100)
            citationInfo.content = annotation.text
          }

          citations.push(citationInfo)
        } catch (error) {
          console.error('   ⚠️  Error processing annotation:', error.message)
        }
      }
    }

    // Also try to extract from "Documents Consulted:" section if agent followed instructions
    const docsPattern = /\*\*Documents Consulted:\*\*\s*\n((?:[-•]\s*.+\n?)+)/i
    const docsMatch = assistantMessage.match(docsPattern)

    if (docsMatch) {
      console.log('   ✅ Found "Documents Consulted" section')
      const docsList = docsMatch[1]
      const docLines = docsList.match(/[-•]\s*(.+)/g)

      if (docLines) {
        docLines.forEach((line) => {
          const docName = line.replace(/^[-•]\s*/, '').trim()
          if (docName && docName.length > 0) {
            // Avoid duplicates
            if (!citations.some((c) => c.title === docName)) {
              citations.push({
                title: docName,
                content: 'Document consulted by agent',
                filepath: docName,
              })
            }
          }
        })
      }
    }

    console.log(`   📎 Total citations extracted: ${citations.length}`)

    // Clean the message:
    // 1. Remove annotation markers like 【3:0†source】
    // 2. Remove the "Documents Consulted:" section (we already extracted it)
    let cleanMessage = assistantMessage
      .replace(/【[^】]*】/g, '') // Remove 【...】 markers
      .replace(/---\s*\*\*Documents Consulted:\*\*[\s\S]*?---/gi, '') // Remove Documents Consulted section
      .replace(/\*\*Documents Consulted:\*\*[\s\S]*$/i, '') // Remove if at the end without ---
      .trim()

    return {
      message: cleanMessage,
      citations: citations,
    }
  } catch (error) {
    console.error('   ❌ Error in agent conversation:', error.message)
    throw error
  }
}

// ===== ENDPOINTS =====

// Login
app.post('/api/login', (req, res) => {
  const { email, password } = req.body
  const normalizedEmail = email.toLowerCase().trim()

  const user = userPermissions[normalizedEmail]

  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' })
  }

  // Si el usuario viene del sistema real (no tiene password), permitir login
  // En producción, aquí deberías validar contra tu sistema de autenticación real
  const isRealUser = !user.password
  const isDemoUser = user.password && user.password === password

  if (!isRealUser && !isDemoUser) {
    return res.status(401).json({ error: 'Invalid credentials' })
  }

  // Generate JWT with session ID
  const sessionId = `${normalizedEmail}-${Date.now()}`
  const token = jwt.sign(
    {
      email: normalizedEmail,
      name: user.name,
      cases: user.cases,
      sessionId: sessionId,
    },
    JWT_SECRET,
    { expiresIn: '24h' }
  )

  res.json({
    token,
    user: {
      email: normalizedEmail,
      name: user.name,
      cases: user.cases,
    },
  })
})

// Authentication middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization']
  const token = authHeader && authHeader.split(' ')[1]

  if (!token) {
    return res.status(401).json({ error: 'Token required' })
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid token' })
    }
    req.user = user
    next()
  })
}

// Chat endpoint using Azure AI Foundry Agent
app.post('/api/chat', authenticateToken, async (req, res) => {
  try {
    const { message, clearThread } = req.body
    const userCases = req.user.cases
    const sessionId = req.user.sessionId

    if (!message) {
      return res.status(400).json({ error: 'Message required' })
    }

    console.log(`\n${'='.repeat(60)}`)
    console.log(`🤖 AGENT CHAT REQUEST`)
    console.log(`User: ${req.user.email} (${req.user.name})`)
    console.log(`Session: ${sessionId}`)
    console.log(`Allowed Cases: ${userCases.join(', ')}`)
    console.log(`Question: ${message}`)
    console.log(`Clear Thread: ${clearThread || false}`)
    console.log(`${'='.repeat(60)}\n`)

    // Si se solicita limpiar thread, eliminar el actual
    if (clearThread) {
      await deleteThread(sessionId)
    }

    // Obtener o crear thread para esta sesión
    const threadId = await getOrCreateThread(sessionId)

    // Ejecutar conversación con el agente
    console.log('🤖 Running agent conversation...')
    const response = await runAgentConversation(threadId, message, userCases)

    console.log(`✅ Agent response received\n`)

    res.json(response)
  } catch (error) {
    console.error('\n❌ ERROR in /api/chat:')
    console.error('Error details:', error.message)
    console.error(`${'='.repeat(60)}\n`)

    res.status(500).json({
      error: 'Error processing query with agent',
      details: error.message,
    })
  }
})

// Clear chat (delete thread)
app.post('/api/chat/clear', authenticateToken, async (req, res) => {
  try {
    const sessionId = req.user.sessionId
    const deleted = await deleteThread(sessionId)

    res.json({
      success: true,
      message: deleted
        ? 'Chat cleared successfully'
        : 'No active chat to clear',
    })
  } catch (error) {
    console.error('Error clearing chat:', error.message)
    res.status(500).json({
      error: 'Error clearing chat',
      details: error.message,
    })
  }
})

// Verify user permissions
app.get('/api/me', authenticateToken, (req, res) => {
  res.json({
    email: req.user.email,
    name: req.user.name,
    cases: req.user.cases,
  })
})

// Endpoint to reload permissions (útil para actualizar sin reiniciar servidor)
app.post('/api/admin/reload-permissions', authenticateToken, (req, res) => {
  // Verificar que sea admin
  if (!req.user.cases.includes('*')) {
    return res.status(403).json({ error: 'Admin access required' })
  }

  reloadPermissions()

  res.json({
    message: 'Permissions reloaded successfully',
    metadata: permissionsMetadata,
    totalUsers: Object.keys(userPermissions).length,
  })
})

// Endpoint para ver información de permisos
app.get('/api/admin/permissions-info', authenticateToken, (req, res) => {
  if (!req.user.cases.includes('*')) {
    return res.status(403).json({ error: 'Admin access required' })
  }

  res.json({
    metadata: permissionsMetadata,
    totalUsers: Object.keys(userPermissions).length,
    users: Object.entries(userPermissions).map(([email, data]) => ({
      email,
      name: data.name,
      role: data.role,
      casesCount: data.cases.length,
      cases: data.cases,
    })),
  })
})

// Endpoint to get document URL from filename
app.post('/api/documents/get-url', authenticateToken, async (req, res) => {
  try {
    const { filename } = req.body
    const userCases = req.user.cases

    if (!filename) {
      return res.status(400).json({ error: 'Filename required' })
    }

    if (!containerClient) {
      return res.status(503).json({
        error: 'Azure Storage not configured',
        details: 'AZURE_STORAGE_CONNECTION_STRING missing',
      })
    }

    console.log(`\n📄 Document URL Request: ${filename}`)

    const getContentType = (filename) => {
      const ext = filename.split('.').pop().toLowerCase()
      const contentTypes = {
        pdf: 'application/pdf',
        txt: 'text/plain',
        doc: 'application/msword',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        xls: 'application/vnd.ms-excel',
        xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        msg: 'application/vnd.ms-outlook',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        gif: 'image/gif',
        webp: 'image/webp',
      }
      return contentTypes[ext] || 'application/octet-stream'
    }

    const normalizeFilename = (name) => {
      return name
        .toLowerCase()
        .replace(/[_\-\s]+/g, '')
        .replace(/\.pdf$/i, '')
        .replace(/\.docx?$/i, '')
        .replace(/\.xlsx?$/i, '')
        .replace(/\.msg$/i, '')
        .replace(/\.txt$/i, '')
    }

    const searchFilename = normalizeFilename(filename)
    
    let blobPath = null
    let blobClient = null

    //Búsqueda fuzzy en casos del usuario
    console.log(`   🔍 Searching for file in user's accessible cases...`)

    const casesToSearch = userCases.includes('*') ? [] : userCases

    if (casesToSearch.length > 0) {
      // Buscar en casos específicos del usuario
      for (const userCase of casesToSearch) {
        console.log(`   📂 Searching in case: ${userCase}`)
        
        for await (const blob of containerClient.listBlobsFlat({
          prefix: userCase,
        })) {
          const blobFilename = blob.name.split('/').pop()
          const normalizedBlobName = normalizeFilename(blobFilename)

          if (
            normalizedBlobName.includes(searchFilename) ||
            searchFilename.includes(normalizedBlobName)
          ) {
            blobPath = blob.name
            blobClient = containerClient.getBlobClient(blobPath)
            console.log(`   ✅ Found match: ${blobFilename}`)
            console.log(`   📁 Full path: ${blob.name}`)
            break
          }
        }
        if (blobPath) break
      }
    } else {
      // Usuario con acceso a todos los casos (admin)
      console.log(`   🔍 Admin access - searching entire container...`)
      
      for await (const blob of containerClient.listBlobsFlat()) {
        const blobFilename = blob.name.split('/').pop()
        const normalizedBlobName = normalizeFilename(blobFilename)

        if (
          normalizedBlobName.includes(searchFilename) ||
          searchFilename.includes(normalizedBlobName)
        ) {
          blobPath = blob.name
          blobClient = containerClient.getBlobClient(blobPath)
          console.log(`   ✅ Found match: ${blobFilename}`)
          console.log(`   📁 Full path: ${blob.name}`)
          break
        }
      }
    }

    if (!blobPath || !blobClient) {
      console.log(`   ❌ Document not found: ${filename}`)
      return res.status(404).json({
        error: 'Document not found',
        filename: filename,
        searchedCases: userCases.includes('*') ? 'all' : userCases.join(', '),
        suggestion:
          'The document name from the agent might not match the exact file name in storage',
      })
    }

    // Verificar permisos basados en el caso del archivo
    const pathCaseMatch = blobPath.match(/^(\d{5})/)
    const actualCase = pathCaseMatch ? pathCaseMatch[1] : null

    if (
      actualCase &&
      !userCases.includes('*') &&
      !userCases.includes(actualCase)
    ) {
      console.log(
        `   ❌ Access denied - Document is from case ${actualCase}, user has access to: ${userCases.join(
          ', '
        )}`
      )
      return res.status(403).json({
        error: 'Access denied to this document',
        documentCase: actualCase,
        userCases: userCases,
      })
    }

    // Generar SAS token para acceso temporal
    const properties = await blobClient.getProperties()

    const connectionParts = AZURE_STORAGE_CONNECTION_STRING.split(';')
    const accountName = connectionParts
      .find((p) => p.startsWith('AccountName='))
      .split('=')[1]
    const accountKey = connectionParts
      .find((p) => p.startsWith('AccountKey='))
      .split('=')[1]

    const sharedKeyCredential = new StorageSharedKeyCredential(
      accountName,
      accountKey
    )

    const sasToken = generateBlobSASQueryParameters(
      {
        containerName: AZURE_CONTAINER_NAME,
        blobName: blobPath,
        permissions: BlobSASPermissions.parse('r'),
        startsOn: new Date(new Date().valueOf() - 5 * 60 * 1000),
        expiresOn: new Date(new Date().valueOf() + 24 * 60 * 60 * 1000),
        version: '2021-08-06',
      },
      sharedKeyCredential
    ).toString()

    const sasUrl = `${blobClient.url}?${sasToken}`

    console.log(`   🔗 SAS URL generated (expires in 24h)`)

    const actualFilename = blobPath.split('/').pop()
    const correctContentType = getContentType(actualFilename)

    res.json({
      filename: actualFilename,
      originalSearch: filename,
      caseNumber: actualCase,
      blobPath: blobPath,
      url: sasUrl,
      metadata: {
        size: properties.contentLength,
        contentType: correctContentType,
        lastModified: properties.lastModified,
      },
      expiresIn: '24 hours',
    })
  } catch (error) {
    console.error('❌ Error getting document URL:', error.message)
    console.error(error.stack)
    res.status(500).json({
      error: 'Error retrieving document URL',
      details: error.message,
    })
  }
})

app.options('/api/proxy/:sessionId/:filename', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range')
  res.setHeader('Access-Control-Max-Age', '86400')
  res.status(200).end()
})

app.get('/api/proxy/:sessionId/:filename', async (req, res) => {
  try {
    const { sessionId, filename: encodedFilename } = req.params
    const filename = decodeURIComponent(encodedFilename)

    console.log(`\n📄 PROXY REQUEST (new route)`)
    console.log(`   📁 File: ${filename}`)
    console.log(`   🔑 Session: ${sessionId}`)

    if (!sessionId) {
      console.log(`   ❌ No session ID provided`)
      return res.status(401).json({ error: 'Session required' })
    }

    let userEmail = null
    let userCases = []

    for (const [session, threadId] of userThreads.entries()) {
      if (
        session.startsWith(sessionId.split('-')[0]) &&
        session.includes(sessionId)
      ) {
        userEmail = sessionId.split('-').slice(0, -1).join('-')
        break
      }
    }

    if (!userEmail) {
      const emailPart = sessionId.substring(0, sessionId.lastIndexOf('-'))
      if (userPermissions[emailPart]) {
        userEmail = emailPart
        userCases = userPermissions[emailPart].cases
      }
    } else {
      userCases = userPermissions[userEmail]?.cases || []
    }

    if (!userEmail || !userCases.length) {
      console.log(`   ❌ Invalid or expired session`)
      return res.status(403).json({ error: 'Invalid session' })
    }

    console.log(`   👤 User: ${userEmail}`)
    console.log(`   📂 Cases: ${userCases.join(', ')}`)

    if (!containerClient) {
      return res.status(503).json({
        error: 'Azure Storage not configured',
      })
    }

    const normalizeFilename = (name) => {
      return name
        .toLowerCase()
        .replace(/[_\-\s]+/g, '')
        .replace(/\.pdf$/i, '')
        .replace(/\.docx?$/i, '')
        .replace(/\.xlsx?$/i, '')
        .replace(/\.msg$/i, '')
        .replace(/\.txt$/i, '')
    }

    const searchFilename = normalizeFilename(filename)
    console.log(`   🔍 Normalized: ${searchFilename}`)

    const getContentType = (filename) => {
      const ext = filename.split('.').pop().toLowerCase()
      const contentTypes = {
        pdf: 'application/pdf',
        txt: 'text/plain',
        doc: 'application/msword',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        xls: 'application/vnd.ms-excel',
        xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        msg: 'application/vnd.ms-outlook',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        gif: 'image/gif',
        webp: 'image/webp',
      }
      return contentTypes[ext] || 'application/octet-stream'
    }

    let blobPath = null
    let blobClient = null
    const caseMatch = filename.match(/^(\d{5})/)
    let caseNumber = caseMatch ? caseMatch[1] : null

    // Strategy 1
    if (caseNumber) {
      const commonPaths = [
        `${caseNumber}/docs/${filename}`,
        `${caseNumber}/notes/${filename}`,
        `${caseNumber}/${filename}`,
        `docs/${caseNumber}/${filename}`,
        `notes/${caseNumber}/${filename}`,
      ]

      for (const path of commonPaths) {
        blobClient = containerClient.getBlobClient(path)
        const exists = await blobClient.exists()
        if (exists) {
          blobPath = path
          console.log(`   ✅ Exact match: ${path}`)
          break
        }
      }
    }

    // Strategy 2: Fuzzy
    if (!blobPath) {
      const casesToSearch = userCases.includes('*') ? [] : userCases

      if (casesToSearch.length > 0) {
        for (const userCase of casesToSearch) {
          for await (const blob of containerClient.listBlobsFlat({
            prefix: userCase,
          })) {
            const blobFilename = blob.name.split('/').pop()
            const normalizedBlobName = normalizeFilename(blobFilename)

            if (
              normalizedBlobName.includes(searchFilename) ||
              searchFilename.includes(normalizedBlobName)
            ) {
              blobPath = blob.name
              blobClient = containerClient.getBlobClient(blobPath)
              console.log(`   ✅ Fuzzy match: ${blobFilename}`)
              break
            }
          }
          if (blobPath) break
        }
      } else {
        for await (const blob of containerClient.listBlobsFlat()) {
          const blobFilename = blob.name.split('/').pop()
          const normalizedBlobName = normalizeFilename(blobFilename)

          if (
            normalizedBlobName.includes(searchFilename) ||
            searchFilename.includes(normalizedBlobName)
          ) {
            blobPath = blob.name
            blobClient = containerClient.getBlobClient(blobPath)
            console.log(`   ✅ Fuzzy match: ${blobFilename}`)
            break
          }
        }
      }
    }

    // Strategy 3
    if (!blobPath) {
      blobClient = containerClient.getBlobClient(filename)
      const exists = await blobClient.exists()
      if (exists) {
        blobPath = filename
        console.log(`   ✅ Direct path`)
      }
    }

    if (!blobPath || !blobClient) {
      console.log(`   ❌ File not found`)
      return res.status(404).json({ error: 'Document not found' })
    }

    const pathCaseMatch = blobPath.match(/^(\d{5})/)
    const actualCase = pathCaseMatch ? pathCaseMatch[1] : null

    if (
      actualCase &&
      !userCases.includes('*') &&
      !userCases.includes(actualCase)
    ) {
      console.log(`   ❌ Access denied`)
      return res.status(403).json({ error: 'Access denied' })
    }

    // Get properties first to know the file size
    const properties = await blobClient.getProperties()
    const fileSize = properties.contentLength
    const actualFilename = blobPath.split('/').pop()
    const correctContentType = getContentType(actualFilename)

    // 🔥 Handle Range Requests
    const range = req.headers.range

    if (range) {
      console.log(`   📊 Range request: ${range}`)

      // Parse range header (format: "bytes=0-1023")
      const parts = range.replace(/bytes=/, '').split('-')
      const start = parseInt(parts[0], 10)
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1
      const chunkSize = end - start + 1

      console.log(`   📦 Sending bytes ${start}-${end} of ${fileSize}`)

      // Download only the requested range from Azure
      const downloadResponse = await blobClient.download(start, chunkSize)

      // Set 206 Partial Content response
      res.status(206)
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`)
      res.setHeader('Accept-Ranges', 'bytes')
      res.setHeader('Content-Length', chunkSize)
      res.setHeader('Content-Type', correctContentType)

      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range')
      res.setHeader(
        'Access-Control-Expose-Headers',
        'Content-Range, Content-Length, Content-Type, Accept-Ranges'
      )

      downloadResponse.readableStreamBody.pipe(res)

      console.log(`   ✅ Range request complete`)
    } else {
      // Full file download
      console.log(`   📥 Downloading full file...`)
      const downloadResponse = await blobClient.download()

      // Set headers for full response
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range')
      res.setHeader(
        'Access-Control-Expose-Headers',
        'Content-Length, Content-Type, Content-Disposition, Accept-Ranges'
      )

      res.setHeader('Content-Type', correctContentType)
      res.setHeader('Content-Length', fileSize)
      res.setHeader(
        'Content-Disposition',
        `inline; filename="${actualFilename}"`
      )
      res.setHeader('Accept-Ranges', 'bytes')
      res.setHeader('Cache-Control', 'public, max-age=3600')

      console.log(`   ✅ Serving: ${actualFilename}`)
      console.log(`   📦 Type: ${correctContentType}`)
      console.log(`   📏 Size: ${fileSize} bytes`)

      downloadResponse.readableStreamBody.pipe(res)

      console.log(`   ✅ Proxy complete`)
    }
  } catch (error) {
    console.error('❌ Proxy error:', error.message)
    console.error(error.stack)
    res.status(500).json({
      error: 'Error loading document',
      details: error.message,
    })
  }
})

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    permissions: {
      loaded: Object.keys(userPermissions).length > 0,
      totalUsers: Object.keys(userPermissions).length,
      lastSync: permissionsMetadata.lastSync,
      mode: permissionsMetadata.mode || 'PRODUCTION',
    },
    agent: {
      endpoint: AZURE_AI_PROJECT_ENDPOINT,
      agentId: AZURE_AGENT_ID,
      activeThreads: userThreads.size,
    },
  })
})

app.listen(PORT, () => {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`🚀 ACTS Law RAG Backend Server (Azure AI Foundry Agent)`)
  console.log(`${'='.repeat(60)}`)
  console.log(`📍 Server running on: http://localhost:${PORT}`)
  console.log(`🤖 Agent ID: ${AZURE_AGENT_ID}`)
  console.log(`🔗 Project Endpoint: ${AZURE_AI_PROJECT_ENDPOINT}`)
  console.log(
    `🔐 Permissions Mode: ${permissionsMetadata.mode || 'PRODUCTION'}`
  )
  console.log(`👥 Loaded Users: ${Object.keys(userPermissions).length}`)
  console.log(`🧵 Active Threads: ${userThreads.size}`)
  console.log(`${'='.repeat(60)}\n`)
})
