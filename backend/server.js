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

// Inicializar Firebase Admin
try {
  const serviceAccount = JSON.parse(
    readFileSync('./firebase-service-account.json', 'utf8')
  )

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  })

  console.log('✅ Firebase Admin initialized successfully')
} catch (error) {
  console.error('❌ Error initializing Firebase Admin:', error.message)
  console.error(
    '⚠️  Make sure firebase-service-account.json exists in the backend folder'
  )
}

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

// ===== AZURE SEARCH CONFIGURATION (NUEVO) =====
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
    console.log(
      '✅ Azure Search client initialized for instant document lookup'
    )
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

/**
 * 🚀 Obtener blobPath desde Azure Search Index usando el título
 * Búsqueda flexible que maneja variaciones en nombres
 */
async function getBlobPathFromIndex(filename) {
  if (!searchClient) {
    console.warn('   ⚠️  Search client not available')
    return null
  }

  try {
    console.log(`   🔍 Searching index for: "${filename}"`)

    // Extraer palabras clave del filename (sin extensión, sin números, sin caracteres especiales)
    const keywords = filename
      .replace(/\.(pdf|docx?|xlsx?|msg|txt)$/i, '') // Quitar extensión
      .replace(/[_\-]/g, ' ') // Reemplazar guiones/underscores por espacios
      .replace(/\d{4}-\d{2}-\d{2}/g, '') // Quitar fechas YYYY-MM-DD
      .replace(/\d{2}-\d{2}-\d{2}/g, '') // Quitar fechas MM-DD-YY
      .replace(/\d{8}/g, '') // Quitar fechas YYYYMMDD
      .split(/\s+/)
      .filter((word) => word.length >= 4 && !/^\d+$/.test(word)) // Palabras >= 4 chars, no solo números
      .slice(0, 5) // Tomar las 5 primeras palabras importantes
      .join(' ')
      .trim()

    if (!keywords || keywords.length < 3) {
      console.log(`   ⚠️  No valid keywords extracted from: "${filename}"`)
      return null
    }

    console.log(`   🔑 Keywords: "${keywords}"`)

    // Búsqueda con las palabras clave
    const searchResults = await searchClient.search(keywords, {
      searchFields: ['title'],
      select: ['url', 'title'],
      top: 10, // Aumentar resultados para mejor chance
      queryType: 'simple',
      searchMode: 'any', // Buscar cualquier palabra clave
    })

    let bestMatch = null
    let bestScore = 0

    for await (const result of searchResults.results) {
      const docTitle = result.document.title || ''

      console.log(`      📄 Result: "${docTitle}" | Score: ${result.score}`)

      // Calcular similitud simple
      const docTitleLower = docTitle.toLowerCase()
      const filenameLower = filename.toLowerCase()
      const keywordsArray = keywords.toLowerCase().split(/\s+/)

      // Contar cuántas palabras clave coinciden
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
      // Al menos 50% de coincidencia
      // 🔧 LIMPIAR el blobPath antes de retornarlo
      let cleanPath = bestMatch.url

      // 1. Decodificar URL encoding (%20 → espacio, etc.)
      cleanPath = decodeURIComponent(cleanPath)

      // 2. Quitar caracteres extra al final (números solos, puntos, etc.)
      cleanPath = cleanPath.replace(/[0-9]+$/, '') // Quitar números al final
      cleanPath = cleanPath.replace(/\.+$/, '') // Quitar puntos al final

      console.log(
        `   ⚡ Found match (${Math.round(bestScore * 100)}%): "${
          bestMatch.title
        }"`
      )
      console.log(`   ⚡ BlobPath (cleaned): ${cleanPath}`)

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
 * 🐢 FALLBACK: Búsqueda tradicional en Blob Storage (solo si falla el índice)
 * Mantener solo para casos edge donde el índice no tenga el documento
 */
async function findDocumentInStorage(filename, userCases, containerClient) {
  console.log(`\n🔍 FALLBACK: Searching in Blob Storage for: "${filename}"`)

  const casesToSearch = userCases.includes('*') ? [''] : userCases

  // Búsqueda exacta por nombre
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
 * Ejecutar conversación del agente con filtrado por case_number
 */
async function runAgentConversation(threadId, userMessage, userCases) {
  try {
    // 1️⃣ Generar filtro técnico (Azure Search)
    const searchFilter = generateCaseNumberFilter(userCases)

    // Preparar Set de casos permitidos para validación lógica (Node.js)
    const allowedCasesSet = new Set(userCases.includes('*') ? [] : userCases)
    const isAdmin = userCases.includes('*')

    // 2️⃣ Instrucciones de seguridad para el Prompt (Capa 1 de defensa)
    const securityInstructions = isAdmin
      ? ''
      : `CRITICAL SECURITY RULE: You are authorized to access ONLY documents where the file path starts with one of these case numbers: [${userCases.join(
          ', '
        )}].
         The document paths in the index follow the format: "CaseNumber/Category/FileName".
         If a search result path starts with a different number (e.g., "25096/..."), IGNORE IT completely. 
         Do not reveal information from unauthorized cases.`

    const contextMessage = `${securityInstructions}\n\nUser Question: ${userMessage}`

    await aiProjectClient.agents.messages.create(
      threadId,
      'user',
      contextMessage
    )
    console.log('   📩 Message added to thread')

    // 3️⃣ Opciones de ejecución
    const runOptions = {
      additional_instructions: securityInstructions,
    }

    if (searchFilter) {
      try {
        runOptions.tool_resources = {
          file_search: { filter: searchFilter },
        }
        console.log('   🔒 Applied case_number filter (Request layer)')
      } catch (error) {
        console.warn('   ⚠️  Could not apply filter:', error.message)
      }
    }

    // 4️⃣ Ejecutar Agente
    let run = await aiProjectClient.agents.runs.create(
      threadId,
      AZURE_AGENT_ID,
      runOptions
    )
    console.log(`   🏃 Run started: ${run.id}`)

    // Polling
    let iterations = 0
    const maxIterations = 60
    while (run.status === 'queued' || run.status === 'in_progress') {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      run = await aiProjectClient.agents.runs.get(threadId, run.id)
      iterations++
      if (iterations >= maxIterations) throw new Error('Agent run timeout')
    }

    if (run.status === 'failed') {
      throw new Error(
        `Agent run failed: ${run.lastError?.message || 'Unknown error'}`
      )
    }

    // 5️⃣ Obtener Mensaje del Asistente
    const messagesResponse = await aiProjectClient.agents.messages.list(
      threadId,
      { order: 'desc', limit: 1 }
    )
    let assistantMessage = ''
    let messageAnnotations = []

    for await (const message of messagesResponse) {
      if (message.role === 'assistant') {
        for (const content of message.content) {
          if (content.type === 'text') {
            assistantMessage = content.text.value
            if (content.text.annotations)
              messageAnnotations = content.text.annotations
          }
        }
        break
      }
    }

    // =========================================================
    // 🚨 FIREWALL & KILL SWITCH (Capa 2 de defensa)
    // =========================================================
    console.log('   🛡️ Validating citations and security...')

    let citations = []
    let detectedUnauthorizedAccess = false
    let unauthorizedCaseDetected = null

    if (messageAnnotations.length > 0) {
      for (const annotation of messageAnnotations) {
        try {
          // A. Identificar Título
          let docTitle = ''
          if (annotation.type === 'url_citation' && annotation.urlCitation) {
            docTitle = annotation.urlCitation.title
          } else if (
            annotation.type === 'file_citation' &&
            annotation.file_citation
          ) {
            const quote = annotation.file_citation.quote || ''
            const match = quote.match(
              /\b\d{5}_\d{8}_\d+\.txt\b|\b[\w-]+\.(txt|pdf|msg|docx)\b/i
            )
            docTitle = match ? match[0] : quote.substring(0, 50)
          } else if (annotation.type === 'file_path' && annotation.file_path) {
            docTitle = annotation.file_path.file_id
          }

          // B. Obtener ruta real del índice
          const realBlobPath = await getBlobPathFromIndex(docTitle || 'unknown')

          // C. VALIDACIÓN ESTRICTA
          if (realBlobPath) {
            const pathParts = realBlobPath.split('/')
            const docCase = pathParts[0] // Ej: "25096"

            // Si es un número de caso y NO está en la lista permitida
            if (/^\d+$/.test(docCase)) {
              if (!isAdmin && !allowedCasesSet.has(docCase)) {
                console.error(
                  `   ⛔ SECURITY ALERT: Agent accessed unauthorized Case ${docCase}!`
                )
                detectedUnauthorizedAccess = true
                unauthorizedCaseDetected = docCase
                // ACTIVAMOS EL KILL SWITCH: Romper el bucle inmediatamente.
                break
              }
            }
          }

          // Si llegamos aquí, la cita es segura. La procesamos.
          let citationInfo = {
            title: docTitle,
            blobPath: realBlobPath,
            content: 'Authorized content',
            chunk: '',
          }

          if (
            annotation.startIndex !== undefined &&
            annotation.endIndex !== undefined
          ) {
            const s = Math.max(0, annotation.startIndex - 200)
            const e = Math.min(
              assistantMessage.length,
              annotation.endIndex + 200
            )
            citationInfo.chunk = assistantMessage
              .substring(s, e)
              .replace(/【[^】]*】/g, '')
              .trim()
          }

          citations.push(citationInfo)
        } catch (e) {
          console.error('Annotation error:', e.message)
        }
      }
    }

    // 7️⃣ PREPARAR RESPUESTA FINAL
    let cleanMessage = assistantMessage.replace(/【[^】]*】/g, '').trim()

    // 🔥 KILL SWITCH ACTIVADO 🔥
    // Si se detectó acceso ilegal, sobrescribimos la respuesta del agente.
    if (detectedUnauthorizedAccess) {
      console.error(
        `   ☢️ KILL SWITCH EXECUTED: Wiping response to prevent Case ${unauthorizedCaseDetected} leakage.`
      )

      cleanMessage =
        `⚠️ **Access Denied to Information**\n\n` +
        `I apologize, but I cannot answer this specific question because the relevant documents belong to **Case ${unauthorizedCaseDetected}**, which you are not authorized to view.\n\n` +
        `Your access is strictly limited to cases: [${userCases.join(', ')}].`

      citations = [] // Borramos todas las citas para no dejar rastro.
    }

    // 8️⃣ Lógica auxiliar (snippets, términos)
    // Solo ejecutamos si NO hubo bloqueo de seguridad para ahorrar recursos
    let searchTerms = []
    let contextSnippets = []

    if (!detectedUnauthorizedAccess) {
      // ... (Tu lógica original de snippets, la incluimos aquí simplificada) ...
      // Puedes volver a pegar tu función 'extractSearchTermsFromChunks' y 'extractContextSnippets'
      // aquí dentro si las necesitas para el frontend.
    }

    console.log(
      `   ✅ Response ready with ${citations.length} citations (Blocked: ${detectedUnauthorizedAccess})`
    )

    return {
      message: cleanMessage,
      citations: citations,
      searchTerms: searchTerms,
      contextSnippets: contextSnippets,
      securityInfo: {
        appliedFilter: searchFilter !== null,
        blockedUnauthorizedCitations: detectedUnauthorizedAccess,
      },
    }
  } catch (error) {
    console.error('   ❌ Error in agent conversation:', error.message)
    throw error
  }
}

// ===== GESTIÓN DE PERMISOS EN MEMORIA =====
// Ahora guardamos dos índices para búsquedas rápidas
let permissionsCache = {
  byUserId: {}, // Mapa: userID (int) -> { info... }
  byEmail: {}, // Mapa: email (string) -> { info... }
  lastSync: null,
  isSyncing: false,
}

const SA_API_BASE_URL = process.env.SA_API_BASE_URL
// Estos son los credenciales del "System User" para hacer el Sync en background
const SA_SYSTEM_USERNAME = process.env.SA_USERNAME
const SA_SYSTEM_PASSWORD = process.env.SA_PASSWORD

/**
 * 🔄 SINCRONIZACIÓN AUTOMÁTICA (Background)
 * Consulta Azure y luego pregunta a SA quién está en esos casos.
 */
async function syncPermissions() {
  if (permissionsCache.isSyncing) return
  permissionsCache.isSyncing = true
  console.log('\n🔄 [SYNC] Iniciando sincronización de permisos...')

  try {
    // 1. Autenticar Usuario de Sistema (para poder consultar la API)
    const authRes = await axios.post(`${SA_API_BASE_URL}/Users/authenticate`, {
      Username: SA_SYSTEM_USERNAME,
      Password: SA_SYSTEM_PASSWORD,
    })
    const serviceToken = authRes.data.token
    console.log('   ✅ [SYNC] Autenticado como sistema')

    // 2. Obtener lista de casos desde Azure
    if (!AZURE_STORAGE_CONNECTION_STRING)
      throw new Error('Falta connection string')
    const blobServiceClient = BlobServiceClient.fromConnectionString(
      AZURE_STORAGE_CONNECTION_STRING
    )
    const containerClient =
      blobServiceClient.getContainerClient(AZURE_CONTAINER_NAME)

    const caseNumbers = new Set()
    // Listamos blobs para ver qué carpetas de casos existen
    for await (const blob of containerClient.listBlobsFlat()) {
      const parts = blob.name.split('/') // asume estructura "21546/archivo.pdf"
      if (parts.length > 0 && /^\d+$/.test(parts[0])) {
        caseNumbers.add(parts[0])
      }
    }
    const casesList = Array.from(caseNumbers)
    console.log(`   📂 [SYNC] Casos encontrados en Azure: ${casesList.length}`)

    // 3. Consultar Staff en SA caso por caso
    const tempByUserId = {}
    const tempByEmail = {}

    // Procesamos secuencialmente para no matar la API de SA (puedes paralelizar con p-limit si es lento)
    let processed = 0
    for (const caseNum of casesList) {
      try {
        const staffRes = await axios.get(
          `${SA_API_BASE_URL}/case/staff/byCaseNumber?CaseNumber=${caseNum}`,
          {
            headers: { Authorization: `Bearer ${serviceToken}` },
          }
        )

        const staffList = staffRes.data // Array de objetos usuario

        if (Array.isArray(staffList)) {
          staffList.forEach((staff) => {
            // staff = { userID: 814, firstName: "AI", email: "...", ... }

            const uid = staff.userID
            const email = staff.email ? staff.email.toLowerCase().trim() : null

            // Inicializar objeto si no existe
            if (uid && !tempByUserId[uid]) {
              tempByUserId[uid] = {
                name: `${staff.firstName} ${staff.lastName}`,
                email: email,
                role: staff.role,
                cases: [],
              }
            }

            // Agregar caso al usuario por ID
            if (uid && !tempByUserId[uid].cases.includes(caseNum)) {
              tempByUserId[uid].cases.push(caseNum)
            }

            // Mapeo también por email (para Microsoft Login)
            if (email) {
              // Referenciamos al mismo objeto para ahorrar memoria
              tempByEmail[email] = tempByUserId[uid]
            }
          })
        }
      } catch (e) {
        // Ignorar 404s o errores puntuales de casos
      }
      processed++
      if (processed % 20 === 0)
        console.log(`     ... procesados ${processed}/${casesList.length}`)
    }

    // 4. Guardar en caché
    permissionsCache.byUserId = tempByUserId
    permissionsCache.byEmail = tempByEmail
    permissionsCache.lastSync = new Date()

    console.log(
      `✅ [SYNC] Completado. Usuarios indexados: ${
        Object.keys(tempByUserId).length
      }`
    )
  } catch (error) {
    console.error('❌ [SYNC] Error:', error.message)
  } finally {
    permissionsCache.isSyncing = false
  }
}

// Ejecutar sincronización al iniciar y cada hora
syncPermissions()
setInterval(syncPermissions, 60 * 60 * 1000)

// ===== ENDPOINTS =====

// Login
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body // Recibimos 'username', NO 'email'

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' })
  }

  try {
    console.log(`🔐 Intentando login SA para usuario: ${username}`)

    // 1. Autenticar credenciales contra Smart Advocate
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
      // authData = { "userID": 814, "token": "...", "username": "OpenAI" }
    } catch (e) {
      console.log(`   ❌ SA rechazó credenciales: ${e.message}`)
      return res.status(401).json({ error: 'Invalid username or password' })
    }

    if (!authData || !authData.userID) {
      return res
        .status(401)
        .json({ error: 'Authentication failed (No UserID)' })
    }

    const saUserID = authData.userID
    console.log(`   ✅ Auth exitosa. SA UserID: ${saUserID}`)

    // 2. Buscar permisos en nuestra caché usando el UserID
    const userProfile = permissionsCache.byUserId[saUserID]

    let userCases = []
    let displayName = username
    let userEmail = `${username}@actslaw.com` // Fallback si no hay email

    if (userProfile) {
      userCases = userProfile.cases || []
      displayName = userProfile.name || username
      userEmail = userProfile.email || userEmail
      console.log(`   📂 Casos encontrados en caché: ${userCases.length}`)
    } else {
      console.log(
        `   ⚠️ Usuario autenticado pero sin casos asignados en caché (o sync pendiente).`
      )
    }

    // 3. Generar Token
    const sessionId = `${username}-${Date.now()}`
    const token = jwt.sign(
      {
        email: userEmail, // Usamos el email para consistencia interna
        saUsername: username, // Guardamos el username original
        saUserID: saUserID, // Guardamos el ID de SA
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
 * Verifica el token de Firebase y autentica al usuario
 */
app.post('/api/auth/microsoft', async (req, res) => {
  try {
    const { idToken } = req.body

    if (!idToken) {
      return res.status(400).json({ error: 'ID token required' })
    }

    console.log('\n🔐 Microsoft Authentication Request')
    console.log('   Verifying Firebase ID token...')

    // Verificar el token con Firebase Admin
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

    console.log('   ✅ Token verified successfully')
    console.log(`   👤 Email: ${email}`)
    console.log(`   🆔 UID: ${uid}`)

    if (!email) {
      return res.status(400).json({
        error: 'Email not found in token',
      })
    }

    // Verificar si el usuario tiene permisos en el sistema
    const normalizedEmail = email.toLowerCase().trim()
    const user = userPermissions[normalizedEmail]

    if (!user) {
      console.log('   ❌ User not authorized in system')
      console.log(`   📧 Attempted email: ${normalizedEmail}`)

      return res.status(403).json({
        error: 'Access denied',
        message:
          'Your email is not authorized to access this system. Please contact your administrator.',
        email: normalizedEmail,
      })
    }

    // Generar sesión y JWT
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
    console.log(`   🔑 Session: ${sessionId}`)
    console.log(`${'='.repeat(60)}\n`)

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
    console.error('\n❌ ERROR in Microsoft authentication:')
    console.error('Details:', error.message)
    console.error(`${'='.repeat(60)}\n`)

    res.status(500).json({
      error: 'Authentication error',
      details: error.message,
    })
  }
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

// Chat endpoint
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

    const threadId = await getOrCreateThread(sessionId)
    const response = await runAgentConversation(threadId, message, userCases)

    console.log(
      `✅ Response ready with ${response.citations.length} citations\n`
    )

    res.json(response)
  } catch (error) {
    console.error('\n❌ ERROR in /api/chat:')
    console.error('Details:', error.message)
    console.error(`${'='.repeat(60)}\n`)

    res.status(500).json({
      error: 'Error processing query with agent',
      details: error.message,
    })
  }
})

// Clear chat
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

// Reload permissions
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

// Permissions info
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

// 🚀 OPTIMIZED: Get document URL (usa índice primero, fallback después)
app.post('/api/documents/get-url', authenticateToken, async (req, res) => {
  try {
    const { filename, blobPath } = req.body
    const userCases = req.user.cases

    if (!containerClient) {
      return res.status(503).json({
        error: 'Azure Storage not configured',
      })
    }

    console.log(`\n📄 Getting document: ${filename}`)

    let finalBlobPath = blobPath
    let blobClient = null
    let source = 'unknown'

    // ESTRATEGIA 1: Si viene blobPath del chat (desde el índice), usarlo directamente
    if (finalBlobPath) {
      console.log(`   ⚡ Using blobPath from index: ${finalBlobPath}`)
      blobClient = containerClient.getBlobClient(finalBlobPath)

      try {
        const exists = await blobClient.exists()
        if (exists) {
          console.log(`   ✅ Found instantly via index!`)
          source = 'index-direct'
        } else {
          console.log(`   ⚠️  Blob not found at indexed path, trying search...`)
          finalBlobPath = null
        }
      } catch (e) {
        console.warn(`   ⚠️  Error checking blob:`, e.message)
        finalBlobPath = null
      }
    }

    // ESTRATEGIA 2: Buscar en el índice por título
    if (!finalBlobPath && filename && searchClient) {
      console.log(`   🔍 Searching in Azure Search Index...`)
      finalBlobPath = await getBlobPathFromIndex(filename)

      if (finalBlobPath) {
        blobClient = containerClient.getBlobClient(finalBlobPath)

        try {
          const exists = await blobClient.exists()
          if (exists) {
            console.log(`   ✅ Found via index search!`)
            source = 'index-search'
          } else {
            finalBlobPath = null
          }
        } catch (e) {
          finalBlobPath = null
        }
      }
    }

    // ESTRATEGIA 3: FALLBACK - búsqueda en Blob Storage (solo si falla todo)
    if (!finalBlobPath && filename) {
      console.log(`   🐢 Using fallback blob search...`)
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

    // Verificar permisos
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

    // Generar SAS URL
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

    const sourceEmoji =
      source === 'index-direct' || source === 'index-search' ? '⚡' : '🐢'
    console.log(`   ${sourceEmoji} SAS URL generated (via ${source})\n`)

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

// Proxy endpoint para servir documentos
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

    // Buscar usando el índice primero
    let blobPath = await getBlobPathFromIndex(filename)
    let blobClient = null

    if (blobPath) {
      console.log(`   ⚡ Found via index: ${blobPath}`)
      blobClient = containerClient.getBlobClient(blobPath)

      const exists = await blobClient.exists()
      if (!exists) {
        console.log(`   ⚠️  Blob doesn't exist, using fallback`)
        blobPath = null
      }
    }

    // Fallback a búsqueda tradicional
    if (!blobPath) {
      console.log(`   🐢 Using fallback search`)
      const result = await findDocumentInStorage(
        filename,
        userCases,
        containerClient
      )
      blobPath = result.blobPath
      blobClient = result.blobClient
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
      const parts = range.replace(/bytes=/, '').split('-')
      const start = parseInt(parts[0], 10)
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1
      const chunkSize = end - start + 1

      const downloadResponse = await blobClient.download(start, chunkSize)

      res.status(206)
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`)
      res.setHeader('Accept-Ranges', 'bytes')
      res.setHeader('Content-Length', chunkSize)
      res.setHeader('Content-Type', correctContentType)
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader(
        'Access-Control-Expose-Headers',
        'Content-Range, Content-Length, Content-Type, Accept-Ranges'
      )

      downloadResponse.readableStreamBody.pipe(res)
    } else {
      const downloadResponse = await blobClient.download()

      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Content-Type', correctContentType)
      res.setHeader('Content-Length', fileSize)
      res.setHeader(
        'Content-Disposition',
        `inline; filename="${actualFilename}"`
      )
      res.setHeader('Accept-Ranges', 'bytes')
      res.setHeader('Cache-Control', 'public, max-age=3600')

      downloadResponse.readableStreamBody.pipe(res)
    }

    console.log(`   ✅ Proxy complete`)
  } catch (error) {
    console.error('❌ Proxy error:', error.message)
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
    search: {
      enabled: !!searchClient,
      endpoint: AZURE_SEARCH_ENDPOINT || 'not configured',
      index: AZURE_SEARCH_INDEX || 'not configured',
      status: searchClient ? '⚡ instant lookup enabled' : '🐢 fallback only',
    },
    optimization: {
      instantDocumentLoad: !!searchClient,
      fallbackAvailable: true,
    },
    security: {
      filterType: 'case_number (Azure Search)',
      validationLayer: 'DISABLED - trusting Azure filter',
    },
  })
})

// ===== ENDPOINT PARA FORZAR LA SINCRONIZACIÓN MANUALMENTE =====
// Llámalo cuando asignes un caso nuevo y necesites que se refleje YA.
app.post('/api/admin/force-sync', async (req, res) => {
  // Opcional: Proteger esto con un secret header simple para que nadie más lo llame
  const adminSecret = req.headers['x-admin-secret']
  if (adminSecret !== 'Asdf1234$') {
    return res.status(403).json({ error: 'Unauthorized' })
  }

  if (permissionsCache.isSyncing) {
    return res.status(409).json({
      message: '⚠️ Ya hay una sincronización en curso, espera unos segundos.',
    })
  }

  console.log('⚡ Forzando sincronización manual por petición HTTP...')

  // Ejecutamos la sync (no esperamos a que termine para responder al cliente si queremos que sea rápido,
  // pero mejor usamos await para confirmar que se hizo).
  try {
    await syncPermissions()
    res.json({
      success: true,
      message: '✅ Sincronización completada exitosamente.',
      stats: {
        totalUsers: Object.keys(permissionsCache.byUserId).length,
        timestamp: new Date(),
      },
    })
  } catch (error) {
    res
      .status(500)
      .json({ error: 'Falló la sincronización manual', details: error.message })
  }
})

// ===== ENDPOINT PARA INSPECCIONAR EL CACHÉ (DEBUG) =====
app.get('/api/admin/cache-status', (req, res) => {
  // Opcional: Si quieres restringirlo solo a tu usuario admin
  // if (req.user.email !== 'tu-email@actslaw.com') {
  //   return res.status(403).json({ error: 'Solo administradores pueden ver esto' });
  // }

  try {
    // Calculamos estadísticas rápidas
    const userIds = Object.keys(permissionsCache.byUserId)
    const emails = Object.keys(permissionsCache.byEmail)

    // Transformamos el objeto a un array más legible para la respuesta JSON
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
        totalUsersByEmail: emails.length, // Debería ser igual o menor si hay emails null
      },
      // Mostramos la data formateada
      data: readableUsers,
    })
  } catch (error) {
    res
      .status(500)
      .json({ error: 'Error leyendo caché', details: error.message })
  }
})

app.listen(PORT, () => {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`🚀 ACTS Law RAG Backend (OPTIMIZED)`)
  console.log(`${'='.repeat(60)}`)
  console.log(`📍 Server: http://localhost:${PORT}`)
  console.log(`🤖 Agent: ${AZURE_AGENT_ID}`)
  console.log(`🔒 Security: Azure Search filtering`)
  console.log(
    `⚡ Optimization: ${
      searchClient ? 'Instant lookup ENABLED' : 'Fallback only'
    }`
  )
  console.log(`${'='.repeat(60)}\n`)
})
