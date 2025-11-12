import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import jwt from 'jsonwebtoken'
import axios from 'axios'

dotenv.config()

const app = express()
const PORT = process.env.PORT || 3001

// Middleware
app.use(cors())
app.use(express.json())

// ===== PERMISSIONS CONFIGURATION =====
// In production, this would be in a database
const userPermissions = {
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

// Generate OData filter based on allowed cases
// NOTA: Como parent_id no es "searchable" en Azure Search, no podemos filtrar allí
// En su lugar, vamos a recuperar más resultados y filtrar en el backend
function generateFilter(cases) {
  if (cases.includes('*')) {
    return null // No filter - full access
  }

  // ESTRATEGIA TEMPORAL: No usar filtro de Azure Search
  // Dejar que Azure devuelva resultados y filtraremos en el backend
  // Esto no es lo más eficiente, pero funciona sin modificar el índice
  return null
}

// Función auxiliar para verificar acceso a un documento (seguridad adicional)
function hasAccessToDocument(parentId, allowedCases) {
  if (allowedCases.includes('*')) return true

  try {
    // Decodificar el Base64 del parent_id
    const decodedPath = Buffer.from(parentId, 'base64').toString('utf-8')
    // Verificar si algún caso permitido está en la ruta
    return allowedCases.some((caseNum) => decodedPath.includes(`/${caseNum}/`))
  } catch (error) {
    console.error('Error decoding parent_id:', error)
    return false
  }
}

// ===== CLASSIFICATION FUNCTION =====
// Determines if the question needs RAG search or can be answered from conversation context
async function needsRAGSearch(message, conversationHistory) {
  // If there's no conversation history, definitely needs RAG
  if (conversationHistory.length === 0) {
    return true
  }

  // Quick heuristic checks for obvious follow-up questions
  const followUpPatterns = [
    /^(traduce|translate|traduci)/i,
    /^(resume|summarize|resumen|summary)/i,
    /^(explica|explain|explicame|explícame)/i,
    /^(más corto|shorter|más breve|briefly)/i,
    /^(en español|in english|en inglés)/i,
    /^(qué significa|what does.*mean|what is that)/i,
    /^(eso|that|esto|this)/i,
    /^(lo anterior|the previous|la respuesta anterior)/i,
    /^(dime más|tell me more|elabora|elaborate)/i,
    /^(simplifica|simplify|más simple)/i,
    /^(reformula|rephrase|di lo mismo)/i,
    /^(dame un ejemplo|give me an example)/i,
  ]

  // Check if it matches any follow-up pattern
  const isObviousFollowUp = followUpPatterns.some((pattern) =>
    pattern.test(message.trim())
  )

  if (isObviousFollowUp) {
    console.log(
      '   ⚡ Quick classification: Follow-up question (no RAG needed)'
    )
    return false
  }

  // For ambiguous cases, use LLM to classify
  console.log('   🤔 Analyzing if RAG search is needed...')

  const classificationPrompt = `You are a classifier that determines if a user question requires searching a document database (RAG) or can be answered using only the conversation history.

CONVERSATION HISTORY:
${conversationHistory
  .slice(-6) // Last 6 messages for context
  .map((msg) => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
  .join('\n')}

NEW USER QUESTION: "${message}"

Analyze if this question:
- References previous responses (summaries, clarifications) → NO RAG NEEDED
- Asks for new information about legal documents/cases → RAG NEEDED
- Is a follow-up question about previous answer → NO RAG NEEDED
- Asks about specific people, dates, or facts not in conversation → RAG NEEDED

Respond with ONLY ONE WORD:
- "RAG" if it needs to search documents
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
    return true // Default to RAG if classification fails
  }
}

// ===== ENDPOINTS =====

// Login
app.post('/api/login', (req, res) => {
  const { email, password } = req.body

  const user = userPermissions[email]

  if (!user || user.password !== password) {
    return res.status(401).json({ error: 'Invalid credentials' })
  }

  // Generate JWT
  const token = jwt.sign(
    {
      email,
      name: user.name,
      cases: user.cases,
    },
    JWT_SECRET,
    { expiresIn: '24h' }
  )

  res.json({
    token,
    user: {
      email,
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
      // Answer using only conversation context (no RAG)
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

      // Add conversation history
      const recentHistory = conversationHistory
        .filter((msg) => msg.role !== 'error')
        .slice(-10)
        .map((msg) => ({
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: msg.content,
        }))

      conversationMessages.push(...recentHistory)

      // Add new user message
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
        citations: [], // No citations since we didn't search documents
      })
    }

    // If RAG is needed, continue with normal RAG flow
    console.log('🔍 RAG search required, proceeding with document search\n')

    // PASO 1: Generar embedding de la pregunta
    console.log('📊 Step 1: Generating embedding...')
    const embeddingResponse = await axios.post(
      `${AZURE_OPENAI_ENDPOINT}/openai/deployments/${AZURE_EMBEDDING_DEPLOYMENT}/embeddings?api-version=2023-05-15`,
      {
        input: message,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'api-key': AZURE_OPENAI_KEY,
        },
      }
    )

    const queryEmbedding = embeddingResponse.data.data[0].embedding

    // PASO 2: Buscar en Azure Search con vector similarity
    console.log('🔎 Step 2: Searching Azure Search (hybrid)...')
    const searchResponse = await axios.post(
      `${AZURE_SEARCH_ENDPOINT}/indexes/${AZURE_SEARCH_INDEX}/docs/search?api-version=2023-11-01`,
      {
        search: message, // Búsqueda de texto completo
        vectorQueries: [
          {
            kind: 'vector',
            vector: queryEmbedding,
            fields: 'text_vector',
            k: 50,
          },
        ],
        select: 'chunk_id,parent_id,chunk,title',
        top: 50,
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
      // Si es admin, tiene acceso a todo
      if (userCases.includes('*')) return true

      try {
        // Decodificar parent_id
        const decodedPath = Buffer.from(doc.parent_id, 'base64').toString(
          'utf-8'
        )

        // Verificar si algún caso permitido está en la ruta
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

    // If no results after filtering
    if (filteredResults.length === 0) {
      console.log('⚠️  No documents found after filtering\n')
      return res.json({
        message: `🔒 **Access Restricted**\n\nYou don't have permission to access the requested information.\n\n**To gain access:**\n- Contact your system administrator to request permissions for additional cases\n- Verify that you're inquiring about documents within your authorized cases\n\n*For permission requests or assistance, please contact your administrator.*`,
        citations: [],
      })
    }

    // PASO 4: Preparar contexto para el LLM
    console.log('🤖 Step 4: Preparing context for LLM...')
    const context = filteredResults
      .slice(0, 15) // Top 15 más relevantes
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

    // Construir mensajes con historial
    const conversationMessages = [
      {
        role: 'system',
        content: `You are a specialized legal assistant for ACTS Law firm. Answer questions based ONLY on the provided documents below. 

IMPORTANT RULES:
- Only use information from the documents provided
- Maintain conversation context from previous messages
- If you cannot find specific information, clearly state it
- Be professional, precise, and helpful
- Cite document numbers when referencing information
- For follow-up questions (like "translate that" or "tell me more"), refer to the previous conversation

AVAILABLE DOCUMENTS:
${context}`,
      },
    ]

    // Agregar historial de conversación (últimos 10 mensajes para no exceder tokens)
    const recentHistory = conversationHistory
      .filter((msg) => msg.role !== 'error') // Excluir mensajes de error
      .slice(-10) // Solo últimos 10 mensajes
      .map((msg) => ({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: msg.content,
      }))

    conversationMessages.push(...recentHistory)

    // Agregar el nuevo mensaje del usuario
    conversationMessages.push({
      role: 'user',
      content: message,
    })

    const completionResponse = await axios.post(
      `${AZURE_OPENAI_ENDPOINT}/openai/deployments/${AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=2024-08-01-preview`,
      {
        messages: conversationMessages, // ← ENVIAR HISTORIAL COMPLETO
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

    // PASO 6: Preparar citations para el frontend
    const citations = filteredResults.slice(0, 15).map((doc) => {
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

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
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
  console.log(`${'='.repeat(60)}\n`)
})
