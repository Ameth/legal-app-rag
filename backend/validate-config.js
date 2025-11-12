import { BlobServiceClient } from '@azure/storage-blob'
import axios from 'axios'
import dotenv from 'dotenv'
import fs from 'fs'

dotenv.config()

// ===== COLORES PARA CONSOLA =====
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
}

function success(msg) {
  console.log(`${colors.green}✅ ${msg}${colors.reset}`)
}

function error(msg) {
  console.log(`${colors.red}❌ ${msg}${colors.reset}`)
}

function warning(msg) {
  console.log(`${colors.yellow}⚠️  ${msg}${colors.reset}`)
}

function info(msg) {
  console.log(`${colors.cyan}ℹ️  ${msg}${colors.reset}`)
}

// ===== VALIDACIONES =====

async function validateEnvironmentVariables() {
  console.log('\n📋 Validando Variables de Entorno...')

  const required = [
    'AZURE_STORAGE_CONNECTION_STRING',
    'AZURE_CONTAINER_NAME',
    'AZURE_OPENAI_ENDPOINT',
    'AZURE_OPENAI_KEY',
    'SA_USERNAME',
    'SA_PASSWORD',
  ]

  const optional = []

  let allValid = true

  // Validar requeridas
  for (const varName of required) {
    if (process.env[varName]) {
      success(`${varName} configurada`)
    } else {
      error(`${varName} NO configurada (REQUERIDA)`)
      allValid = false
    }
  }

  // Validar opcionales
  for (const varName of optional) {
    if (process.env[varName]) {
      info(`${varName} configurada`)
    } else {
      warning(`${varName} no configurada (opcional)`)
    }
  }

  return allValid
}

async function validateAzureStorage() {
  console.log('\n☁️  Validando Conexión a Azure Storage...')

  try {
    const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING
    const containerName = process.env.AZURE_CONTAINER_NAME

    if (!connectionString) {
      error('AZURE_STORAGE_CONNECTION_STRING no configurada')
      return false
    }

    info('Conectando a Azure Storage...')
    const blobServiceClient =
      BlobServiceClient.fromConnectionString(connectionString)
    const containerClient = blobServiceClient.getContainerClient(containerName)

    // Verificar que el contenedor existe
    const exists = await containerClient.exists()
    if (!exists) {
      error(`El contenedor "${containerName}" no existe`)
      return false
    }

    success(`Conexión exitosa al contenedor "${containerName}"`)

    // Contar carpetas (casos)
    info('Listando casos en Azure Storage...')
    const caseNumbers = new Set()

    for await (const blob of containerClient.listBlobsFlat()) {
      const pathParts = blob.name.split('/')
      if (pathParts.length > 1 && /^\d+$/.test(pathParts[0])) {
        caseNumbers.add(pathParts[0])
      }
    }

    success(`Encontrados ${caseNumbers.size} casos en Azure Storage`)
    if (caseNumbers.size > 0) {
      const sampleCases = Array.from(caseNumbers).slice(0, 5)
      info(
        `Ejemplos: ${sampleCases.join(', ')}${
          caseNumbers.size > 5 ? ', ...' : ''
        }`
      )
    } else {
      warning('No se encontraron casos (carpetas) en el contenedor')
    }

    return caseNumbers.size > 0
  } catch (error) {
    error(`Error conectando a Azure Storage: ${error.message}`)
    return false
  }
}

async function validateSmartAdvocateAPI() {
  console.log('\n🔍 Validando Acceso a Smart Advocate API...')

  try {
    // PASO 1: Autenticar y obtener token
    const authUrl = `${process.env.SA_API_BASE_URL}/Users/authenticate`
    const username = process.env.SA_USERNAME
    const password = process.env.SA_PASSWORD

    if (!username || !password) {
      error('SA_USERNAME y SA_PASSWORD no configuradas')
      return false
    }

    info(`Autenticando usuario: ${username}`)

    const authResponse = await axios.post(
      authUrl,
      {
        Username: username,
        Password: password,
      },
      {
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    )

    if (authResponse.status === 200 && authResponse.data.token) {
      success('Autenticación exitosa en Smart Advocate')
      info(
        `Usuario: ${authResponse.data.username} (ID: ${authResponse.data.userID})`
      )

      const token = authResponse.data.token

      // PASO 2: Probar endpoint de staff con el token
      const testCaseNumber = '25092' // Caso de prueba
      const staffUrl = `${process.env.SA_API_BASE_URL}/case/staff/byCaseNumber?CaseNumber=${testCaseNumber}`

      info(`Probando endpoint de staff con caso ${testCaseNumber}...`)

      const staffResponse = await axios.get(staffUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      })

      if (staffResponse.status === 200) {
        success('Endpoint de staff accesible')

        const staffCount = Array.isArray(staffResponse.data)
          ? staffResponse.data.length
          : 0
        if (staffCount > 0) {
          success(
            `Caso de prueba ${testCaseNumber} retorna ${staffCount} usuarios`
          )
          info(
            `Primer usuario: ${staffResponse.data[0].firstName} ${staffResponse.data[0].lastName} (${staffResponse.data[0].email})`
          )
        } else {
          warning(
            `Caso de prueba ${testCaseNumber} no tiene usuarios asignados`
          )
        }

        return true
      }
    } else {
      error('No se recibió token en la respuesta de autenticación')
      return false
    }
  } catch (error) {
    if (error.response) {
      error(`Error HTTP ${error.response.status}: ${error.response.statusText}`)
      if (error.response.status === 401 || error.response.status === 403) {
        warning(
          'Credenciales inválidas. Verifica SA_USERNAME y SA_PASSWORD en .env'
        )
      } else if (error.response.status === 404) {
        warning(
          'Caso de prueba no encontrado. Esto es normal si el caso no existe.'
        )
        return true // No es un error crítico
      }
    } else if (error.code === 'ECONNREFUSED') {
      error('No se pudo conectar a Smart Advocate. Verifica conectividad.')
    } else {
      error(`Error: ${error.message}`)
    }
    return false
  }
}

async function validatePermissionsFile() {
  console.log('\n📄 Validando Archivo de Permisos Existente...')

  const filePath = './permissions-cache.json'

  if (!fs.existsSync(filePath)) {
    warning('permissions-cache.json no existe (se creará al ejecutar sync)')
    return true
  }

  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))

    success('permissions-cache.json existe y es válido')

    if (data.metadata) {
      info(`Total usuarios: ${data.metadata.totalUsers}`)
      info(`Total casos: ${data.metadata.totalCases}`)

      const lastSync = new Date(data.metadata.lastSync)
      const daysSinceSync =
        (Date.now() - lastSync.getTime()) / (1000 * 60 * 60 * 24)

      info(
        `Última sincronización: ${lastSync.toLocaleString()} (hace ${Math.round(
          daysSinceSync
        )} días)`
      )

      if (daysSinceSync > 35) {
        warning(
          `Permisos desactualizados (más de 35 días). Se recomienda sincronizar.`
        )
      } else {
        success('Permisos actualizados')
      }
    }

    return true
  } catch (error) {
    error(`Error leyendo permissions-cache.json: ${error.message}`)
    warning('El archivo será sobrescrito al ejecutar sync')
    return true // No es crítico, se recreará
  }
}

function validateNodeModules() {
  console.log('\n📦 Validando Dependencias de Node.js...')

  const requiredPackages = ['@azure/storage-blob', 'axios', 'dotenv']

  let allInstalled = true

  for (const pkg of requiredPackages) {
    try {
      // Verificar si existe en node_modules
      const pkgPath = `./node_modules/${pkg}/package.json`
      if (fs.existsSync(pkgPath)) {
        success(`${pkg} instalado`)
      } else {
        error(`${pkg} NO instalado`)
        allInstalled = false
      }
    } catch {
      error(`${pkg} NO instalado`)
      allInstalled = false
    }
  }

  if (!allInstalled) {
    warning('Ejecuta: npm install')
  }

  return allInstalled
}

// ===== EJECUCIÓN PRINCIPAL =====

async function runValidation() {
  console.log('\n' + '='.repeat(70))
  console.log('🔍 VALIDACIÓN DE CONFIGURACIÓN - ACTS Law RAG Permissions Sync')
  console.log('='.repeat(70))

  const results = {
    env: await validateEnvironmentVariables(),
    modules: validateNodeModules(),
    storage: false,
    api: false,
    file: false,
  }

  if (results.env) {
    results.storage = await validateAzureStorage()
    results.api = await validateSmartAdvocateAPI()
  }

  results.file = await validatePermissionsFile()

  // Resumen
  console.log('\n' + '='.repeat(70))
  console.log('📊 RESUMEN DE VALIDACIÓN')
  console.log('='.repeat(70))

  const checks = [
    { name: 'Variables de Entorno', status: results.env },
    { name: 'Dependencias de Node.js', status: results.modules },
    { name: 'Conexión a Azure Storage', status: results.storage },
    { name: 'Acceso a Smart Advocate API', status: results.api },
    { name: 'Archivo de Permisos', status: results.file },
  ]

  checks.forEach((check) => {
    const icon = check.status ? '✅' : '❌'
    const color = check.status ? colors.green : colors.red
    console.log(`${color}${icon} ${check.name}${colors.reset}`)
  })

  const allPassed = Object.values(results).every((r) => r === true)

  console.log('\n' + '='.repeat(70))

  if (allPassed) {
    success('TODAS LAS VALIDACIONES PASARON ✅')
    console.log('\n✨ Puedes ejecutar la sincronización con: npm run sync\n')
    process.exit(0)
  } else {
    error('ALGUNAS VALIDACIONES FALLARON ❌')
    console.log(
      '\n⚠️  Corrige los errores antes de ejecutar sync-permissions.js\n'
    )
    process.exit(1)
  }
}

// Ejecutar validación
runValidation()
