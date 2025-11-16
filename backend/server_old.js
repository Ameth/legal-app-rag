import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import jwt from 'jsonwebtoken'
import axios from 'axios'
import fs from 'fs'
import path from 'path'

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
      console.warn('⚠️  No se encontró permissions-cache.json. Usando permisos demo.')
      return loadDemoPermissions()
    }

    const data = JSON.parse(fs.readFileSync(PERMISSIONS_FILE, 'utf-8'))
    
    userPermissions = data.permissions
    permissionsMetadata = data.metadata

    // Agregar passwords temporales para testing
    Object.keys(userPermissions).forEach(email => {
      if (!userPermissions[email].password) {
        userPermissions[email].password = 'test123'
      }
    })

    console.log('\n✅ Permisos cargados exitosamente:')
    console.log(`   📊 Total usuarios: ${Object.keys(userPermissions).length}`)
    console.log(`   📁 Total casos: ${permissionsMetadata.totalCases}`)
    console.log(`   🕐 Última sincronización: ${new Date(permissionsMetadata.lastSync).toLocaleString()}`)
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
    mode: 'DEMO'
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

// ===== AZURE CONFIGURATION =====
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT
const AZURE_OPENAI_KEY = process.env.AZURE_OPENAI_KEY
const AZURE_OPENAI_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT
const AZURE_EMBEDDING_DEPLOYMENT = process.env.AZURE_EMBEDDING_DEPLOYMENT
const AZURE_SEARCH_ENDPOINT = process.env.AZURE_SEARCH_ENDPOINT
const AZURE_SEARCH_KEY = process.env.AZURE_SEARCH_KEY
const AZURE_SEARCH_INDEX = process.env.AZURE_SEARCH_INDEX

// ===== UTILITIES =====
const JWT_SECRET = process.env.JWT_SECRET

/**
 * Expande fechas en múltiples formatos para mejorar búsqueda
 * "September 17, 2025" → ["September 17", "09/17/2025", "2025-09-17", "20250917", "Sept 17"]
 */
function expandDateFormats(query) {
  // Detectar fechas en formato "Month Day, Year" o "Month Day Year"
  const monthNames = {
    january: '01', february: '02', march: '03', april: '04',
    may: '05', june: '06', july: '07', august: '08',
    september: '09', october: '10', november: '11', december: '12',
    jan: '01', feb: '02', mar: '03', apr: '04',
    jun: '06', jul: '07', aug: '08', sep: '09', sept: '09',
    oct: '10', nov: '11', dec: '12'
  }
  
  const datePattern = /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{1,2})[,\s]+(\d{4})\b/gi
  
  let expandedQuery = query
  const matches = [...query.matchAll(datePattern)]
  
  if (matches.length > 0) {
    const dateFormats = []
    
    matches.forEach(match => {
      const month = match[1].toLowerCase()
      const day = match[2].padStart(2, '0')
      const year = match[3]
      const monthNum = monthNames[month]
      
      if (monthNum) {
        // Agregar múltiples formatos
        dateFormats.push(`${monthNum}/${day}/${year}`)      // 09/17/2025
        dateFormats.push(`${year}-${monthNum}-${day}`)      // 2025-09-17
        dateFormats.push(`${year}${monthNum}${day}`)        // 20250917
        dateFormats.push(`${match[1]} ${day}`)              // September 17
      }
    })
    
    // Agregar todos los formatos a la query
    if (dateFormats.length > 0) {
      expandedQuery = `${query} ${dateFormats.join(' ')}`
    }
  }
  
  return expandedQuery
}

// Generate OData filter based on allowed cases
function generateFilter(cases) {
  if (cases.includes('*')) {
    return null // No filter - full access
  }
  return null
}

// Función auxiliar para verificar acceso a un documento
function hasAccessToDocument(parentId, allowedCases) {
  if (allowedCases.includes('*')) return true

  try {
    const decodedPath = Buffer.from(parentId, 'base64').toString('utf-8')
    return allowedCases.some((caseNum) => decodedPath.includes(`/${caseNum}/`))
  } catch (error) {
    console.error('Error decoding parent_id:', error)
    return false
  }
}

// ===== CLASSIFICATION FUNCTION =====
async function needsRAGSearch(message, conversationHistory) {
  if (conversationHistory.length === 0) {
    return true
  }

  // Patrones que SOLO aplican cuando se refieren explícitamente a la respuesta anterior
  const followUpPatterns = [
    /^(translate|traduci?)(r)?\s+(that|this|it|eso|esto|lo anterior)/i,
    /^(summarize|resume|resumen)\s+(that|this|it|what you (just )?said|your (previous )?answer|eso|esto|lo anterior)/i,
    /^(explain|explica(me)?)\s+(that|this|it|what you (just )?said|eso|esto|lo anterior)/i,
    /^(make it |more |más )(shorter|brief|concise|corto|breve)/i,
    /^(say (it|that) in|di(lo|me) en|en)\s+(spanish|english|español|inglés)/i,
    /^(what does (that|it|this) mean|qué significa (eso|esto))/i,
    /^(that|this|it|eso|esto)$/i,
    /^(the previous|what you (just )?said|your (last |previous )?answer|lo anterior|la respuesta anterior)/i,
    /^(tell me more|dime más|elabora(te)?|expand on (that|it|this))/i,
    /^(simplify|simplifica|make it simpler)/i,
    /^(rephrase|reformula|say (it|that) (differently|again))/i,
    /^(give me an example|dame un ejemplo)$/i,
  ]

  const isObviousFollowUp = followUpPatterns.some((pattern) =>
    pattern.test(message.trim())
  )

  if (isObviousFollowUp) {
    console.log(
      '   ⚡ Quick classification: Follow-up question (no RAG needed)'
    )
    return false
  }

  console.log('   🤔 Analyzing if RAG search is needed...')

  const classificationPrompt = `You are a classifier that determines if a user question requires searching a document database (RAG) or can be answered using only the conversation history.

CONVERSATION HISTORY:
${conversationHistory
  .slice(-6)
  .map((msg) => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
  .join('\n')}

NEW USER QUESTION: "${message}"

CRITICAL ANALYSIS RULES:
1. If the question mentions SPECIFIC information (case numbers, dates, note IDs, document names, people's names, specific events) → RAG NEEDED
2. If the question asks for a "summary" or "overview" of NEW information not yet discussed → RAG NEEDED
3. If the question only asks to modify/reformat/translate the PREVIOUS assistant response → NO RAG
4. If the question uses pronouns like "that", "it", "this" referring to previous answer → NO RAG
5. If conversation history is empty or doesn't contain relevant information → RAG NEEDED

EXAMPLES:
- "Give me a summary of the Zoom meeting from September 17th" → RAG (specific new info)
- "Summarize what you just told me" → NO RAG (referring to previous response)
- "What happened in case 25096?" → RAG (specific case)
- "Translate that to Spanish" → NO RAG (referring to previous response)
- "What are the notes about Jeff Hughes?" → RAG (specific person, new info)
- "Explain it more simply" → NO RAG (referring to previous response)

Respond with ONLY ONE WORD:
- "RAG" if it needs to search documents for NEW information
- "CONTEXT" if it can be answered from conversation history`

  try {
    const response = await axios.post(
      `${AZURE_OPENAI_ENDPOINT}/openai/deployments/${AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=2024-08-01-preview`,
      {
        messages: [
          {
            role: 'user',
            content: classificationPrompt,
          },
        ],
        max_tokens: 10,
        temperature: 0,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'api-key': AZURE_OPENAI_KEY,
        },
      }
    )

    const classification = response.data.choices[0].message.content
      .trim()
      .toUpperCase()

    const needsRAG = classification.includes('RAG')
    console.log(
      `   ${needsRAG ? '🔍' : '💬'} Classification result: ${
        needsRAG ? 'RAG SEARCH NEEDED' : 'CONTEXT ONLY'
      }`
    )
    return needsRAG
  } catch (error) {
    console.error('   ⚠️  Classification error, defaulting to RAG search')
    return true
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

  // Generate JWT
  const token = jwt.sign(
    {
      email: normalizedEmail,
      name: user.name,
      cases: user.cases,
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

// Chat endpoint with intelligent RAG classification
app.post('/api/chat', authenticateToken, async (req, res) => {
  try {
    const { message, conversationHistory = [] } = req.body
    const userCases = req.user.cases

    if (!message) {
      return res.status(400).json({ error: 'Message required' })
    }

    console.log(`\n${'='.repeat(60)}`)
    console.log(`🔍 NEW CHAT REQUEST`)
    console.log(`User: ${req.user.email} (${req.user.name})`)
    console.log(`Allowed Cases: ${userCases.join(', ')}`)
    console.log(`Question: ${message}`)
    console.log(`${'='.repeat(60)}\n`)

    // PASO 0: Determine if RAG search is needed
    const requiresRAG = await needsRAGSearch(message, conversationHistory)

    if (!requiresRAG) {
      console.log('💬 Answering from conversation context only (NO RAG)\n')

      const conversationMessages = [
        {
          role: 'system',
          content: `You are a specialized legal assistant for ACTS Law firm. 

The user is asking a follow-up question about the previous conversation. Answer based ONLY on the conversation history provided below.

IMPORTANT RULES:
- Use only information from the conversation history
- Be helpful and answer the user's follow-up question
- If asked to translate, translate accurately
- If asked to summarize, provide a concise summary
- If asked to explain, explain clearly
- Maintain conversation context and continuity
- Keep the document number from where you get the information
- Be professional and precise`,
        },
      ]

      const recentHistory = conversationHistory
        .filter((msg) => msg.role !== 'error')
        .slice(-10)
        .map((msg) => ({
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: msg.content,
        }))

      conversationMessages.push(...recentHistory)
      conversationMessages.push({
        role: 'user',
        content: message,
      })

      const completionResponse = await axios.post(
        `${AZURE_OPENAI_ENDPOINT}/openai/deployments/${AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=2024-08-01-preview`,
        {
          messages: conversationMessages,
          max_tokens: 1500,
          temperature: 0.1,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'api-key': AZURE_OPENAI_KEY,
          },
        }
      )

      const assistantMessage =
        completionResponse.data.choices[0].message.content

      console.log(
        `✅ Response generated from context only (0 RAG searches, 💰 cost savings!)\n`
      )

      return res.json({
        message: assistantMessage,
        citations: [],
      })
    }

    console.log('🔍 RAG search required, proceeding with document search\n')

    // Expandir query con múltiples formatos de fecha
    const expandedQuery = expandDateFormats(message)
    if (expandedQuery !== message) {
      console.log(`📅 Date formats expanded in query`)
      console.log(`   Original: ${message}`)
      console.log(`   Expanded: ${expandedQuery}`)
    }

    // PASO 1: Generar embedding de la pregunta (con query expandida)
    console.log('📊 Step 1: Generating embedding...')
    const embeddingResponse = await axios.post(
      `${AZURE_OPENAI_ENDPOINT}/openai/deployments/${AZURE_EMBEDDING_DEPLOYMENT}/embeddings?api-version=2023-05-15`,
      {
        input: expandedQuery,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'api-key': AZURE_OPENAI_KEY,
        },
      }
    )

    const queryEmbedding = embeddingResponse.data.data[0].embedding

    // PASO 2: Buscar en Azure Search con vector similarity (más resultados para mejor filtrado)
    console.log('🔎 Step 2: Searching Azure Search (hybrid)...')
    const searchResponse = await axios.post(
      `${AZURE_SEARCH_ENDPOINT}/indexes/${AZURE_SEARCH_INDEX}/docs/search?api-version=2023-11-01`,
      {
        search: expandedQuery,
        vectorQueries: [
          {
            kind: 'vector',
            vector: queryEmbedding,
            fields: 'text_vector',
            k: 100, // Aumentado de 50 a 100 para encontrar más candidatos
          },
        ],
        select: 'chunk_id,parent_id,chunk,title',
        top: 100, // Aumentado de 50 a 100
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'api-key': AZURE_SEARCH_KEY,
        },
      }
    )

    const allResults = searchResponse.data.value
    console.log(`   Found ${allResults.length} documents in Azure Search`)

    // PASO 3: Filtrar por casos permitidos usando parent_id
    console.log('🔒 Step 3: Filtering by allowed cases...')
    const filteredResults = allResults.filter((doc) => {
      if (userCases.includes('*')) return true

      try {
        const decodedPath = Buffer.from(doc.parent_id, 'base64').toString(
          'utf-8'
        )

        const hasAccess = userCases.some((caseNum) =>
          decodedPath.includes(`/${caseNum}/`)
        )

        if (hasAccess) {
          console.log(`   ✅ Access granted: ${decodedPath}`)
        } else {
          console.log(`   ❌ Access denied: ${decodedPath}`)
        }

        return hasAccess
      } catch (error) {
        console.error(`   ⚠️  Error decoding parent_id: ${error.message}`)
        return false
      }
    })

    console.log(
      `   Filtered: ${filteredResults.length} / ${allResults.length} documents`
    )

    if (filteredResults.length === 0) {
      console.log('⚠️  No documents found after filtering\n')
      return res.json({
        message: `🔒 **Access Restricted**\n\nYou don't have permission to access the requested information.\n\n**To gain access:**\n- Contact your system administrator to request permissions for additional cases\n- Verify that you're inquiring about documents within your authorized cases\n\n*For permission requests or assistance, please contact your administrator.*`,
        citations: [],
      })
    }

    // PASO 4: Preparar contexto para el LLM (más documentos para mejor cobertura)
    console.log('🤖 Step 4: Preparing context for LLM...')
    const context = filteredResults
      .slice(0, 30) // Aumentado de 15 a 30 para mejor cobertura
      .map((doc, idx) => {
        const decodedPath = Buffer.from(doc.parent_id, 'base64').toString(
          'utf-8'
        )
        return `[Document ${idx + 1}] (${doc.title || decodedPath})\n${
          doc.chunk
        }`
      })
      .join('\n\n---\n\n')

    // PASO 5: Llamar a Azure OpenAI con el historial del contexto
    console.log('💬 Step 5: Calling Azure OpenAI with conversation history...')

    const conversationMessages = [
      {
        role: 'system',
        content: `You are an intelligent legal assistant for ACTS Law firm. Answer questions based on the provided documents and conversation context.

CRITICAL INSTRUCTIONS:

1. **DATE FLEXIBILITY - EXTREMELY IMPORTANT:**
   - Understand that dates can be written in MANY formats:
     * "September 17, 2025" = "09/17/2025" = "2025-09-17" = "20250917" = "Sept 17, 2025"
     * "Date: 09/17/2025 15:04:00" means September 17, 2025 at 3:04 PM
   - When user asks for "September 17", search for ANY date format that matches
   - Don't say "no information" if you see a different date format - MATCH THE DATE

2. **ALWAYS BE SPECIFIC AND HELPFUL:**
   - When user asks vague questions, ask for clarification (e.g., "Which case?")
   - If information IS FOUND, provide detailed, helpful responses
   - Include relevant details like dates, names, note IDs, and case numbers

3. **UNDERSTAND USER INTENT:**
   - "Give me a summary of the Zoom meeting from [date]" → Search notes/documents from that date
   - "What are the notes about [topic]?" → Search all notes about that topic
   - "Tell me about case [number]" → Provide comprehensive information
   - If user mentions dates, names, or events → they want NEW information from documents

4. **PRIORITIZE CASE NOTES:**
   - Notes from the /notes/ folder contain important meeting summaries, calls, expert opinions
   - Look for keywords like "Zoom meeting", "meeting with", "deposition", etc.
   - Notes have metadata: Note ID, Date, Author, Note Type, Subject

5. **HANDLE AMBIGUOUS QUESTIONS:**
   - If case number missing: "Which case? (e.g., 25092, 25096)"
   - If date/time vague: "Could you provide more details?"
   - If topic broad: "I found several items. Would you like info about [list options]?"

6. **DOCUMENT TYPES TO SEARCH:**
   - Legal documents (PDFs, contracts, filings)
   - Case notes (meetings, calls, emails, expert opinions from /notes/)
   - Both are equally important

7. **CITATIONS AND SOURCES:**
   - Always cite document numbers and sources
   - For notes: mention Note ID, date, and author when available
   - For documents: mention document name and case number

8. **CONVERSATION CONTEXT:**
   - Use previous conversation for context but prioritize NEW documents
   - Don't confuse "summarize the meeting" (new info) with "summarize what you said" (old info)

AVAILABLE DOCUMENTS (${filteredResults.length} total):
${context}`,
      },
    ]

    const recentHistory = conversationHistory
      .filter((msg) => msg.role !== 'error')
      .slice(-10)
      .map((msg) => ({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: msg.content,
      }))

    conversationMessages.push(...recentHistory)
    conversationMessages.push({
      role: 'user',
      content: message,
    })

    const completionResponse = await axios.post(
      `${AZURE_OPENAI_ENDPOINT}/openai/deployments/${AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=2024-08-01-preview`,
      {
        messages: conversationMessages,
        max_tokens: 1500,
        temperature: 0.1,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'api-key': AZURE_OPENAI_KEY,
        },
      }
    )

    const assistantMessage = completionResponse.data.choices[0].message.content

    // PASO 6: Preparar citations para el frontend (más referencias)
    const citations = filteredResults.slice(0, 30).map((doc) => {
      try {
        const decodedPath = Buffer.from(doc.parent_id, 'base64').toString(
          'utf-8'
        )
        return {
          title: doc.title || decodedPath.split('/').pop(),
          content: doc.chunk.substring(0, 200) + '...',
          filepath: decodedPath,
        }
      } catch {
        return {
          title: doc.title || 'Unknown',
          content: doc.chunk.substring(0, 200) + '...',
          filepath: null,
        }
      }
    })

    console.log(`✅ Response generated with ${citations.length} citations\n`)

    res.json({
      message: assistantMessage,
      citations: citations,
    })
  } catch (error) {
    console.error('\n❌ ERROR in /api/chat:')
    console.error('Error details:', error.response?.data || error.message)
    console.error(`${'='.repeat(60)}\n`)

    res.status(500).json({
      error: 'Error processing query',
      details: error.response?.data?.error?.message || error.message,
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
    totalUsers: Object.keys(userPermissions).length
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
      cases: data.cases
    }))
  })
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
      mode: permissionsMetadata.mode || 'PRODUCTION'
    },
    config: {
      azureEndpoint: AZURE_OPENAI_ENDPOINT,
      searchEndpoint: AZURE_SEARCH_ENDPOINT,
      searchIndex: AZURE_SEARCH_INDEX,
      deployment: AZURE_OPENAI_DEPLOYMENT,
      embeddingDeployment: AZURE_EMBEDDING_DEPLOYMENT,
    },
  })
})

app.listen(PORT, () => {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`🚀 ACTS Law RAG Backend Server`)
  console.log(`${'='.repeat(60)}`)
  console.log(`📍 Server running on: http://localhost:${PORT}`)
  console.log(`🔍 Azure Search Index: ${AZURE_SEARCH_INDEX}`)
  console.log(`🤖 OpenAI Deployment: ${AZURE_OPENAI_DEPLOYMENT}`)
  console.log(`🔤 Embedding Deployment: ${AZURE_EMBEDDING_DEPLOYMENT}`)
  console.log(`⚡ Smart RAG Classification: ENABLED`)
  console.log(`🔐 Permissions Mode: ${permissionsMetadata.mode || 'PRODUCTION'}`)
  console.log(`👥 Loaded Users: ${Object.keys(userPermissions).length}`)
  console.log(`${'='.repeat(60)}\n`)
})