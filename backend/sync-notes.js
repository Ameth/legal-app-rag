import { BlobServiceClient } from '@azure/storage-blob'
import axios from 'axios'
import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'

dotenv.config()

// ===== CONFIGURACIÓN =====
const AZURE_STORAGE_CONNECTION_STRING =
  process.env.AZURE_STORAGE_CONNECTION_STRING
const AZURE_CONTAINER_NAME = process.env.AZURE_CONTAINER_NAME
const SA_API_BASE_URL = process.env.SA_API_BASE_URL
const SA_USERNAME = process.env.SA_USERNAME
const SA_PASSWORD = process.env.SA_PASSWORD
const NOTES_CACHE_FILE = './notes-cache.json'

// Variable global para almacenar el token de Smart Advocate
let smartAdvocateToken = null

// ===== FUNCIONES AUXILIARES =====

/**
 * Autentica en Smart Advocate API y obtiene el token JWT
 */
async function authenticateSmartAdvocate() {
  console.log('🔐 Autenticando en Smart Advocate API...')

  if (!SA_USERNAME || !SA_PASSWORD) {
    throw new Error(
      'SA_USERNAME y SA_PASSWORD son requeridos en el archivo .env'
    )
  }

  try {
    const response = await axios.post(
      `${SA_API_BASE_URL}/Users/authenticate`,
      {
        Username: SA_USERNAME,
        Password: SA_PASSWORD,
      },
      {
        headers: {
          'Content-Type': 'application/json',
        },
      }
    )

    if (response.data && response.data.token) {
      smartAdvocateToken = response.data.token
      console.log(`   ✅ Autenticación exitosa`)
      console.log(
        `   👤 Usuario: ${response.data.username} (ID: ${response.data.userID})`
      )
      return true
    } else {
      throw new Error('Token no recibido en la respuesta')
    }
  } catch (error) {
    console.error(
      '   ❌ Error de autenticación:',
      error.response?.data || error.message
    )
    throw new Error('No se pudo autenticar en Smart Advocate API')
  }
}

/**
 * Obtiene la lista de casos desde Azure Storage (nombres de carpetas)
 */
async function getCaseNumbersFromAzureStorage() {
  console.log('\n📦 Conectando a Azure Storage...')

  try {
    const blobServiceClient = BlobServiceClient.fromConnectionString(
      AZURE_STORAGE_CONNECTION_STRING
    )
    const containerClient =
      blobServiceClient.getContainerClient(AZURE_CONTAINER_NAME)

    console.log('📂 Listando casos en el contenedor...')

    const caseNumbers = new Set()

    for await (const blob of containerClient.listBlobsFlat({
      includeMetadata: true,
    })) {
      const pathParts = blob.name.split('/')
      if (pathParts.length > 1) {
        const caseNumber = pathParts[0]
        if (/^\d+$/.test(caseNumber)) {
          caseNumbers.add(caseNumber)
        }
      }
    }

    const cases = Array.from(caseNumbers).sort()
    console.log(`✅ Encontrados ${cases.length} casos en Azure Storage:`)
    console.log(`   ${cases.join(', ')}`)

    return cases
  } catch (error) {
    console.error('❌ Error conectando a Azure Storage:', error.message)
    throw error
  }
}

/**
 * 🆕 Obtiene la información básica del caso (Nombre, Estado, etc.)
 */
async function getCaseInfo(caseNumber) {
  try {
    // Asumiendo que SA_API_BASE_URL termina antes de /case/...
    const url = `${SA_API_BASE_URL}/case/CaseInfo?Casenumber=${caseNumber}`

    if (!smartAdvocateToken) {
      throw new Error('Token no disponible')
    }

    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${smartAdvocateToken}`,
        'Content-Type': 'application/json',
      },
    })

    // La API retorna un Array según tu ejemplo
    if (response.data && response.data.length > 0) {
      return response.data[0]
    }
    return null
  } catch (error) {
    console.warn(
      `   ⚠️  No se pudo obtener información del caso ${caseNumber}: ${error.message}`
    )
    return null
  }
}

/**
 * Consulta las notas de un caso desde Smart Advocate API
 */
async function getNotesByCaseNumber(caseNumber) {
  try {
    const url = `${SA_API_BASE_URL}/case/notes/byCaseNumber?CaseNumber=${caseNumber}`

    if (!smartAdvocateToken) {
      throw new Error(
        'Token de Smart Advocate no disponible. Autenticación requerida.'
      )
    }

    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${smartAdvocateToken}`,
        'Content-Type': 'application/json',
      },
    })

    return response.data // Array de notas
  } catch (error) {
    if (error.response?.status === 404) {
      console.warn(`   ⚠️  Caso ${caseNumber}: No se encontraron notas`)
      return []
    }
    if (error.response?.status === 401) {
      console.error(`   ❌ Error de autenticación para caso ${caseNumber}`)
      console.error(`   Token puede haber expirado. Re-autenticando...`)
      await authenticateSmartAdvocate()
      try {
        const response = await axios.get(url, {
          headers: {
            Authorization: `Bearer ${smartAdvocateToken}`,
            'Content-Type': 'application/json',
          },
        })
        return response.data
      } catch (retryError) {
        console.error(`   ❌ Reintento falló para caso ${caseNumber}`)
        return []
      }
    }
    console.error(
      `   ❌ Error consultando notas del caso ${caseNumber}:`,
      error.message
    )
    return []
  }
}

/**
 * Limpia HTML entities y tags del texto de las notas
 */
function cleanNoteText(text) {
  if (!text) return ''

  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<br>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Formatea una fecha ISO a formato legible con hora
 */
function formatDateTime(isoDate) {
  if (!isoDate) return 'N/A'

  try {
    const date = new Date(isoDate)
    const dateStr = date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    const timeStr = date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
    return `${dateStr} ${timeStr}`
  } catch (error) {
    return isoDate
  }
}

/**
 * Genera el nombre de archivo para una nota individual
 * Formato: CaseNumber_YYYYMMDD_NoteID.txt
 */
function generateNoteFileName(note, caseNumber) {
  const date = new Date(note.noteDate || note.createdDate)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const dateStr = `${year}${month}${day}`

  return `${caseNumber}_${dateStr}_${note.noteID}.txt`
}

/**
 * ✏️ Genera el contenido de un archivo de nota individual
 * MODIFICADO: Ahora acepta caseName y ajusta el formato
 */
function generateNoteFileContent(note, caseNumber, caseName) {
  // Manejo de nulos por seguridad
  const safeCaseName = caseName || 'Unknown Case Name'

  return `CASE NUMBER: ${caseNumber}
CASE NAME: ${safeCaseName}
NOTE ID: ${note.noteID}

METADATA:
  • Date: ${formatDateTime(note.noteDate)}
  • Created: ${formatDateTime(note.createdDate)}
  • Author: ${note.uniqueContactName || 'N/A'}
  • User ID: ${note.userID || 'N/A'}
  • Note Type: ${note.noteTypeName || 'N/A'}
  • Priority: ${note.priority || 'Normal'}
  • Subject: ${note.subject || 'No subject'}
${
  note.modifiedDate
    ? `  • Last modified: ${formatDateTime(note.modifiedDate)}`
    : ''
}

NOTE TEXT:

${cleanNoteText(note.noteText)}

File generated: ${new Date().toISOString()}
`
}

/**
 * Carga el cache de notas sincronizadas
 */
function loadNotesCache() {
  try {
    if (!fs.existsSync(NOTES_CACHE_FILE)) {
      console.log('   ℹ️  No se encontró cache de notas, creando nuevo cache')
      return {}
    }

    const data = JSON.parse(fs.readFileSync(NOTES_CACHE_FILE, 'utf-8'))
    return data
  } catch (error) {
    console.error('   ⚠️  Error leyendo cache de notas:', error.message)
    return {}
  }
}

/**
 * Guarda el cache de notas sincronizadas
 */
function saveNotesCache(cache) {
  try {
    fs.writeFileSync(NOTES_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8')
  } catch (error) {
    console.error('   ⚠️  Error guardando cache de notas:', error.message)
  }
}

/**
 * Verifica si hay notas nuevas o modificadas
 */
function identifyNotesToSync(notes, cachedNotes) {
  const toSync = {
    new: [],
    modified: [],
    unchanged: [],
  }

  if (!cachedNotes || Object.keys(cachedNotes).length === 0) {
    toSync.new = notes
    return toSync
  }

  for (const note of notes) {
    const cachedNote = cachedNotes[note.noteID]

    if (!cachedNote) {
      toSync.new.push(note)
    } else {
      const currentModified = note.modifiedDate || note.createdDate
      const cachedModified = cachedNote.modifiedDate || cachedNote.createdDate

      if (currentModified !== cachedModified) {
        toSync.modified.push(note)
      } else {
        toSync.unchanged.push(note)
      }
    }
  }

  return toSync
}

/**
 * Sube un archivo de nota individual a Azure Storage
 */
async function uploadNoteToAzureStorage(caseNumber, fileName, content) {
  try {
    const blobServiceClient = BlobServiceClient.fromConnectionString(
      AZURE_STORAGE_CONNECTION_STRING
    )
    const containerClient =
      blobServiceClient.getContainerClient(AZURE_CONTAINER_NAME)

    const blobName = `${caseNumber}/notes/${fileName}`
    const blockBlobClient = containerClient.getBlockBlobClient(blobName)

    await blockBlobClient.upload(content, content.length, {
      blobHTTPHeaders: {
        blobContentType: 'text/plain; charset=utf-8',
      },
    })

    return { success: true, blobName }
  } catch (error) {
    console.error(`   ❌ Error subiendo archivo ${fileName}:`, error.message)
    return { success: false, error: error.message }
  }
}

/**
 * Crea un índice de notas para el cache
 */
function createNotesIndex(notes) {
  const index = {}
  notes.forEach((note) => {
    index[note.noteID] = {
      createdDate: note.createdDate,
      modifiedDate: note.modifiedDate,
      noteDate: note.noteDate,
    }
  })
  return index
}

// ===== PROCESO PRINCIPAL =====

async function syncNotes() {
  console.log('\n' + '='.repeat(80))
  console.log('📝 SINCRONIZACIÓN DE NOTAS - ACTS Law RAG')
  console.log('='.repeat(80))
  console.log(`⏰ Iniciado: ${new Date().toLocaleString()}\n`)

  let stats = {
    totalCases: 0,
    casesWithNotes: 0,
    casesUpdated: 0,
    casesSkipped: 0,
    totalNotes: 0,
    errors: 0,
  }

  try {
    // PASO 0: Autenticar en Smart Advocate
    await authenticateSmartAdvocate()

    // PASO 1: Cargar cache de notas
    console.log('\n📂 Cargando cache de notas...')
    const notesCache = loadNotesCache()
    console.log(`   ℹ️  Cache contiene ${Object.keys(notesCache).length} casos`)

    // PASO 2: Obtener lista de casos desde Azure Storage
    const caseNumbers = await getCaseNumbersFromAzureStorage()
    stats.totalCases = caseNumbers.length

    if (caseNumbers.length === 0) {
      console.log('\n⚠️  No se encontraron casos en Azure Storage')
      return
    }

    // PASO 3: Procesar cada caso
    console.log('\n🔍 Procesando notas de cada caso...\n')

    for (let i = 0; i < caseNumbers.length; i++) {
      const caseNumber = caseNumbers[i]
      const progress = `[${i + 1}/${caseNumbers.length}]`

      console.log(`${progress} Procesando caso ${caseNumber}...`)

      try {
        // 🆕 PASO 3.1: Obtener Info del Caso (Nombre)
        const caseInfo = await getCaseInfo(caseNumber)
        const caseName = caseInfo ? caseInfo.caseName : 'N/A'

        // Obtener notas del caso
        const notes = await getNotesByCaseNumber(caseNumber)
        stats.totalNotes += notes.length

        if (notes.length === 0) {
          console.log(`   ℹ️  Sin notas disponibles`)
          stats.casesSkipped++

          if (i < caseNumbers.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, 300))
          }
          continue
        }

        console.log(
          `   📋 ${notes.length} notas encontradas para "${caseName}"`
        )
        stats.casesWithNotes++

        // Identificar notas a sincronizar
        const cachedCaseNotes = notesCache[caseNumber]
        const toSync = identifyNotesToSync(notes, cachedCaseNotes)

        const totalToSync = toSync.new.length + toSync.modified.length

        if (totalToSync === 0) {
          console.log(
            `   ⏭️  Sin cambios desde última sincronización (${toSync.unchanged.length} notas sin cambios)`
          )
          stats.casesSkipped++
        } else {
          console.log(
            `   🔄 A sincronizar: ${toSync.new.length} nuevas, ${toSync.modified.length} modificadas`
          )

          let uploaded = 0
          let failed = 0

          // Subir notas nuevas
          for (const note of toSync.new) {
            const fileName = generateNoteFileName(note, caseNumber)
            // ✏️ PASAMOS EL caseName AQUÍ
            const fileContent = generateNoteFileContent(
              note,
              caseNumber,
              caseName
            )
            const result = await uploadNoteToAzureStorage(
              caseNumber,
              fileName,
              fileContent
            )

            if (result.success) {
              uploaded++
              console.log(`   ✅ Nuevo: ${fileName}`)
            } else {
              failed++
            }
          }

          // Subir notas modificadas
          for (const note of toSync.modified) {
            const fileName = generateNoteFileName(note, caseNumber)
            // ✏️ PASAMOS EL caseName AQUÍ
            const fileContent = generateNoteFileContent(
              note,
              caseNumber,
              caseName
            )
            const result = await uploadNoteToAzureStorage(
              caseNumber,
              fileName,
              fileContent
            )

            if (result.success) {
              uploaded++
              console.log(`   🔄 Actualizado: ${fileName}`)
            } else {
              failed++
            }
          }

          if (uploaded > 0) {
            // Actualizar cache
            notesCache[caseNumber] = createNotesIndex(notes)
            stats.casesUpdated++
            console.log(
              `   ✨ ${uploaded} archivos sincronizados correctamente`
            )
          }

          if (failed > 0) {
            console.log(`   ⚠️  ${failed} archivos fallaron`)
            stats.errors += failed
          }
        }

        // Delay para no saturar la API
        if (i < caseNumbers.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 300))
        }
      } catch (error) {
        console.error(
          `   ❌ Error procesando caso ${caseNumber}:`,
          error.message
        )
        stats.errors++
      }
    }

    // PASO 4: Guardar cache actualizado
    console.log('\n💾 Guardando cache actualizado...')
    saveNotesCache(notesCache)

    // PASO 5: Mostrar resumen
    console.log('\n' + '='.repeat(80))
    console.log('✅ SINCRONIZACIÓN COMPLETADA')
    console.log('='.repeat(80))
    console.log('\n📊 ESTADÍSTICAS:')
    console.log(`   • Total de casos procesados: ${stats.totalCases}`)
    console.log(`   • Casos con notas: ${stats.casesWithNotes}`)
    console.log(`   • Casos actualizados: ${stats.casesUpdated}`)
    console.log(`   • Casos sin cambios: ${stats.casesSkipped}`)
    console.log(`   • Total de notas: ${stats.totalNotes}`)
    console.log(`   • Errores: ${stats.errors}`)

    console.log(`\n⏰ Finalizado: ${new Date().toLocaleString()}`)

    if (stats.casesUpdated > 0) {
      console.log(
        '\n✨ Los archivos actualizados serán indexados automáticamente por Azure AI Search'
      )
    }

    console.log()
  } catch (error) {
    console.error('\n❌ ERROR DURANTE LA SINCRONIZACIÓN:')
    console.error(error)
    process.exit(1)
  }
}

// Ejecutar sincronización
syncNotes()
