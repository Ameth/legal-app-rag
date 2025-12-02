import { SearchClient, AzureKeyCredential } from '@azure/search-documents'
import dotenv from 'dotenv'

dotenv.config()

const SEARCH_ENDPOINT = process.env.AZURE_SEARCH_ENDPOINT
const SEARCH_API_KEY = process.env.AZURE_SEARCH_KEY
const INDEX_NAME = process.env.AZURE_SEARCH_INDEX
const CONTAINER_NAME = 'testragdocuments' // Tu container

/**
 * Extrae el blob path completo del parent_id (base64)
 * De: aHR0cHM6Ly9zYWRvY3VtZW50c3luYy5ibG9iLmNvcmUud2luZG93cy5uZXQvdGVzdHJhZ2RvY3VtZW50cy8yNTA5Ni9ub3Rlcy8yNTA5Nl8yMDI1MDkxN182NjIwMjQudHh00
 * A: 25096/notes/25096_20250917_662024.txt
 */
function extractBlobPathFromParentId(parentId) {
  try {
    // Decodificar base64
    const decoded = Buffer.from(parentId, 'base64').toString('utf-8')
    
    // Ejemplo decoded: https://sadocumentsync.blob.core.windows.net/testragdocuments/25096/notes/25096_20250917_662024.txt
    
    // Intentar parsear como URL
    try {
      const url = new URL(decoded)
      const pathParts = url.pathname.split('/').filter(p => p) // Remover strings vacías
      
      // Buscar el container en el path
      const containerIndex = pathParts.indexOf(CONTAINER_NAME)
      
      if (containerIndex !== -1 && containerIndex < pathParts.length - 1) {
        // Tomar todo después del container
        const blobPath = pathParts.slice(containerIndex + 1).join('/')
        return blobPath
      }
    } catch (urlError) {
      // Si no es una URL válida, intentar extracción directa
    }
    
    // Fallback: buscar patrón directo
    // Buscar algo como: /testragdocuments/25096/notes/file.txt
    const containerPattern = new RegExp(`\\/${CONTAINER_NAME}\\/(.+)`)
    const match = decoded.match(containerPattern)
    
    if (match && match[1]) {
      return match[1]
    }
    
    // Último fallback: si empieza con número de caso
    const casePattern = /(\d{5}\/.+)/
    const caseMatch = decoded.match(casePattern)
    
    if (caseMatch && caseMatch[1]) {
      return caseMatch[1]
    }
    
    return null
  } catch (error) {
    return null
  }
}

async function populateUrlField() {
  try {
    console.log('🔄 Actualizando campo URL desde parent_id...\n')

    if (!SEARCH_ENDPOINT || !SEARCH_API_KEY || !INDEX_NAME) {
      console.error('❌ Faltan variables de entorno:')
      console.error('   - AZURE_SEARCH_ENDPOINT')
      console.error('   - AZURE_SEARCH_KEY')
      console.error('   - AZURE_SEARCH_INDEX')
      return
    }

    console.log('✅ Configuración validada:')
    console.log(`   Endpoint: ${SEARCH_ENDPOINT}`)
    console.log(`   Index: ${INDEX_NAME}`)
    console.log(`   Container: ${CONTAINER_NAME}\n`)

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

    console.log('📥 Buscando documentos sin URL...\n')

    // Buscar solo documentos que NO tienen URL o tienen URL null
    const missingResults = await searchClient.search('*', {
      filter: 'url eq null', // Solo documentos sin URL
      select: ['chunk_id', 'parent_id', 'url', 'title'],
      top: 50000,
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

      // Extraer blob path
      const blobPath = extractBlobPathFromParentId(doc.parent_id)

      if (!blobPath) {
        totalErrors++
        if (totalErrors <= 10) {
          console.log(`   ⚠️  No se pudo extraer path: ${doc.chunk_id}`)
          console.log(`       parent_id: ${doc.parent_id.substring(0, 50)}...`)
        }
        continue
      }

      // Validación: el path debe tener al menos una /
      if (!blobPath.includes('/')) {
        totalErrors++
        if (totalErrors <= 10) {
          console.log(`   ⚠️  Path inválido: ${blobPath} (${doc.chunk_id})`)
        }
        continue
      }

      // Agregar al batch
      batch.push({
        chunk_id: doc.chunk_id,
        url: blobPath,
      })

      // Mostrar algunos ejemplos al inicio
      if (totalProcessed <= 5) {
        console.log(`   📄 Ejemplo ${totalProcessed}:`)
        console.log(`      Title: ${doc.title}`)
        console.log(`      Extracted path: ${blobPath}\n`)
      }

      // Actualizar en lotes
      if (batch.length >= batchSize) {
        try {
          await searchClient.mergeDocuments(batch)
          totalUpdated += batch.length

          if (totalUpdated % 1000 === 0) {
            const percentage = totalProcessed > 0 
              ? Math.round((totalProcessed / 50000) * 100)
              : 0
            console.log(
              `   ✅ Actualizado: ${totalUpdated.toLocaleString()} | Procesados: ${totalProcessed.toLocaleString()} | Errores: ${totalErrors}`
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
      `📄 Documentos sin URL encontrados: ${totalProcessed.toLocaleString()}`
    )
    console.log(
      `✅ Actualizados exitosamente: ${totalUpdated.toLocaleString()}`
    )
    console.log(`⏭️  Saltados (ya tenían URL): ${totalSkipped.toLocaleString()}`)
    console.log(`❌ Errores: ${totalErrors.toLocaleString()}`)
    console.log('='.repeat(70) + '\n')

    // Verificar cobertura total
    console.log('🔍 Verificando cobertura total...\n')

    const allWithUrl = await searchClient.search('*', {
      filter: 'url ne null',
      select: ['chunk_id'],
      top: 0,
      includeTotalCount: true,
    })

    const totalWithUrl = allWithUrl.count || 0
    
    // Obtener total de documentos
    const allDocs = await searchClient.search('*', {
      select: ['chunk_id'],
      top: 0,
      includeTotalCount: true,
    })
    
    const totalDocs = allDocs.count || 0
    const coverage = totalDocs > 0 ? Math.round((totalWithUrl / totalDocs) * 100) : 0

    console.log(
      `📈 Cobertura total: ${totalWithUrl.toLocaleString()} de ${totalDocs.toLocaleString()} (${coverage}%)\n`
    )

    if (coverage >= 99) {
      console.log('✅ ¡EXCELENTE! Casi todos los documentos tienen URL')
      console.log('\n🚀 Sistema optimizado para carga rápida de documentos')
      console.log('   ⚡ Los archivos ahora se cargarán INSTANTÁNEAMENTE\n')
    } else if (coverage >= 95) {
      console.log('✅ Buena cobertura. El sistema funcionará rápido.')
      console.log('   Algunos documentos pueden requerir búsqueda fallback.\n')
    } else {
      console.log('⚠️  Aún hay documentos sin URL')
      console.log('   Ejecuta este script de nuevo para continuar.\n')
    }

    if (totalErrors > 0) {
      console.log(`ℹ️  ${totalErrors} documentos tuvieron errores`)
      console.log('   Algunos pueden tener formatos diferentes de parent_id.')
      console.log('   Esto es normal si algunos parent_id tienen formato diferente.\n')
    }

    // Mostrar ejemplos de URLs generadas
    console.log('🔍 Verificando algunos ejemplos de URLs generadas...\n')
    
    const sampleResults = await searchClient.search('*', {
      filter: 'url ne null',
      select: ['chunk_id', 'url', 'title'],
      top: 5,
    })

    let sampleCount = 0
    for await (const sample of sampleResults.results) {
      sampleCount++
      console.log(`   Ejemplo ${sampleCount}:`)
      console.log(`   - Title: ${sample.document.title}`)
      console.log(`   - URL: ${sample.document.url}`)
      console.log()
    }

    console.log('✅ Proceso completado exitosamente!\n')

  } catch (error) {
    console.error('\n❌ Error fatal:', error.message)
    console.error(error.stack)
  }
}

populateUrlField()