import { SearchClient, AzureKeyCredential } from '@azure/search-documents'
import dotenv from 'dotenv'

dotenv.config()

const SEARCH_ENDPOINT = process.env.AZURE_SEARCH_ENDPOINT
const SEARCH_API_KEY = process.env.AZURE_SEARCH_KEY
const INDEX_NAME = process.env.AZURE_SEARCH_INDEX

/**
 * Extrae el número de caso del parent_id (base64)
 * Soporta case numbers de 5, 6 o 7 dígitos
 */
function extractCaseFromParentId(parentId) {
  try {
    const decoded = Buffer.from(parentId, 'base64').toString('utf-8')

    // Patrón 1: /NNNNN/ o /NNNNNN/ o /NNNNNNN/ (con barras)
    let caseMatch = decoded.match(/\/(\d{5,7})\//)
    if (caseMatch && caseMatch[1]) {
      return caseMatch[1]
    }

    // Patrón 2: Empieza con 5-7 dígitos seguidos de /
    caseMatch = decoded.match(/^(\d{5,7})\//)
    if (caseMatch && caseMatch[1]) {
      return caseMatch[1]
    }

    // Patrón 3: Después del container name
    caseMatch = decoded.match(/testragdocuments\/(\d{5,7})/)
    if (caseMatch && caseMatch[1]) {
      return caseMatch[1]
    }

    // Patrón 4: Fallback - primera secuencia de 5-7 dígitos
    const fallbackMatch = decoded.match(/(\d{5,7})/)
    if (fallbackMatch && fallbackMatch[1]) {
      return fallbackMatch[1]
    }

    return null
  } catch (error) {
    return null
  }
}

async function updateCaseNumbers() {
  try {
    console.log('🔄 Actualizando case_numbers (nuevos y correcciones)...\n')

    if (!SEARCH_ENDPOINT || !SEARCH_API_KEY || !INDEX_NAME) {
      console.error('❌ Faltan variables de entorno:')
      console.error('   - AZURE_SEARCH_ENDPOINT')
      console.error('   - AZURE_SEARCH_KEY')
      console.error('   - AZURE_SEARCH_INDEX')
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
    let totalNewCases = 0
    let totalCorrected = 0
    let totalErrors = 0

    // ========================================
    // FASE 1: Agregar case_numbers faltantes
    // ========================================
    console.log('⏳ Fase 1: Procesando documentos SIN case_number...\n')

    const missingResults = await searchClient.search('*', {
      filter: 'case_number eq null',
      select: ['chunk_id', 'parent_id'],
      top: 50000,
    })

    let batch = []
    const batchSize = 100

    for await (const result of missingResults.results) {
      totalProcessed++

      const doc = result.document

      if (!doc.parent_id) {
        totalErrors++
        continue
      }

      const caseNumber = extractCaseFromParentId(doc.parent_id)

      if (!caseNumber) {
        totalErrors++
        continue
      }

      batch.push({
        chunk_id: doc.chunk_id,
        case_number: caseNumber,
      })

      if (batch.length >= batchSize) {
        try {
          await searchClient.mergeDocuments(batch)
          totalUpdated += batch.length
          totalNewCases += batch.length
          batch = []
        } catch (error) {
          console.error(`   ❌ Error en lote: ${error.message}`)
          totalErrors += batch.length
          batch = []
        }
      }
    }

    // Lote final de Fase 1
    if (batch.length > 0) {
      try {
        await searchClient.mergeDocuments(batch)
        totalUpdated += batch.length
        totalNewCases += batch.length
      } catch (error) {
        console.error(`   ❌ Error en lote final: ${error.message}`)
        totalErrors += batch.length
      }
      batch = []
    }

    console.log(
      `   ✅ Fase 1 completada: ${totalNewCases.toLocaleString()} nuevos case_numbers agregados\n`
    )

    // ========================================
    // FASE 2: Corregir case_numbers existentes
    // ========================================
    console.log(
      '⏳ Fase 2: Verificando y corrigiendo case_numbers existentes...\n'
    )

    const existingResults = await searchClient.search('*', {
      filter: 'case_number ne null',
      select: ['chunk_id', 'parent_id', 'case_number'],
      top: 50000,
    })

    let phase2Processed = 0

    for await (const result of existingResults.results) {
      phase2Processed++

      const doc = result.document

      if (!doc.parent_id) {
        continue
      }

      const correctCaseNumber = extractCaseFromParentId(doc.parent_id)

      if (!correctCaseNumber) {
        continue
      }

      // Verificar si necesita corrección
      if (doc.case_number !== correctCaseNumber) {
        batch.push({
          chunk_id: doc.chunk_id,
          case_number: correctCaseNumber,
        })

        totalCorrected++

        // Mostrar primeros ejemplos
        if (totalCorrected <= 5) {
          console.log(
            `   🔧 Corrigiendo: "${doc.case_number}" → "${correctCaseNumber}"`
          )
        }

        if (batch.length >= batchSize) {
          try {
            await searchClient.mergeDocuments(batch)
            totalUpdated += batch.length
            batch = []
          } catch (error) {
            console.error(`   ❌ Error en lote: ${error.message}`)
            totalErrors += batch.length
            batch = []
          }
        }
      }

      // Mostrar progreso cada 10,000
      if (phase2Processed % 10000 === 0) {
        console.log(
          `   📊 Verificados: ${phase2Processed.toLocaleString()} | Corregidos: ${totalCorrected.toLocaleString()}`
        )
      }
    }

    // Lote final de Fase 2
    if (batch.length > 0) {
      try {
        await searchClient.mergeDocuments(batch)
        totalUpdated += batch.length
      } catch (error) {
        console.error(`   ❌ Error en lote final: ${error.message}`)
        totalErrors += batch.length
      }
    }

    console.log(
      `\n   ✅ Fase 2 completada: ${totalCorrected.toLocaleString()} case_numbers corregidos\n`
    )

    // ========================================
    // RESUMEN FINAL
    // ========================================
    console.log('='.repeat(70))
    console.log('📊 RESUMEN COMPLETO')
    console.log('='.repeat(70))
    console.log(
      `📄 Total documentos procesados: ${(
        totalProcessed + phase2Processed
      ).toLocaleString()}`
    )
    console.log(
      `   └─ Fase 1 (sin case_number): ${totalProcessed.toLocaleString()}`
    )
    console.log(
      `   └─ Fase 2 (verificación): ${phase2Processed.toLocaleString()}`
    )
    console.log('')
    console.log(`✅ Total actualizaciones: ${totalUpdated.toLocaleString()}`)
    console.log(`   └─ Nuevos case_numbers: ${totalNewCases.toLocaleString()}`)
    console.log(
      `   └─ Case_numbers corregidos: ${totalCorrected.toLocaleString()}`
    )
    console.log('')
    console.log(`❌ Errores: ${totalErrors.toLocaleString()}`)
    console.log('='.repeat(70) + '\n')

    // Verificar cobertura total
    console.log('🔍 Verificando cobertura final...\n')

    const allDocs = await searchClient.search('*', {
      select: ['chunk_id'],
      top: 0,
      includeTotalCount: true,
    })

    const allWithCase = await searchClient.search('*', {
      filter: 'case_number ne null',
      select: ['chunk_id'],
      top: 0,
      includeTotalCount: true,
    })

    const total = allDocs.count || 0
    const withCase = allWithCase.count || 0
    const coverage = total > 0 ? Math.round((withCase / total) * 100) : 0

    console.log(`   📈 Total documentos: ${total.toLocaleString()}`)
    console.log(
      `   ✅ Con case_number: ${withCase.toLocaleString()} (${coverage}%)\n`
    )

    if (coverage >= 99) {
      console.log(
        '✅ ¡EXCELENTE! Casi todos los documentos tienen case_number correcto'
      )
      console.log('\n🚀 Sistema listo para usar\n')
    } else if (coverage >= 95) {
      console.log('✅ Buena cobertura. El sistema es usable.\n')
    } else {
      console.log('⚠️  Ejecuta el script de nuevo para mejorar la cobertura.\n')
    }

    // Mostrar distribución por longitud
    console.log('📊 Analizando distribución de case_numbers...\n')

    const sample = await searchClient.search('*', {
      filter: 'case_number ne null',
      select: ['case_number'],
      top: 1000,
    })

    let count5 = 0,
      count6 = 0,
      count7 = 0
    const uniqueCases = new Set()

    for await (const result of sample.results) {
      const cn = result.document.case_number
      if (cn) {
        uniqueCases.add(cn)
        const length = cn.length
        if (length === 5) count5++
        else if (length === 6) count6++
        else if (length === 7) count7++
      }
    }

    console.log('   📌 Distribución por longitud (muestra de 1,000):')
    console.log(
      `      5 dígitos: ${count5} (${Math.round((count5 / 1000) * 100)}%)`
    )
    console.log(
      `      6 dígitos: ${count6} (${Math.round((count6 / 1000) * 100)}%)`
    )
    console.log(
      `      7 dígitos: ${count7} (${Math.round((count7 / 1000) * 100)}%)`
    )
    console.log(`\n   📌 Casos únicos en muestra: ${uniqueCases.size}`)

    if (uniqueCases.size > 0) {
      console.log(`   📌 Ejemplos de casos:`)
      Array.from(uniqueCases)
        .slice(0, 10)
        .forEach((c, i) => {
          console.log(`      ${i + 1}. ${c} (${c.length} dígitos)`)
        })
    }
    console.log()

    console.log('✅ Proceso completado exitosamente!\n')
  } catch (error) {
    console.error('\n❌ Error fatal:', error.message)
    console.error(error.stack)
  }
}

updateCaseNumbers()
