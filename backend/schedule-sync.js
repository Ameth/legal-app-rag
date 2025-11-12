import cron from 'node-cron'
import { exec } from 'child_process'
import fs from 'fs'
import path from 'path'

// ===== CONFIGURACIÓN =====
const SYNC_SCHEDULE = '0 3 1 * *' // Día 1 de cada mes a las 3 AM
const LOG_DIR = './logs'
const PERMISSIONS_FILE = './permissions-cache.json'

// Crear directorio de logs si no existe
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true })
}

// ===== FUNCIONES AUXILIARES =====

/**
 * Ejecuta la sincronización de permisos
 */
function runSync() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const logFile = path.join(LOG_DIR, `sync-${timestamp}.log`)
  
  console.log(`\n${'='.repeat(60)}`)
  console.log(`🔄 Sincronización Programada Iniciada`)
  console.log(`⏰ ${new Date().toLocaleString()}`)
  console.log(`📝 Log: ${logFile}`)
  console.log(`${'='.repeat(60)}\n`)

  const logStream = fs.createWriteStream(logFile)

  const syncProcess = exec('node sync-permissions.js')

  // Redirigir salida al log y a consola
  syncProcess.stdout.on('data', (data) => {
    process.stdout.write(data)
    logStream.write(data)
  })

  syncProcess.stderr.on('data', (data) => {
    process.stderr.write(data)
    logStream.write(`ERROR: ${data}`)
  })

  syncProcess.on('close', (code) => {
    const message = code === 0
      ? `✅ Sincronización completada exitosamente`
      : `❌ Sincronización falló con código ${code}`

    console.log(`\n${message}`)
    logStream.write(`\n${message}\n`)
    logStream.end()

    // Enviar notificación (opcional)
    if (code === 0) {
      notifySuccess()
    } else {
      notifyError(code)
    }
  })
}

/**
 * Notifica éxito de sincronización
 */
function notifySuccess() {
  try {
    const data = JSON.parse(fs.readFileSync(PERMISSIONS_FILE, 'utf-8'))
    console.log(`\n📊 Resumen de Sincronización:`)
    console.log(`   👥 Total usuarios: ${data.metadata.totalUsers}`)
    console.log(`   📁 Total casos: ${data.metadata.totalCases}`)
    console.log(`   🕐 Última sync: ${new Date(data.metadata.lastSync).toLocaleString()}`)

    // Aquí puedes agregar notificaciones por email, Slack, etc.
    // sendSlackNotification(`✅ Permisos sincronizados: ${data.metadata.totalUsers} usuarios`)
  } catch (error) {
    console.error('⚠️  No se pudo leer el archivo de permisos')
  }
}

/**
 * Notifica error de sincronización
 */
function notifyError(code) {
  console.error(`\n❌ La sincronización falló con código de error: ${code}`)
  console.error(`📝 Revisa los logs en: ${LOG_DIR}`)

  // Aquí puedes agregar notificaciones por email, Slack, etc.
  // sendSlackNotification(`❌ ERROR: Sincronización de permisos falló (código ${code})`)
}

/**
 * Verifica el estado del sistema
 */
function checkHealth() {
  console.log('\n🏥 Verificando estado del sistema...')

  // Verificar que existe el archivo de permisos
  if (fs.existsSync(PERMISSIONS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(PERMISSIONS_FILE, 'utf-8'))
      const lastSync = new Date(data.metadata.lastSync)
      const daysSinceSync = (Date.now() - lastSync.getTime()) / (1000 * 60 * 60 * 24)

      console.log(`✅ Archivo de permisos existe`)
      console.log(`   📊 ${data.metadata.totalUsers} usuarios, ${data.metadata.totalCases} casos`)
      console.log(`   🕐 Última sincronización: ${lastSync.toLocaleString()} (hace ${Math.round(daysSinceSync)} días)`)

      if (daysSinceSync > 35) {
        console.warn(`\n⚠️  ADVERTENCIA: Permisos desactualizados (${Math.round(daysSinceSync)} días)`)
        console.warn(`   Se recomienda ejecutar una sincronización manual`)
      }
    } catch (error) {
      console.error(`❌ Error leyendo archivo de permisos: ${error.message}`)
    }
  } else {
    console.error(`❌ Archivo de permisos no encontrado: ${PERMISSIONS_FILE}`)
    console.log(`   Ejecuta: npm run sync`)
  }

  // Limpiar logs antiguos (más de 90 días)
  cleanOldLogs(90)
}

/**
 * Limpia logs antiguos
 */
function cleanOldLogs(daysOld) {
  try {
    const files = fs.readdirSync(LOG_DIR)
    const now = Date.now()
    let deletedCount = 0

    files.forEach((file) => {
      const filePath = path.join(LOG_DIR, file)
      const stats = fs.statSync(filePath)
      const fileAge = (now - stats.mtime.getTime()) / (1000 * 60 * 60 * 24)

      if (fileAge > daysOld) {
        fs.unlinkSync(filePath)
        deletedCount++
      }
    })

    if (deletedCount > 0) {
      console.log(`🧹 Logs antiguos limpiados: ${deletedCount} archivos`)
    }
  } catch (error) {
    console.error(`⚠️  Error limpiando logs: ${error.message}`)
  }
}

// ===== PROGRAMACIÓN DE TAREAS =====

console.log('\n' + '='.repeat(60))
console.log('⏰ ACTS Law RAG - Scheduler de Sincronización de Permisos')
console.log('='.repeat(60))
console.log(`📅 Programación: ${SYNC_SCHEDULE}`)
console.log(`   (Día 1 de cada mes a las 3:00 AM)`)
console.log(`📝 Logs guardados en: ${LOG_DIR}`)
console.log('='.repeat(60) + '\n')

// Verificar estado inicial
checkHealth()

// Programar sincronización mensual
cron.schedule(SYNC_SCHEDULE, () => {
  runSync()
})

// Health check diario a las 9 AM
cron.schedule('0 9 * * *', () => {
  console.log('\n📊 Health Check Diario')
  checkHealth()
})

console.log('\n✅ Scheduler iniciado correctamente')
console.log('⏸️  Presiona Ctrl+C para detener\n')

// Manejar cierre limpio
process.on('SIGINT', () => {
  console.log('\n\n👋 Cerrando scheduler...')
  process.exit(0)
})

process.on('SIGTERM', () => {
  console.log('\n\n👋 Cerrando scheduler...')
  process.exit(0)
})
