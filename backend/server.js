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

    return true
  } catch (error) {
    console.error('❌ Error cargando permisos:', error.message)
    return loadDemoPermissions()
  }
}

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
    'admin@actslaw.com': {
      password: 'admin123',
      cases: ['*'],
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

function reloadPermissions() {
  console.log('\n🔄 Recargando permisos...')
  loadPermissions()
}

loadPermissions()

// ===== AZURE AI FOUNDRY CONFIGURATION =====
const AZURE_AI_PROJECT_ENDPOINT = process.env.AZURE_AI_PROJECT_ENDPOINT
const AZURE_AGENT_ID = process.env.AZURE_AGENT_ID
const AZURE_AI_PROJECT_KEY = process.env.AZURE_AI_PROJECT_KEY

let aiProjectClient
try {
  if (AZURE_AI_PROJECT_KEY) {
    aiProjectClient = new AIProjectClient(
      AZURE_AI_PROJECT_ENDPOINT,
      new AzureKeyCredential(AZURE_AI_PROJECT_KEY)
    )
    console.log('✅ Azure AI Foundry client initialized with API Key')
  } else {
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
    console.warn('⚠️  AZURE_STORAGE_CONNECTION_STRING not found')
  }
} catch (error) {
  console.error(
    '❌ Error initializing Azure Blob Storage client:',
    error.message
  )
}

// ===== UTILITIES =====
const JWT_SECRET = process.env.JWT_SECRET
const userThreads = new Map()

function getContentType(filename) {
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
 * 🔥 Genera filtro OData usando el campo case_number
 */
function generateCaseNumberFilter(userCases) {
  if (userCases.includes('*')) {
    console.log('   🔓 Admin access - no filter needed')
    return null
  }

  const filters = userCases.map((caseNum) => `case_number eq '${caseNum}'`)
  const filterString = filters.join(' or ')

  console.log(`   🔒 Case filter: ${filterString}`)
  return filterString
}

async function findDocumentInStorage(filename, userCases, containerClient) {
  console.log(`\n🔍 BÚSQUEDA INTELIGENTE: "${filename}"`)

  const casesToSearch = userCases.includes('*') ? [''] : userCases

  // ESTRATEGIA 1: Búsqueda EXACTA
  console.log(`   📍 Estrategia 1: Búsqueda exacta...`)
  for (const userCase of casesToSearch) {
    const exactPaths = userCase
      ? [
          `${userCase}/${filename}`,
          `${userCase}/docs/${filename}`,
          `${userCase}/notes/${filename}`,
          `${userCase}/Deposition_EUO/${filename}`,
        ]
      : [filename] // Admin sin prefijo

    for (const path of exactPaths) {
      const blobClient = containerClient.getBlobClient(path)
      try {
        const exists = await blobClient.exists()
        if (exists) {
          console.log(`   ✅ ENCONTRADO (exacto): ${path}`)
          return { blobPath: path, blobClient }
        }
      } catch (e) {
        // Continuar si falla
      }
    }
  }

  // ESTRATEGIA 2: Búsqueda CASE-INSENSITIVE
  console.log(`   📍 Estrategia 2: Búsqueda case-insensitive...`)
  const lowerFilename = filename.toLowerCase()

  for (const userCase of casesToSearch) {
    try {
      for await (const blob of containerClient.listBlobsFlat({
        prefix: userCase || undefined,
      })) {
        const blobFilename = blob.name.split('/').pop()

        if (blobFilename.toLowerCase() === lowerFilename) {
          console.log(`   ✅ ENCONTRADO (case-insensitive): ${blob.name}`)
          return {
            blobPath: blob.name,
            blobClient: containerClient.getBlobClient(blob.name),
          }
        }
      }
    } catch (e) {
      console.warn(`   ⚠️  Error en estrategia 2: ${e.message}`)
    }
  }

  // ESTRATEGIA 3: Búsqueda FUZZY
  console.log(`   📍 Estrategia 3: Búsqueda fuzzy...`)
  const normalizedSearch = filename
    .toLowerCase()
    .replace(/[_\-\s]+/g, '')
    .replace(/\.(pdf|docx?|xlsx?|msg|txt)$/i, '')

  for (const userCase of casesToSearch) {
    try {
      for await (const blob of containerClient.listBlobsFlat({
        prefix: userCase || undefined,
      })) {
        const blobFilename = blob.name.split('/').pop()
        const normalizedBlob = blobFilename
          .toLowerCase()
          .replace(/[_\-\s]+/g, '')
          .replace(/\.(pdf|docx?|xlsx?|msg|txt)$/i, '')

        if (normalizedBlob === normalizedSearch) {
          console.log(`   ✅ ENCONTRADO (fuzzy): ${blob.name}`)
          return {
            blobPath: blob.name,
            blobClient: containerClient.getBlobClient(blob.name),
          }
        }
      }
    } catch (e) {
      console.warn(`   ⚠️  Error en estrategia 3: ${e.message}`)
    }
  }

  // ESTRATEGIA 4: Búsqueda por KEYWORDS
  console.log(`   📍 Estrategia 4: Búsqueda por keywords...`)
  const keywords = filename
    .toLowerCase()
    .replace(/\.(pdf|docx?|xlsx?|msg|txt)$/i, '')
    .split(/[-_\s]+/)
    .filter((word) => word.length > 3 && !/^\d+$/.test(word))

  console.log(`   🔑 Keywords: ${keywords.join(', ')}`)

  for (const userCase of casesToSearch) {
    try {
      for await (const blob of containerClient.listBlobsFlat({
        prefix: userCase || undefined,
      })) {
        const blobFilename = blob.name.split('/').pop().toLowerCase()

        const matchCount = keywords.filter((kw) =>
          blobFilename.includes(kw)
        ).length
        const matchPercentage = (matchCount / keywords.length) * 100

        if (matchPercentage >= 80) {
          console.log(
            `   ✅ ENCONTRADO (keywords ${matchPercentage.toFixed(0)}%): ${
              blob.name
            }`
          )
          return {
            blobPath: blob.name,
            blobClient: containerClient.getBlobClient(blob.name),
          }
        }
      }
    } catch (e) {
      console.warn(`   ⚠️  Error en estrategia 4: ${e.message}`)
    }
  }

  console.log(`   ❌ NO ENCONTRADO después de 4 estrategias`)
  return { blobPath: null, blobClient: null }
}

/**
 * Ejecutar conversación del agente con filtrado por case_number
 * SOLO confía en el filtro de Azure Search - sin validación adicional
 */
async function runAgentConversation(threadId, userMessage, userCases) {
  try {
    // 1️⃣ Generar filtro simple por case_number
    const searchFilter = generateCaseNumberFilter(userCases)

    // 2️⃣ Agregar contexto de seguridad
    const securityContext = userCases.includes('*')
      ? ''
      : `SECURITY: You can ONLY access documents from case numbers: ${userCases.join(
          ', '
        )}.\n\n`

    const contextMessage = `${securityContext}${userMessage}`

    await aiProjectClient.agents.messages.create(
      threadId,
      'user',
      contextMessage
    )
    console.log('   📩 Message added to thread')

    // 3️⃣ Crear opciones de ejecución con filtro
    const runOptions = {
      additional_instructions: userCases.includes('*')
        ? undefined
        : `CRITICAL: Only use documents from case numbers: ${userCases.join(
            ', '
          )}.`,
    }

    // 🔥 APLICAR FILTRO POR case_number
    if (searchFilter) {
      try {
        runOptions.tool_resources = {
          file_search: {
            filter: searchFilter,
          },
        }
        console.log('   🔒 Applied case_number filter via tool_resources')
      } catch (error) {
        console.warn(
          '   ⚠️  Could not apply filter via tool_resources:',
          error.message
        )

        try {
          runOptions.tools = [
            {
              type: 'file_search',
              file_search: {
                filter: searchFilter,
              },
            },
          ]
          console.log('   🔒 Applied case_number filter via tools array')
        } catch (e2) {
          console.warn('   ⚠️  Could not apply filter via tools:', e2.message)
        }
      }
    }

    // 4️⃣ Ejecutar agente
    let run = await aiProjectClient.agents.runs.create(
      threadId,
      AZURE_AGENT_ID,
      runOptions
    )
    console.log(`   🏃 Run started: ${run.id}`)

    // Polling
    let iterations = 0
    const maxIterations = 60

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

    // Obtener mensajes
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

            if (
              content.text.annotations &&
              content.text.annotations.length > 0
            ) {
              messageAnnotations = content.text.annotations
              console.log(
                `   📎 Found ${messageAnnotations.length} annotations`
              )
            }
          }
        }
        break
      }
    }

    // 5️⃣ Extraer citas SIN validación - confiamos 100% en el filtro de Azure
    console.log('   📋 Extracting citations (trusting Azure filter)...')
    let citations = []

    if (messageAnnotations.length > 0) {
      for (const annotation of messageAnnotations) {
        try {
          let citationInfo = {
            title: 'Reference',
            content: '',
            filepath: null,
          }

          if (annotation.type === 'url_citation' && annotation.urlCitation) {
            citationInfo.title =
              annotation.urlCitation.title ||
              annotation.urlCitation.url ||
              'Document Reference'
            citationInfo.filepath = annotation.urlCitation.url
            citationInfo.content = `Document from Azure AI Search`
            console.log(`   ✅ Citation: ${citationInfo.title}`)
          } else if (
            annotation.type === 'file_citation' &&
            annotation.file_citation
          ) {
            const fileId = annotation.file_citation.file_id
            const quote = annotation.file_citation.quote || ''

            citationInfo.content = quote
            citationInfo.filepath = fileId

            const filenamePattern =
              /\b\d{5}_\d{8}_\d+\.txt\b|\b[\w-]+\.(txt|pdf|msg|docx)\b/gi
            const filenameMatch = quote.match(filenamePattern)

            if (filenameMatch && filenameMatch[0]) {
              citationInfo.title = filenameMatch[0]
            } else {
              citationInfo.title = quote.substring(0, 50) || fileId
            }
            console.log(`   ✅ Citation: ${citationInfo.title}`)
          } else if (annotation.type === 'file_path' && annotation.file_path) {
            citationInfo.title =
              annotation.file_path.file_id || 'File Reference'
            citationInfo.filepath = annotation.file_path.file_id
          } else if (annotation.text) {
            citationInfo.title = annotation.text.substring(0, 100)
            citationInfo.content = annotation.text
          }

          citations.push(citationInfo)
        } catch (error) {
          console.error('   ⚠️  Error processing annotation:', error.message)
        }
      }
    }

    // Extraer de "Documents Consulted"
    const docsPattern = /\*\*Documents Consulted:\*\*\s*\n((?:[-•]\s*.+\n?)+)/i
    const docsMatch = assistantMessage.match(docsPattern)

    if (docsMatch) {
      const docsList = docsMatch[1]
      const docLines = docsList.match(/[-•]\s*(.+)/g)

      if (docLines) {
        docLines.forEach((line) => {
          const docName = line.replace(/^[-•]\s*/, '').trim()
          if (docName && docName.length > 0) {
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

    console.log(`   📎 Total citations: ${citations.length}`)

    // Limpiar mensaje
    let cleanMessage = assistantMessage
      .replace(/【[^】]*】/g, '')
      .replace(/---\s*\*\*Documents Consulted:\*\*[\s\S]*?---/gi, '')
      .replace(/\*\*Documents Consulted:\*\*[\s\S]*$/i, '')
      .trim()

    return {
      message: cleanMessage,
      citations: citations,
      securityInfo: {
        appliedFilter: searchFilter !== null,
        filterType: 'case_number',
        filterExpression: searchFilter,
      },
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

  const isRealUser = !user.password
  const isDemoUser = user.password && user.password === password

  if (!isRealUser && !isDemoUser) {
    return res.status(401).json({ error: 'Invalid credentials' })
  }

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

// Chat endpoint with Azure AI Search filtering
app.post('/api/chat', authenticateToken, async (req, res) => {
  try {
    const { message, clearThread } = req.body
    const userCases = req.user.cases
    const sessionId = req.user.sessionId

    if (!message) {
      return res.status(400).json({ error: 'Message required' })
    }

    console.log(`\n${'='.repeat(60)}`)
    console.log(`🤖 AGENT CHAT (case_number FILTERING)`)
    console.log(`User: ${req.user.email} (${req.user.name})`)
    console.log(`Session: ${sessionId}`)
    console.log(`Allowed Cases: ${userCases.join(', ')}`)
    console.log(`Question: ${message}`)
    console.log(`Clear Thread: ${clearThread || false}`)
    console.log(`${'='.repeat(60)}\n`)

    if (clearThread) {
      await deleteThread(sessionId)
    }

    const threadId = await getOrCreateThread(sessionId)

    console.log('🤖 Running agent with case_number filtering...')
    const response = await runAgentConversation(threadId, message, userCases)

    console.log(`✅ Response ready`)
    console.log(`🔒 Filter applied: ${response.securityInfo.appliedFilter}`)
    console.log(`📎 Citations: ${response.citations.length}\n`)

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

// Endpoint to reload permissions
app.post('/api/admin/reload-permissions', authenticateToken, (req, res) => {
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

    // 🔥 Usar la función de búsqueda inteligente
    const { blobPath, blobClient } = await findDocumentInStorage(
      filename,
      userCases,
      containerClient
    )

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

    // Verificar permisos por caso
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

    // Obtener propiedades del blob
    const properties = await blobClient.getProperties()

    // Generar SAS token
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
    const correctContentType = getContentType(actualFilename) // ✅ Ahora funciona

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

// Proxy endpoint OPTIONS
app.options('/api/proxy/:sessionId/:filename', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range')
  res.setHeader('Access-Control-Max-Age', '86400')
  res.status(200).end()
})

// Proxy endpoint GET
app.get('/api/proxy/:sessionId/:filename', async (req, res) => {
  try {
    const { sessionId, filename: encodedFilename } = req.params
    const filename = decodeURIComponent(encodedFilename)

    console.log(`\n📄 PROXY REQUEST`)
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

    // Strategy 1: Try exact paths
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

    // Strategy 2: Fuzzy search
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

    // Strategy 3: Direct path
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

    const properties = await blobClient.getProperties()
    const fileSize = properties.contentLength
    const actualFilename = blobPath.split('/').pop()
    const correctContentType = getContentType(actualFilename)

    const range = req.headers.range

    if (range) {
      console.log(`   📊 Range request: ${range}`)

      const parts = range.replace(/bytes=/, '').split('-')
      const start = parseInt(parts[0], 10)
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1
      const chunkSize = end - start + 1

      console.log(`   📦 Sending bytes ${start}-${end} of ${fileSize}`)

      const downloadResponse = await blobClient.download(start, chunkSize)

      res.status(206)
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`)
      res.setHeader('Accept-Ranges', 'bytes')
      res.setHeader('Content-Length', chunkSize)
      res.setHeader('Content-Type', correctContentType)

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
      console.log(`   📥 Downloading full file...`)
      const downloadResponse = await blobClient.download()

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
    security: {
      filterType: 'case_number (Azure Search only)',
      validationLayer: 'DISABLED - trusting Azure filter',
    },
  })
})

app.listen(PORT, () => {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`🚀 ACTS Law RAG Backend (case_number FILTERING)`)
  console.log(`${'='.repeat(60)}`)
  console.log(`📍 Server: http://localhost:${PORT}`)
  console.log(`🤖 Agent: ${AZURE_AGENT_ID}`)
  console.log(`🔒 Security: Azure Search filtering ONLY`)
  console.log(`✅ No validation layer - trusting Azure filter 100%`)
  console.log(`${'='.repeat(60)}\n`)
})
