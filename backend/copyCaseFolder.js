import { BlobServiceClient } from '@azure/storage-blob'
import dotenv from 'dotenv'

dotenv.config()

// Extensiones de archivos permitidos
const ALLOWED_EXTENSIONS = [
  // PDFs
  '.pdf',

  // Documentos de Office
  '.doc',
  '.docx',
  '.docm',
  '.dot',
  '.dotx',
  '.dotm',
  '.xls',
  '.xlsx',
  '.xlsm',
  '.xlt',
  '.xltx',
  '.xltm',
  '.ppt',
  '.pptx',
  '.pptm',
  '.pot',
  '.potx',
  '.potm',

  // Texto
  '.txt',
  '.rtf',

  // Emails
  '.msg',
  '.eml',
  '.oft',
  '.ost',
  '.pst',
]

// Configuración
const SOURCE_CONTAINER = 'documents'
const DEST_CONTAINER = 'testragdocuments'

class CaseFolderCopier {
  constructor() {
    this.blobServiceClient = BlobServiceClient.fromConnectionString(
      process.env.AZURE_STORAGE_CONNECTION_STRING
    )
    this.sourceContainerClient =
      this.blobServiceClient.getContainerClient(SOURCE_CONTAINER)
    this.destContainerClient =
      this.blobServiceClient.getContainerClient(DEST_CONTAINER)

    this.stats = {
      filesProcessed: 0,
      filesCopied: 0,
      filesSkipped: 0,
      totalBytes: 0,
      errors: [],
      startTime: null,
      endTime: null,
    }
  }

  /**
   * Verifica si un archivo debe ser copiado basado en su extensión
   */
  shouldCopyFile(fileName) {
    const extension = fileName
      .toLowerCase()
      .substring(fileName.lastIndexOf('.'))
      .trim()
    return ALLOWED_EXTENSIONS.includes(extension)
  }

  /**
   * Formatea bytes a un formato legible
   */
  formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes'
    const k = 1024
    const sizes = ['Bytes', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
  }

  /**
   * Formatea duración en formato legible (horas, minutos, segundos)
   */
  formatDuration(milliseconds) {
    const totalSeconds = Math.floor(milliseconds / 1000)
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    const seconds = totalSeconds % 60

    if (hours > 0) {
      return `${hours}h ${minutes}m ${seconds}s`
    } else if (minutes > 0) {
      return `${minutes}m ${seconds}s`
    } else {
      return `${seconds}s`
    }
  }

  /**
   * Formatea una fecha a string legible
   */
  formatDateTime(date) {
    return date.toLocaleString('es-CO', {
      timeZone: 'America/Bogota',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    })
  }

  /**
   * Lista todos los blobs dentro de una carpeta (recursivamente)
   */
  async listBlobsInFolder(caseNumber) {
    const blobs = []
    const prefix = `${caseNumber}/`

    console.log(`📂 Escaneando carpeta: ${caseNumber}`)

    try {
      for await (const blob of this.sourceContainerClient.listBlobsFlat({
        prefix,
      })) {
        blobs.push({
          name: blob.name,
          size: blob.properties.contentLength,
        })
      }
    } catch (error) {
      throw new Error(`Error al listar blobs: ${error.message}`)
    }

    return blobs
  }

  /**
   * Copia un blob individual del contenedor origen al destino
   */
  async copyBlob(sourceBlobName, destBlobName, size) {
    try {
      const sourceBlobClient =
        this.sourceContainerClient.getBlobClient(sourceBlobName)
      const destBlobClient =
        this.destContainerClient.getBlobClient(destBlobName)

      // Verificar si el blob de origen existe
      const exists = await sourceBlobClient.exists()
      if (!exists) {
        throw new Error(`El archivo origen no existe: ${sourceBlobName}`)
      }

      // Copiar usando URL con SAS o directo
      const copyPoller = await destBlobClient.beginCopyFromURL(
        sourceBlobClient.url
      )
      await copyPoller.pollUntilDone()

      this.stats.filesCopied++
      this.stats.totalBytes += size

      return true
    } catch (error) {
      this.stats.errors.push({
        file: sourceBlobName,
        error: error.message,
      })
      return false
    }
  }

  /**
   * Copia toda la carpeta de un caso
   */
  async copyCaseFolder(caseNumber) {
    this.stats.startTime = new Date()

    console.log('\n' + '='.repeat(60))
    console.log(`🚀 Iniciando copia de caso: ${caseNumber}`)
    console.log(
      `🕐 Hora de inicio: ${this.formatDateTime(this.stats.startTime)}`
    )
    console.log('='.repeat(60) + '\n')

    try {
      // Listar todos los blobs en la carpeta
      const blobs = await this.listBlobsInFolder(caseNumber)

      if (blobs.length === 0) {
        console.log(
          `❌ No se encontraron archivos en la carpeta: ${caseNumber}`
        )
        return
      }

      console.log(`📊 Total de archivos encontrados: ${blobs.length}\n`)

      // Procesar cada blob
      for (const blob of blobs) {
        this.stats.filesProcessed++

        const fileName = blob.name.split('/').pop()

        // Verificar si el archivo debe ser copiado
        if (this.shouldCopyFile(fileName)) {
          console.log(
            `✅ Copiando [${this.stats.filesProcessed}/${blobs.length}]: ${blob.name}`
          )
          await this.copyBlob(blob.name, blob.name, blob.size)
        } else {
          this.stats.filesSkipped++
          console.log(
            `⏭️  Omitiendo [${this.stats.filesProcessed}/${blobs.length}]: ${blob.name} (tipo no permitido)`
          )
        }
      }

      this.stats.endTime = new Date()

      // Mostrar resumen
      this.printSummary(caseNumber)
    } catch (error) {
      console.error(`\n❌ Error general: ${error.message}`)
      throw error
    }
  }

  /**
   * Imprime el resumen de la operación
   */
  printSummary(caseNumber) {
    const duration = this.stats.endTime - this.stats.startTime

    console.log('\n' + '='.repeat(60))
    console.log('📋 RESUMEN DE COPIA')
    console.log('='.repeat(60))
    console.log(`\n📁 Caso copiado: ${caseNumber}`)
    console.log(`📊 Contenedor origen: ${SOURCE_CONTAINER}`)
    console.log(`📊 Contenedor destino: ${DEST_CONTAINER}`)

    console.log(`\n⏰ MARCAS DE TIEMPO`)
    console.log(`   🕐 Inicio: ${this.formatDateTime(this.stats.startTime)}`)
    console.log(`   🕐 Fin:    ${this.formatDateTime(this.stats.endTime)}`)
    console.log(`   ⏱️  Duración: ${this.formatDuration(duration)}`)

    console.log(`\n📊 ESTADÍSTICAS`)
    console.log(`   ✅ Archivos procesados: ${this.stats.filesProcessed}`)
    console.log(`   ✅ Archivos copiados: ${this.stats.filesCopied}`)
    console.log(`   ⏭️  Archivos omitidos: ${this.stats.filesSkipped}`)
    console.log(
      `   💾 Tamaño total copiado: ${this.formatBytes(this.stats.totalBytes)}`
    )

    if (this.stats.errors.length > 0) {
      console.log(`\n⚠️  ERRORES ENCONTRADOS: ${this.stats.errors.length}`)
      this.stats.errors.forEach((error, index) => {
        console.log(`   ${index + 1}. ${error.file}`)
        console.log(`      Error: ${error.error}`)
      })
    }

    console.log('\n' + '='.repeat(60) + '\n')
  }
}

// Función principal
async function main() {
  // Obtener el número de caso de los argumentos de línea de comandos
  const caseNumber = process.argv[2]

  if (!caseNumber) {
    console.error(
      '\n❌ Error: Debes proporcionar el número de caso como argumento\n'
    )
    console.log('Uso: node copyCaseFolder.js <numero_de_caso>')
    console.log('Ejemplo: node copyCaseFolder.js 25160\n')
    process.exit(1)
  }

  // Validar que la cadena de conexión esté configurada
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    console.error(
      '\n❌ Error: AZURE_STORAGE_CONNECTION_STRING no está configurada en el archivo .env\n'
    )
    process.exit(1)
  }

  const copier = new CaseFolderCopier()

  try {
    await copier.copyCaseFolder(caseNumber)
  } catch (error) {
    console.error(`\n❌ Error fatal: ${error.message}\n`)
    process.exit(1)
  }
}

// Ejecutar
main()
