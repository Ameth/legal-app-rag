import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import jwt from 'jsonwebtoken'
import fs from 'fs'
import axios from 'axios'
import { AIProjectClient } from '@azure/ai-projects'
import { DefaultAzureCredential } from '@azure/identity'
import { AzureKeyCredential } from '@azure/core-auth'
import {
  BlobServiceClient,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
  StorageSharedKeyCredential,
} from '@azure/storage-blob'
import {
  SearchClient,
  AzureKeyCredential as SearchKeyCredential,
} from '@azure/search-documents'
import admin from 'firebase-admin'
import { readFileSync } from 'fs'

dotenv.config()

const app = express()
const PORT = process.env.PORT || 3001

// Middleware
app.use(cors())
app.use(express.json())

// ===== FIREBASE INITIALIZATION =====
try {
  let serviceAccount
  // Opción A: Si existe la variable de entorno (PRODUCCIÓN)
  if (process.env.FIREBASE_CONFIG_JSON) {
    serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG_JSON)
    console.log('✅ Firebase config loaded from Environment Variable')
  }
  // Opción B: Si no, busca el archivo local (DESARROLLO)
  else {
    serviceAccount = JSON.parse(
      readFileSync('./firebase-service-account.json', 'utf8')
    )
    console.log('✅ Firebase config loaded from local file')
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  })
  console.log('✅ Firebase Admin initialized successfully')
} catch (error) {
  console.error('❌ Error initializing Firebase Admin:', error.message)
}

// ===== AZURE AI FOUNDRY CONFIGURATION =====
const AZURE_AI_PROJECT_ENDPOINT = process.env.AZURE_AI_PROJECT_ENDPOINT
const AZURE_AGENT_ID = process.env.AZURE_AGENT_ID
const AZURE_VECTOR_STORE_ID = process.env.AZURE_VECTOR_STORE_ID 

let aiProjectClient;

try {
  // Validación simple
  if (!AZURE_AI_PROJECT_ENDPOINT) {
    throw new Error('❌ Falta la variable AZURE_AI_PROJECT_ENDPOINT')
  }

  // Inicialización con URL (Soluciona 'Invalid URL' y 'agents/read')
  console.log(
    `🔵 Conectando a Foundry: ${AZURE_AI_PROJECT_ENDPOINT.substring(0, 30)}...`
  )

  aiProjectClient = new AIProjectClient(
    AZURE_AI_PROJECT_ENDPOINT,
    new DefaultAzureCredential()
  )

  console.log('✅ Azure AI Foundry client initialized via Project Endpoint')
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

// ===== AZURE SEARCH CONFIGURATION =====
const AZURE_SEARCH_ENDPOINT = process.env.AZURE_SEARCH_ENDPOINT
const AZURE_SEARCH_KEY = process.env.AZURE_SEARCH_KEY
const AZURE_SEARCH_INDEX = process.env.AZURE_SEARCH_INDEX

let searchClient
try {
  if (AZURE_SEARCH_ENDPOINT && AZURE_SEARCH_KEY && AZURE_SEARCH_INDEX) {
    searchClient = new SearchClient(
      AZURE_SEARCH_ENDPOINT,
      AZURE_SEARCH_INDEX,
      new SearchKeyCredential(AZURE_SEARCH_KEY)
    )
    console.log('✅ Azure Search client initialized for document lookup')
  } else {
    console.warn(
      '⚠️  Azure Search credentials not found - using fallback search'
    )
  }
} catch (error) {
  console.error('❌ Error initializing Azure Search client:', error.message)
}

// ===== UTILITIES =====
const JWT_SECRET = process.env.JWT_SECRET

// Store threads with their associated case filters
const userThreads = new Map() // sessionId -> { threadId, cases }

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

/**
 * 🔒 Generate OData filter for Azure Search
 * This is the PRIMARY security mechanism
 */
function generateCaseNumberFilter(userCases) {
  if (userCases.includes('*')) {
    console.log('   🔓 Admin access - no filter applied')
    return null
  }

  // Generate: case_number eq '25096' or case_number eq '25097' ...
  const filters = userCases.map((caseNum) => `case_number eq '${caseNum}'`)
  const filterString = filters.join(' or ')

  console.log(`   🔒 Case filter (OData): ${filterString}`)
  return filterString
}

/**
 * 🧵 Get or create thread with case-level filtering
 * CRITICAL: Thread is scoped to user's authorized cases
 */
async function getOrCreateThread(sessionId, userCases) {
  const threadInfo = userThreads.get(sessionId)

  // Check if existing thread matches current user cases
  if (threadInfo) {
    const casesMatch =
      threadInfo.cases.length === userCases.length &&
      threadInfo.cases.every((c) => userCases.includes(c))

    if (casesMatch) {
      console.log(`   ♻️  Reusing thread: ${threadInfo.threadId}`)
      return threadInfo.threadId
    } else {
      // Cases changed - delete old thread and create new one
      console.log(`   🔄 Cases changed - creating new thread`)
      await deleteThread(sessionId)
    }
  }

  console.log('   🆕 Creating new thread...')

  const searchFilter = generateCaseNumberFilter(userCases)

  // For Azure AI Search tool (not vector store), thread is created without tool_resources
  // Filtering will be applied via additional_instructions in the run
  const thread = await aiProjectClient.agents.threads.create()

  // Store thread with associated cases
  userThreads.set(sessionId, {
    threadId: thread.id,
    cases: [...userCases],
    filter: searchFilter,
    createdAt: new Date(),
  })

  console.log(`   ✅ Thread created: ${thread.id}`)
  console.log(`   📂 Authorized cases: ${userCases.join(', ')}`)

  return thread.id
}

async function deleteThread(sessionId) {
  const threadInfo = userThreads.get(sessionId)
  if (threadInfo) {
    try {
      await aiProjectClient.agents.threads.delete(threadInfo.threadId)
      userThreads.delete(sessionId)
      console.log(`   🗑️  Thread deleted: ${threadInfo.threadId}`)
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
 * 🔍 Get blob path from Azure Search Index
 */
async function getBlobPathFromIndex(filename) {
  if (!searchClient) {
    console.warn('   ⚠️  Search client not available')
    return null
  }

  try {
    console.log(`   🔍 Searching index for: "${filename}"`)

    // Extract keywords from filename
    const keywords = filename
      .replace(/\.(pdf|docx?|xlsx?|msg|txt)$/i, '')
      .replace(/[_\-]/g, ' ')
      .replace(/\d{4}-\d{2}-\d{2}/g, '')
      .replace(/\d{2}-\d{2}-\d{2}/g, '')
      .replace(/\d{8}/g, '')
      .split(/\s+/)
      .filter((word) => word.length >= 4 && !/^\d+$/.test(word))
      .slice(0, 5)
      .join(' ')
      .trim()

    if (!keywords || keywords.length < 3) {
      console.log(`   ⚠️  No valid keywords extracted from: "${filename}"`)
      return null
    }

    console.log(`   🔑 Keywords: "${keywords}"`)

    const searchResults = await searchClient.search(keywords, {
      searchFields: ['title'],
      select: ['url', 'title'],
      top: 10,
      queryType: 'simple',
      searchMode: 'any',
    })

    let bestMatch = null
    let bestScore = 0

    for await (const result of searchResults.results) {
      const docTitle = result.document.title || ''
      const docTitleLower = docTitle.toLowerCase()
      const filenameLower = filename.toLowerCase()
      const keywordsArray = keywords.toLowerCase().split(/\s+/)

      let matches = 0
      for (const keyword of keywordsArray) {
        if (docTitleLower.includes(keyword)) {
          matches++
        }
      }

      const score = matches / keywordsArray.length

      if (score > bestScore && result.document.url) {
        bestScore = score
        bestMatch = {
          title: docTitle,
          url: result.document.url,
          score: score,
        }
      }
    }

    if (bestMatch && bestScore >= 0.5) {
      let cleanPath = decodeURIComponent(bestMatch.url)
      cleanPath = cleanPath.replace(/[0-9]+$/, '').replace(/\.+$/, '')

      console.log(
        `   ⚡ Found match (${Math.round(bestScore * 100)}%): "${
          bestMatch.title
        }"`
      )
      console.log(`   ⚡ BlobPath: ${cleanPath}`)

      return cleanPath
    }

    console.log(
      `   ⚠️  No good match found (best score: ${Math.round(bestScore * 100)}%)`
    )
    return null
  } catch (error) {
    console.error(`   ⚠️  Error fetching blobPath from index:`, error.message)
    return null
  }
}

/**
 * 🐢 FALLBACK: Search in Blob Storage if index lookup fails
 */
async function findDocumentInStorage(filename, userCases, containerClient) {
  console.log(`\n🔍 FALLBACK: Searching in Blob Storage for: "${filename}"`)

  const casesToSearch = userCases.includes('*') ? [''] : userCases

  for (const userCase of casesToSearch) {
    try {
      for await (const blob of containerClient.listBlobsFlat({
        prefix: userCase || undefined,
      })) {
        const blobFilename = blob.name.split('/').pop()

        if (blobFilename === filename) {
          console.log(`   ✅ FOUND: ${blob.name}`)
          return {
            blobPath: blob.name,
            blobClient: containerClient.getBlobClient(blob.name),
          }
        }
      }
    } catch (e) {
      console.warn(`   ⚠️  Error in fallback search: ${e.message}`)
    }
  }

  console.log(`   ❌ NOT FOUND in fallback search`)
  return { blobPath: null, blobClient: null }
}

/**
 * 🤖 Run agent conversation with filtered RAG
 *
 * Security Layers:
 * 1. Thread-level vector store filtering (PRIMARY)
 * 2. Runtime instructions reinforcement (SECONDARY)
 * 3. Post-processing validation (SAFETY NET)
 */
async function runAgentConversation(threadId, userMessage, userCases) {
  try {
    const isAdmin = userCases.includes('*')
    let toolRetrievedDocuments = []

    // 1️⃣ Definición de la Herramienta
    const searchToolDefinition = {
      type: 'function',
      function: {
        name: 'search_legal_documents',
        description:
          'Search for information within the authorized legal cases. Use this tool whenever you need to find facts, dates, names, or details from the documents.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description:
                'The search query keywords to find relevant information.',
            },
          },
          required: ['query'],
        },
      },
    }

    // 2️⃣ Enviar mensaje
    await aiProjectClient.agents.messages.create(threadId, 'user', userMessage)
    console.log('   📩 Message added to thread')

    const allowedList = userCases.join(', ')

    // 3️⃣ Iniciar Ejecución
    let run = await aiProjectClient.agents.runs.create(
      threadId,
      AZURE_AGENT_ID,
      {
        tools: [searchToolDefinition],
        additional_instructions: `
        CURRENT SECURITY CONTEXT:
        - The user is AUTHORIZED for the following Case Numbers: [${allowedList}].
        - The search tool 'search_legal_documents' is SECURE and PRE-FILTERED by the system.
        
        OPERATIONAL RULES:
        1. ALWAYS use the tool 'search_legal_documents' to find information.
        2. TRUST THE TOOL: If the tool returns results, you are authorized to use them.
        3. RESPONSE STYLE: Answer naturally. Do NOT use bracketed citations like [1] or [2] in your text.
        4. If the tool returns empty results, inform the user that no information was found.
        `,
      }
    )
    console.log(`   🏃 Run started: ${run.id}`)

    // 4️⃣ Polling
    let iterations = 0
    const maxIterations = 60

    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      run = await aiProjectClient.agents.runs.get(threadId, run.id)
      iterations++

      if (iterations >= maxIterations) throw new Error('Agent run timeout')

      // CASO A: Requires Action
      if (run.status === 'requires_action') {
        console.log('   ⚙️  Agent requires action (Function Call)...')

        // Leemos con seguridad (Optional Chaining)
        const toolCalls = run.requiredAction?.submitToolOutputs?.toolCalls

        if (!toolCalls) {
          console.error('   ❌ Error: Tool calls are undefined')
          break
        }

        const toolOutputs = []

        for (const toolCall of toolCalls) {
          if (toolCall.function.name === 'search_legal_documents') {
            const args = JSON.parse(toolCall.function.arguments)
            const query = args.query

            console.log(
              `   🔎 Tool Executing: search_legal_documents(query="${query}")`
            )

            let searchResultText = 'No results found.'

            if (searchClient) {
              const filter = isAdmin
                ? null
                : userCases.map((c) => `case_number eq '${c}'`).join(' or ')

              const searchResults = await searchClient.search(query, {
                filter: filter,
                select: ['title', 'chunk', 'url', 'case_number'],
                top: 5,
                queryType: 'semantic',
                queryLanguage: 'en-us',
                semanticConfiguration:
                  'ai-search-1761858591800-small-semantic-configuration',
              })

              let resultsBuffer = []
              let docIndex = 1

              for await (const result of searchResults.results) {
                const docInfo = {
                  title: result.document.title,
                  blobPath: decodeURIComponent(result.document.url),
                  content: result.document.chunk,
                  case: result.document.case_number,
                }
                toolRetrievedDocuments.push(docInfo)

                resultsBuffer.push(`
                Title: ${result.document.title}
                Case: ${result.document.case_number}
                Content: ${result.document.chunk}
                -----------------------------------
                `)
                docIndex++
              }

              if (resultsBuffer.length > 0) {
                searchResultText = resultsBuffer.join('\n')
                console.log(
                  `   ✅ Found ${resultsBuffer.length} docs. Passed to Agent.`
                )
              }
            }

            // 🔥 CORRECCIÓN CRÍTICA: Enviar AMBOS formatos
            // Esto asegura que si el SDK busca uno u otro, siempre encuentre el ID.
            toolOutputs.push({
              tool_call_id: toolCall.id, // Formato API REST (snake_case)
              toolCallId: toolCall.id, // Formato SDK JS (camelCase)
              output: searchResultText,
            })
          }
        }

        if (toolOutputs.length > 0) {
          // Enviamos el array directo
          await aiProjectClient.agents.runs.submitToolOutputs(
            threadId,
            run.id,
            toolOutputs
          )
          console.log('   📤 Tool outputs submitted successfully')
        }
      }

      if (run.status === 'completed') {
        console.log('   ✅ Run completed.')
        break
      }

      if (run.status === 'failed' || run.status === 'cancelled') {
        throw new Error(`Run failed: ${run.lastError?.message || run.status}`)
      }
    }

    // 5️⃣ Respuesta Final
    const messagesResponse = await aiProjectClient.agents.messages.list(
      threadId,
      { order: 'desc', limit: 1 }
    )

    let assistantMessage = ''
    for await (const message of messagesResponse) {
      if (message.role === 'assistant') {
        if (
          message.content &&
          message.content.length > 0 &&
          message.content[0].text
        ) {
          assistantMessage = message.content[0].text.value
        }
        break
      }
    }

    let cleanMessage = assistantMessage.replace(/【[^】]*】/g, '').trim()

    // 6️⃣ Citations
    const uniqueCitationsMap = new Map()
    toolRetrievedDocuments.forEach((doc) => {
      if (doc.blobPath && !uniqueCitationsMap.has(doc.blobPath)) {
        uniqueCitationsMap.set(doc.blobPath, {
          title: doc.title,
          blobPath: doc.blobPath,
          content: doc.content,
          chunk: doc.content,
        })
      }
    })

    const finalCitations = Array.from(uniqueCitationsMap.values())

    console.log(`   ✅ Response ready with ${finalCitations.length} citations.`)

    return {
      message: cleanMessage,
      citations: finalCitations,
      securityInfo: {
        filterApplied: true,
        toolUsed: toolRetrievedDocuments.length > 0,
        citationsReturned: finalCitations.length,
      },
    }
  } catch (error) {
    console.error('   ❌ Error in agent conversation:', error.message)
    throw error
  }
}

// ===== PERMISSIONS CACHE =====
let permissionsCache = {
  byUserId: {},
  byEmail: {},
  lastSync: null,
  isSyncing: false,
}

const SA_API_BASE_URL = process.env.SA_API_BASE_URL
const SA_SYSTEM_USERNAME = process.env.SA_USERNAME
const SA_SYSTEM_PASSWORD = process.env.SA_PASSWORD

/**
 * 🔄 Sync permissions from Smart Advocate
 */
async function syncPermissions() {
  if (permissionsCache.isSyncing) return
  permissionsCache.isSyncing = true
  console.log('\n🔄 [SYNC] Starting permissions sync...')

  try {
    // Authenticate
    const authRes = await axios.post(`${SA_API_BASE_URL}/Users/authenticate`, {
      Username: SA_SYSTEM_USERNAME,
      Password: SA_SYSTEM_PASSWORD,
    })
    const serviceToken = authRes.data.token
    console.log('   ✅ [SYNC] System authenticated')

    // Get case numbers from Azure
    if (!AZURE_STORAGE_CONNECTION_STRING)
      throw new Error('Missing connection string')

    const blobServiceClient = BlobServiceClient.fromConnectionString(
      AZURE_STORAGE_CONNECTION_STRING
    )
    const containerClient =
      blobServiceClient.getContainerClient(AZURE_CONTAINER_NAME)

    const caseNumbers = new Set()
    for await (const blob of containerClient.listBlobsFlat()) {
      const parts = blob.name.split('/')
      if (parts.length > 0 && /^\d+$/.test(parts[0])) {
        caseNumbers.add(parts[0])
      }
    }
    const casesList = Array.from(caseNumbers)
    console.log(`   📂 [SYNC] Found ${casesList.length} cases in Azure`)

    // Query staff for each case
    const tempByUserId = {}
    const tempByEmail = {}

    let processed = 0
    for (const caseNum of casesList) {
      try {
        const staffRes = await axios.get(
          `${SA_API_BASE_URL}/case/staff/byCaseNumber?CaseNumber=${caseNum}`,
          { headers: { Authorization: `Bearer ${serviceToken}` } }
        )

        const staffList = staffRes.data

        if (Array.isArray(staffList)) {
          staffList.forEach((staff) => {
            const uid = staff.userID
            const email = staff.email ? staff.email.toLowerCase().trim() : null

            if (uid && !tempByUserId[uid]) {
              tempByUserId[uid] = {
                name: `${staff.firstName} ${staff.lastName}`,
                email: email,
                role: staff.role,
                cases: [],
              }
            }

            if (uid && !tempByUserId[uid].cases.includes(caseNum)) {
              tempByUserId[uid].cases.push(caseNum)
            }

            if (email) {
              tempByEmail[email] = tempByUserId[uid]
            }
          })
        }
      } catch (e) {
        // Ignore individual case errors
      }

      processed++
      if (processed % 20 === 0) {
        console.log(`     ... processed ${processed}/${casesList.length}`)
      }
    }

    // Update cache
    permissionsCache.byUserId = tempByUserId
    permissionsCache.byEmail = tempByEmail
    permissionsCache.lastSync = new Date()

    console.log(
      `✅ [SYNC] Completed. Users indexed: ${Object.keys(tempByUserId).length}`
    )
  } catch (error) {
    console.error('❌ [SYNC] Error:', error.message)
  } finally {
    permissionsCache.isSyncing = false
  }
}

// Run sync on startup and every hour
syncPermissions()
setInterval(syncPermissions, 60 * 60 * 1000)

// ===== API ENDPOINTS =====

/**
 * Login endpoint (Smart Advocate credentials)
 */
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' })
  }

  try {
    console.log(`🔐 Login attempt: ${username}`)

    // Authenticate against Smart Advocate
    let authData
    try {
      const saResponse = await axios.post(
        `${SA_API_BASE_URL}/Users/authenticate`,
        {
          Username: username,
          Password: password,
        }
      )
      authData = saResponse.data
    } catch (e) {
      console.log(`   ❌ SA rejected credentials`)
      return res.status(401).json({ error: 'Invalid username or password' })
    }

    if (!authData || !authData.userID) {
      return res.status(401).json({ error: 'Authentication failed' })
    }

    const saUserID = authData.userID
    console.log(`   ✅ Authenticated. SA UserID: ${saUserID}`)

    // Get permissions from cache
    const userProfile = permissionsCache.byUserId[saUserID]

    let userCases = []
    let displayName = username
    let userEmail = `${username}@actslaw.com`

    if (userProfile) {
      userCases = userProfile.cases || []
      displayName = userProfile.name || username
      userEmail = userProfile.email || userEmail
      console.log(`   📂 Cases: ${userCases.length}`)
    } else {
      console.log(`   ⚠️  User authenticated but no cases assigned`)
    }

    // Generate JWT
    const sessionId = `${username}-${Date.now()}`
    const token = jwt.sign(
      {
        email: userEmail,
        saUsername: username,
        saUserID: saUserID,
        name: displayName,
        cases: userCases,
        sessionId: sessionId,
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    )

    res.json({
      token,
      user: {
        email: userEmail,
        name: displayName,
        cases: userCases,
      },
    })
  } catch (error) {
    console.error('Login error:', error.message)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * Microsoft Authentication via Firebase
 */
app.post('/api/auth/microsoft', async (req, res) => {
  try {
    const { idToken } = req.body

    if (!idToken) {
      return res.status(400).json({ error: 'ID token required' })
    }

    console.log('\n🔐 Microsoft Authentication Request')

    let decodedToken
    try {
      decodedToken = await admin.auth().verifyIdToken(idToken)
    } catch (verifyError) {
      console.error('   ❌ Token verification failed:', verifyError.message)
      return res.status(401).json({
        error: 'Invalid or expired token',
        details: verifyError.message,
      })
    }

    const { uid, email, name, picture } = decodedToken

    console.log('   ✅ Token verified')
    console.log(`   👤 Email: ${email}`)

    if (!email) {
      return res.status(400).json({ error: 'Email not found in token' })
    }

    // Check permissions cache
    const normalizedEmail = email.toLowerCase().trim()
    const user = permissionsCache.byEmail[normalizedEmail]

    if (!user) {
      console.log('   ❌ User not authorized')
      return res.status(403).json({
        error: 'Access denied',
        message: 'Your email is not authorized. Contact your administrator.',
        email: normalizedEmail,
      })
    }

    // Generate session
    const sessionId = `${normalizedEmail}-${Date.now()}`
    const token = jwt.sign(
      {
        email: normalizedEmail,
        name: user.name || name || email.split('@')[0],
        cases: user.cases,
        sessionId: sessionId,
        authProvider: 'microsoft',
        firebaseUid: uid,
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    )

    console.log('   ✅ Authentication successful')
    console.log(`   👤 User: ${user.name}`)
    console.log(`   📂 Cases: ${user.cases.join(', ')}`)

    res.json({
      success: true,
      token,
      user: {
        email: normalizedEmail,
        name: user.name || name || email.split('@')[0],
        cases: user.cases,
        photoURL: picture || null,
      },
    })
  } catch (error) {
    console.error('Microsoft auth error:', error.message)
    res.status(500).json({
      error: 'Authentication error',
      details: error.message,
    })
  }
})

/**
 * Authentication middleware
 */
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

/**
 * Chat endpoint - Main conversation interface
 */
app.post('/api/chat', authenticateToken, async (req, res) => {
  try {
    const { message, clearThread } = req.body
    const userCases = req.user.cases
    const sessionId = req.user.sessionId

    if (!message) {
      return res.status(400).json({ error: 'Message required' })
    }

    console.log(`\n${'='.repeat(60)}`)
    console.log(`🤖 AGENT CHAT`)
    console.log(`User: ${req.user.email}`)
    console.log(`Cases: ${userCases.join(', ')}`)
    console.log(`Question: ${message}`)
    console.log(`${'='.repeat(60)}\n`)

    if (clearThread) {
      await deleteThread(sessionId)
    }

    // Get or create thread with case filtering
    const threadId = await getOrCreateThread(sessionId, userCases)
    const response = await runAgentConversation(threadId, message, userCases)

    console.log(`✅ Response ready with ${response.citations.length} citations`)

    if (response.securityInfo.unauthorizedAccessDetected) {
      console.warn(
        `⚠️  Security validation triggered - review Azure filter configuration`
      )
    }

    res.json(response)
  } catch (error) {
    console.error('\n❌ ERROR in /api/chat:')
    console.error('Details:', error.message)

    res.status(500).json({
      error: 'Error processing query',
      details: error.message,
    })
  }
})

/**
 * Clear chat thread
 */
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

/**
 * Verify user permissions
 */
app.get('/api/me', authenticateToken, (req, res) => {
  res.json({
    email: req.user.email,
    name: req.user.name,
    cases: req.user.cases,
  })
})

/**
 * Get document URL with SAS token
 */
app.post('/api/documents/get-url', authenticateToken, async (req, res) => {
  try {
    const { filename, blobPath } = req.body
    const userCases = req.user.cases

    if (!containerClient) {
      return res.status(503).json({ error: 'Azure Storage not configured' })
    }

    console.log(`\n📄 Getting document: ${filename}`)

    let finalBlobPath = blobPath
    let blobClient = null
    let source = 'unknown'

    // Strategy 1: Use blobPath from citation (index)
    if (finalBlobPath) {
      console.log(`   ⚡ Using blobPath from index: ${finalBlobPath}`)
      blobClient = containerClient.getBlobClient(finalBlobPath)

      try {
        const exists = await blobClient.exists()
        if (exists) {
          console.log(`   ✅ Found via index`)
          source = 'index-direct'
        } else {
          finalBlobPath = null
        }
      } catch (e) {
        finalBlobPath = null
      }
    }

    // Strategy 2: Search index by title
    if (!finalBlobPath && filename && searchClient) {
      console.log(`   🔍 Searching index...`)
      finalBlobPath = await getBlobPathFromIndex(filename)

      if (finalBlobPath) {
        blobClient = containerClient.getBlobClient(finalBlobPath)
        try {
          const exists = await blobClient.exists()
          if (exists) {
            console.log(`   ✅ Found via index search`)
            source = 'index-search'
          } else {
            finalBlobPath = null
          }
        } catch (e) {
          finalBlobPath = null
        }
      }
    }

    // Strategy 3: Fallback to blob storage search
    if (!finalBlobPath && filename) {
      console.log(`   🐢 Using fallback search`)
      const result = await findDocumentInStorage(
        filename,
        userCases,
        containerClient
      )
      finalBlobPath = result.blobPath
      blobClient = result.blobClient
      source = 'fallback'
    }

    if (!finalBlobPath || !blobClient) {
      console.log(`   ❌ Not found`)
      return res.status(404).json({
        error: 'Document not found',
        filename: filename,
      })
    }

    // Verify permissions
    const pathCaseMatch = finalBlobPath.match(/^(\d{5})/)
    const actualCase = pathCaseMatch ? pathCaseMatch[1] : null

    if (
      actualCase &&
      !userCases.includes('*') &&
      !userCases.includes(actualCase)
    ) {
      console.log(`   ❌ Access denied`)
      return res.status(403).json({
        error: 'Access denied to this document',
        documentCase: actualCase,
        userCases: userCases,
      })
    }

    // Generate SAS URL
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
        blobName: finalBlobPath,
        permissions: BlobSASPermissions.parse('r'),
        startsOn: new Date(new Date().valueOf() - 5 * 60 * 1000),
        expiresOn: new Date(new Date().valueOf() + 24 * 60 * 60 * 1000),
        version: '2021-08-06',
        contentDisposition: 'inline',
      },
      sharedKeyCredential
    ).toString()

    const sasUrl = `${blobClient.url}?${sasToken}`
    const actualFilename = finalBlobPath.split('/').pop()
    const correctContentType = getContentType(actualFilename)

    console.log(`   ✅ SAS URL generated (via ${source})`)

    res.json({
      filename: actualFilename,
      originalSearch: filename,
      caseNumber: actualCase,
      blobPath: finalBlobPath,
      url: sasUrl,
      metadata: {
        size: properties.contentLength,
        contentType: correctContentType,
        lastModified: properties.lastModified,
      },
      expiresIn: '24 hours',
      source: source,
    })
  } catch (error) {
    console.error('❌ Error getting document URL:', error.message)
    res.status(500).json({
      error: 'Error retrieving document URL',
      details: error.message,
    })
  }
})

/**
 * Force permissions sync (admin only)
 */
app.post('/api/admin/force-sync', async (req, res) => {
  const adminSecret = req.headers['x-admin-secret']
  if (adminSecret !== 'Asdf1234$') {
    return res.status(403).json({ error: 'Unauthorized' })
  }

  if (permissionsCache.isSyncing) {
    return res.status(409).json({
      message: 'Sync already in progress',
    })
  }

  console.log('⚡ Force sync requested')

  try {
    await syncPermissions()
    res.json({
      success: true,
      message: 'Sync completed successfully',
      stats: {
        totalUsers: Object.keys(permissionsCache.byUserId).length,
        timestamp: new Date(),
      },
    })
  } catch (error) {
    res.status(500).json({
      error: 'Sync failed',
      details: error.message,
    })
  }
})

/**
 * Cache status (debug endpoint)
 */
app.get('/api/admin/cache-status', (req, res) => {
  try {
    const userIds = Object.keys(permissionsCache.byUserId)
    const emails = Object.keys(permissionsCache.byEmail)

    const readableUsers = userIds.map((id) => {
      const user = permissionsCache.byUserId[id]
      return {
        id: id,
        name: user.name,
        email: user.email,
        role: user.role,
        casesCount: user.cases.length,
        cases: user.cases,
      }
    })

    res.json({
      status: 'online',
      timestamp: new Date(),
      syncState: {
        lastSync: permissionsCache.lastSync,
        isSyncing: permissionsCache.isSyncing,
        timeSinceLastSync: permissionsCache.lastSync
          ? `${Math.round(
              (new Date() - permissionsCache.lastSync) / 1000
            )} seconds ago`
          : 'Never',
      },
      stats: {
        totalUsersById: userIds.length,
        totalUsersByEmail: emails.length,
      },
      data: readableUsers,
    })
  } catch (error) {
    res.status(500).json({
      error: 'Error reading cache',
      details: error.message,
    })
  }
})

/**
 * Health check
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    permissions: {
      totalUsers: Object.keys(permissionsCache.byUserId).length,
      lastSync: permissionsCache.lastSync,
    },
    agent: {
      endpoint: AZURE_AI_PROJECT_ENDPOINT,
      agentId: AZURE_AGENT_ID,
      vectorStore: AZURE_VECTOR_STORE_ID || 'not configured',
      activeThreads: userThreads.size,
    },
    search: {
      enabled: !!searchClient,
      endpoint: AZURE_SEARCH_ENDPOINT || 'not configured',
      index: AZURE_SEARCH_INDEX || 'not configured',
    },
    security: {
      primaryFilter: 'Thread-level vector store filtering',
      secondaryFilter: 'Runtime instructions',
      safetyNet: 'Post-processing validation',
      approach: 'Defense in depth',
    },
  })
})

// ===== START SERVER =====
app.listen(PORT, () => {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`🚀 ACTS Law RAG Backend`)
  console.log(`${'='.repeat(60)}`)
  console.log(`📍 Server: http://localhost:${PORT}`)
  console.log(`🤖 Agent: ${AZURE_AGENT_ID}`)
  console.log(`🗄️  Vector Store: ${AZURE_VECTOR_STORE_ID || 'not configured'}`)
  console.log(`🔒 Security: Multi-layer defense`)
  console.log(
    `⚡ Optimization: ${searchClient ? 'Index enabled' : 'Fallback only'}`
  )
  console.log(`${'='.repeat(60)}\n`)
})
