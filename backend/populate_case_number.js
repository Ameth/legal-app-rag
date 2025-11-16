import { SearchClient, AzureKeyCredential } from '@azure/search-documents'
import dotenv from 'dotenv'

dotenv.config()

const SEARCH_ENDPOINT = process.env.AZURE_SEARCH_ENDPOINT
const SEARCH_API_KEY = process.env.AZURE_SEARCH_KEY
const INDEX_NAME = process.env.AZURE_SEARCH_INDEX


/**
 * Extrae el número de caso del parent_id (base64)
 */
function extractCaseFromParentId(parentId) {
  try {
    const decoded = Buffer.from(parentId, 'base64').toString('utf-8')
    
    const caseMatch = decoded.match(/\/(\d{5})\//)
    if (caseMatch) {
      return caseMatch[1]
    }

    const fallbackMatch = decoded.match(/(\d{5})/)
    if (fallbackMatch) {
      return fallbackMatch[1]
    }

    return null
  } catch (error) {
    return null
  }
}

async function populateWithCursor() {
  try {
    console.log('🔄 Población COMPLETA con cursor (sin límite de 100k)...\n')

    if (!SEARCH_ENDPOINT || !SEARCH_API_KEY || !INDEX_NAME) {
      console.error('❌ Faltan variables de entorno')
      return
    }

    console.log('✅ Configuración validada:')
    console.log(`   Endpoint: ${SEARCH_ENDPOINT}`)
    console.log(`   Index: ${INDEX_NAME}\n`)

    const searchClient = new SearchClient(
      SEARCH_ENDPOINT,
      INDEX_NAME,
      new AzureKeyCredential(SEARCH_API_KEY)
    )

    let totalProcessed = 0
    let totalUpdated = 0
    let totalSkipped = 0
    let totalErrors = 0
    const batchSize = 100
    let batch = []

    console.log('📥 Iniciando procesamiento con cursor...\n')
    console.log('⏳ Esto procesará TODOS los documentos sin límite de 100k\n')

    // Estrategia: Usar orderby chunk_id y filtros para avanzar sin skip
    // Esto evita el límite de skip <= 100,000
    
    let lastChunkId = null
    let pageNumber = 1
    let continueProcessing = true
    const pageSize = 1000

    while (continueProcessing) {
      console.log(`📄 Procesando página ${pageNumber}...`)

      try {
        let searchOptions = {
          select: ['chunk_id', 'parent_id', 'case_number'],
          orderBy: ['chunk_id asc'],
          top: pageSize
        }

        // Si ya procesamos documentos, usar filtro para continuar desde el último
        if (lastChunkId) {
          searchOptions.filter = `chunk_id gt '${lastChunkId}'`
        }

        const pageResults = await searchClient.search('*', searchOptions)

        let pageProcessed = 0
        let pageLastId = null

        for await (const result of pageResults.results) {
          totalProcessed++
          pageProcessed++

          const doc = result.document
          pageLastId = doc.chunk_id

          // Si ya tiene case_number, saltar
          if (doc.case_number) {
            totalSkipped++
            continue
          }

          // Validar que tenga parent_id
          if (!doc.parent_id) {
            totalErrors++
            if (totalErrors <= 10) {
              console.log(`   ⚠️  Sin parent_id: ${doc.chunk_id}`)
            }
            continue
          }

          // Extraer case_number
          const caseNumber = extractCaseFromParentId(doc.parent_id)

          if (!caseNumber) {
            totalErrors++
            if (totalErrors <= 10) {
              console.log(`   ⚠️  No se pudo extraer caso: ${doc.chunk_id}`)
            }
            continue
          }

          // Agregar al batch
          batch.push({
            chunk_id: doc.chunk_id,
            case_number: caseNumber
          })

          // Actualizar en lotes
          if (batch.length >= batchSize) {
            try {
              await searchClient.mergeDocuments(batch)
              totalUpdated += batch.length
              console.log(`   ✅ Total actualizado: ${totalUpdated.toLocaleString()} | Procesados: ${totalProcessed.toLocaleString()}`)
              batch = []
            } catch (error) {
              console.error(`   ❌ Error en lote: ${error.message}`)
              totalErrors += batch.length
              batch = []
            }
          }
        }

        console.log(`   📊 Página ${pageNumber}: ${pageProcessed} documentos`)

        // Si no procesamos ningún documento, terminamos
        if (pageProcessed === 0) {
          console.log('   ℹ️  No hay más documentos')
          continueProcessing = false
        } else {
          lastChunkId = pageLastId
          pageNumber++
        }

        // Mostrar progreso cada 10 páginas
        if (pageNumber % 10 === 0) {
          console.log(`\n📈 Progreso: ${totalProcessed.toLocaleString()} procesados, ${totalUpdated.toLocaleString()} actualizados\n`)
        }

      } catch (pageError) {
        console.error(`   ❌ Error en página ${pageNumber}: ${pageError.message}`)
        // Si hay error, intentamos continuar
        continueProcessing = false
      }
    }

    // Actualizar lote final
    if (batch.length > 0) {
      try {
        await searchClient.mergeDocuments(batch)
        totalUpdated += batch.length
        console.log(`   ✅ Lote final: ${batch.length} documentos`)
      } catch (error) {
        console.error(`   ❌ Error en lote final: ${error.message}`)
        totalErrors += batch.length
      }
    }

    // Obtener total real del índice
    const countResults = await searchClient.search('*', {
      select: ['chunk_id'],
      top: 0,
      includeTotalCount: true
    })
    
    const totalInIndex = countResults.count || totalProcessed

    console.log('\n' + '='.repeat(70))
    console.log('📊 RESUMEN FINAL')
    console.log('='.repeat(70))
    console.log(`📄 Total en índice: ${totalInIndex.toLocaleString()}`)
    console.log(`📄 Total procesados: ${totalProcessed.toLocaleString()}`)
    console.log(`✅ Actualizados: ${totalUpdated.toLocaleString()}`)
    console.log(`⏭️  Ya tenían case_number: ${totalSkipped.toLocaleString()}`)
    console.log(`❌ Errores: ${totalErrors.toLocaleString()}`)
    
    const totalWithCaseNumber = totalUpdated + totalSkipped
    const coverage = totalInIndex > 0 ? Math.round((totalWithCaseNumber / totalInIndex) * 100) : 0
    
    console.log(`\n📈 Cobertura: ${totalWithCaseNumber.toLocaleString()} de ${totalInIndex.toLocaleString()} (${coverage}%)`)
    console.log('='.repeat(70) + '\n')

    if (coverage >= 99) {
      console.log('✅ ¡POBLACIÓN COMPLETADA!')
      console.log('   Prácticamente todos los documentos tienen case_number.\n')
      console.log('🚀 Siguiente paso:')
      console.log('   cp server-case-number.js server.js && npm start\n')
    } else if (coverage >= 95) {
      console.log('⚠️  Cobertura alta pero no completa')
      console.log(`   ${coverage}% de documentos tienen case_number.`)
      console.log('   Puedes usar el sistema ya.\n')
    } else {
      console.log('⚠️  Cobertura insuficiente')
      console.log(`   Solo ${coverage}% tienen case_number.`)
      console.log('   Revisa los errores.\n')
    }

    if (totalErrors > 0) {
      console.log(`ℹ️  Total de errores: ${totalErrors}`)
      console.log('   Algunos documentos pueden tener formatos diferentes de parent_id.\n')
    }

  } catch (error) {
    console.error('\n❌ Error general:', error.message)
    console.error(error.stack)
  }
}

populateWithCursor()


