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

async function populateMissingOnly() {
  try {
    console.log('🔄 Procesando SOLO documentos SIN case_number...\n')

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
    let totalErrors = 0
    const batchSize = 100
    let batch = []

    console.log('📥 Buscando documentos sin case_number...\n')

    // Buscar solo documentos que NO tienen case_number
    // Esto reduce dramáticamente la cantidad a procesar
    const missingResults = await searchClient.search('*', {
      filter: 'case_number eq null', // Solo documentos sin case_number
      select: ['chunk_id', 'parent_id', 'case_number'],
      top: 50000, // Azure permite hasta 50k con filtro
    })

    console.log('⏳ Procesando documentos encontrados...\n')

    for await (const result of missingResults.results) {
      totalProcessed++

      const doc = result.document

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
        case_number: caseNumber,
      })

      // Actualizar en lotes
      if (batch.length >= batchSize) {
        try {
          await searchClient.mergeDocuments(batch)
          totalUpdated += batch.length

          if (totalUpdated % 1000 === 0) {
            const percentage = Math.round((totalProcessed / 50000) * 100)
            console.log(
              `   ✅ Actualizado: ${totalUpdated.toLocaleString()} | Procesados: ${totalProcessed.toLocaleString()} (${percentage}%)`
            )
          }

          batch = []
        } catch (error) {
          console.error(`   ❌ Error en lote: ${error.message}`)
          totalErrors += batch.length
          batch = []
        }
      }
    }

    // Actualizar lote final
    if (batch.length > 0) {
      try {
        await searchClient.mergeDocuments(batch)
        totalUpdated += batch.length
        console.log(`\n   ✅ Lote final: ${batch.length} documentos`)
      } catch (error) {
        console.error(`   ❌ Error en lote final: ${error.message}`)
        totalErrors += batch.length
      }
    }

    console.log('\n' + '='.repeat(70))
    console.log('📊 RESUMEN')
    console.log('='.repeat(70))
    console.log(
      `📄 Documentos sin case_number encontrados: ${totalProcessed.toLocaleString()}`
    )
    console.log(
      `✅ Actualizados exitosamente: ${totalUpdated.toLocaleString()}`
    )
    console.log(`❌ Errores: ${totalErrors.toLocaleString()}`)
    console.log('='.repeat(70) + '\n')

    if (totalProcessed < 50000) {
      console.log('✅ ¡PROCESO COMPLETADO!')
      console.log(
        `   Se actualizaron ${totalUpdated.toLocaleString()} documentos que faltaban.\n`
      )

      // Verificar cobertura total
      console.log('🔍 Verificando cobertura total...\n')

      const allWithCase = await searchClient.search('*', {
        filter: 'case_number ne null',
        select: ['chunk_id'],
        top: 0,
        includeTotalCount: true,
      })

      const totalWithCaseNumber = allWithCase.count || 0
      const coverage = Math.round((totalWithCaseNumber / 141634) * 100)

      console.log(
        `📈 Cobertura total: ${totalWithCaseNumber.toLocaleString()} de 141,634 (${coverage}%)\n`
      )

      if (coverage >= 99) {
        console.log(
          '✅ ¡EXCELENTE! Casi todos los documentos tienen case_number'
        )
        console.log('\n🚀 Ya puedes usar el sistema:')
        console.log('   1. cp server-case-number.js server.js')
        console.log('   2. npm start\n')
      } else if (coverage >= 95) {
        console.log('✅ Buena cobertura. El sistema es usable.')
        console.log('   Algunos documentos pueden no estar disponibles.\n')
      } else {
        console.log('⚠️  Aún hay documentos sin case_number')
        console.log('   Puedes ejecutar este script de nuevo.\n')
      }
    } else {
      console.log('⚠️  Se alcanzó el límite de 50,000 documentos')
      console.log('   Hay más documentos sin case_number.')
      console.log('   Ejecuta este script de nuevo para continuar.\n')
    }

    if (totalErrors > 0) {
      console.log(`ℹ️  ${totalErrors} documentos tuvieron errores`)
      console.log('   Algunos pueden tener formatos diferentes de parent_id.\n')
    }
  } catch (error) {
    console.error('\n❌ Error:', error.message)
    console.error(error.stack)
  }
}

populateMissingOnly()
