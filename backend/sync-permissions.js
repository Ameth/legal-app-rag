import { BlobServiceClient } from '@azure/storage-blob'
import axios from 'axios'
import fs from 'fs'
import dotenv from 'dotenv'

dotenv.config()

// ===== CONFIGURACIÓN =====
const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING
const AZURE_CONTAINER_NAME = process.env.AZURE_CONTAINER_NAME
const SA_API_BASE_URL = process.env.SA_API_BASE_URL
const SA_USERNAME = process.env.SA_USERNAME
const SA_PASSWORD = process.env.SA_PASSWORD
const OUTPUT_FILE = './permissions-cache.json'

// Variable global para almacenar el token de Smart Advocate
let smartAdvocateToken = null

// ===== FUNCIONES AUXILIARES =====

/**
 * Autentica en Smart Advocate API y obtiene el token JWT
 */
async function authenticateSmartAdvocate() {
  console.log('🔐 Autenticando en Smart Advocate API...')
  
  if (!SA_USERNAME || !SA_PASSWORD) {
    throw new Error('SA_USERNAME y SA_PASSWORD son requeridos en el archivo .env')
  }

  try {
    const response = await axios.post(
      `${SA_API_BASE_URL}/Users/authenticate`,
      {
        Username: SA_USERNAME,
        Password: SA_PASSWORD
      },
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    )

    if (response.data && response.data.token) {
      smartAdvocateToken = response.data.token
      console.log(`   ✅ Autenticación exitosa`)
      console.log(`   👤 Usuario: ${response.data.username} (ID: ${response.data.userID})`)
      return true
    } else {
      throw new Error('Token no recibido en la respuesta')
    }
  } catch (error) {
    console.error('   ❌ Error de autenticación:', error.response?.data || error.message)
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
    const containerClient = blobServiceClient.getContainerClient(AZURE_CONTAINER_NAME)

    console.log('📂 Listando carpetas (casos) en el contenedor...')
    
    const caseNumbers = new Set()
    
    // Listar todos los blobs con prefijo para obtener estructura de carpetas
    for await (const blob of containerClient.listBlobsFlat({ includeMetadata: true })) {
      // Extraer el número de caso del path (formato esperado: 25092/documento.pdf)
      const pathParts = blob.name.split('/')
      if (pathParts.length > 1) {
        const caseNumber = pathParts[0]
        // Validar que sea un número
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
 * Consulta la API de Smart Advocate para obtener staff de un caso
 */
async function getStaffByCaseNumber(caseNumber) {
  try {
    const url = `${SA_API_BASE_URL}/case/staff/byCaseNumber?CaseNumber=${caseNumber}`
    
    if (!smartAdvocateToken) {
      throw new Error('Token de Smart Advocate no disponible. Autenticación requerida.')
    }

    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${smartAdvocateToken}`,
        'Content-Type': 'application/json'
      }
    })
    
    return response.data // Array de usuarios
  } catch (error) {
    if (error.response?.status === 404) {
      console.warn(`   ⚠️  Caso ${caseNumber}: No se encontró información`)
      return []
    }
    if (error.response?.status === 401) {
      console.error(`   ❌ Error de autenticación para caso ${caseNumber}`)
      console.error(`   Token puede haber expirado. Re-autenticando...`)
      // Intentar re-autenticar
      await authenticateSmartAdvocate()
      // Reintentar la consulta
      try {
        const response = await axios.get(url, {
          headers: {
            'Authorization': `Bearer ${smartAdvocateToken}`,
            'Content-Type': 'application/json'
          }
        })
        return response.data
      } catch (retryError) {
        console.error(`   ❌ Reintento falló para caso ${caseNumber}`)
        return []
      }
    }
    console.error(`   ❌ Error consultando caso ${caseNumber}:`, error.message)
    return []
  }
}

/**
 * Invierte la estructura: de caso→usuarios a usuario→casos
 */
function invertPermissionsStructure(caseStaffMap) {
  console.log('\n🔄 Invirtiendo estructura de permisos...')
  
  const userPermissions = {}

  for (const [caseNumber, staffList] of Object.entries(caseStaffMap)) {
    for (const staff of staffList) {
      const email = staff.email.toLowerCase().trim()
      
      if (!userPermissions[email]) {
        userPermissions[email] = {
          name: `${staff.firstName} ${staff.lastName}`,
          email: email,
          role: staff.role,
          phone: staff.phone || null,
          cases: []
        }
      }
      
      // Agregar caso si no está ya en la lista
      if (!userPermissions[email].cases.includes(caseNumber)) {
        userPermissions[email].cases.push(caseNumber)
      }
    }
  }

  // Ordenar casos de cada usuario
  for (const user of Object.values(userPermissions)) {
    user.cases.sort()
  }

  console.log(`✅ Estructura invertida: ${Object.keys(userPermissions).length} usuarios únicos`)
  
  return userPermissions
}

/**
 * Guarda los permisos en archivo JSON con metadata
 */
function savePermissionsToFile(permissions) {
  const data = {
    metadata: {
      lastSync: new Date().toISOString(),
      totalUsers: Object.keys(permissions).length,
      totalCases: new Set(
        Object.values(permissions).flatMap(u => u.cases)
      ).size,
      syncedBy: 'sync-permissions.js'
    },
    permissions: permissions
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(data, null, 2), 'utf-8')
  console.log(`\n💾 Permisos guardados en: ${OUTPUT_FILE}`)
  console.log(`   📊 Total usuarios: ${data.metadata.totalUsers}`)
  console.log(`   📁 Total casos: ${data.metadata.totalCases}`)
}

// ===== PROCESO PRINCIPAL =====

async function syncPermissions() {
  console.log('\n' + '='.repeat(70))
  console.log('🔄 SINCRONIZACIÓN DE PERMISOS - ACTS Law RAG')
  console.log('='.repeat(70))
  console.log(`⏰ Iniciado: ${new Date().toLocaleString()}`)

  try {
    // PASO 0: Autenticar en Smart Advocate
    await authenticateSmartAdvocate()

    // PASO 1: Obtener lista de casos desde Azure Storage
    const caseNumbers = await getCaseNumbersFromAzureStorage()
    
    if (caseNumbers.length === 0) {
      console.log('\n⚠️  No se encontraron casos en Azure Storage')
      return
    }

    // PASO 2: Consultar Smart Advocate por cada caso
    console.log('\n🔍 Consultando Smart Advocate API...')
    const caseStaffMap = {}
    
    for (let i = 0; i < caseNumbers.length; i++) {
      const caseNumber = caseNumbers[i]
      const progress = `[${i + 1}/${caseNumbers.length}]`
      
      console.log(`${progress} Consultando caso ${caseNumber}...`)
      
      const staff = await getStaffByCaseNumber(caseNumber)
      caseStaffMap[caseNumber] = staff
      
      console.log(`   ✓ ${staff.length} usuarios asignados`)
      
      // Delay para no saturar la API (opcional)
      if (i < caseNumbers.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 300)) // 300ms entre requests
      }
    }

    // PASO 3: Invertir estructura y guardar
    const userPermissions = invertPermissionsStructure(caseStaffMap)
    savePermissionsToFile(userPermissions)

    // PASO 4: Mostrar resumen
    console.log('\n' + '='.repeat(70))
    console.log('✅ SINCRONIZACIÓN COMPLETADA EXITOSAMENTE')
    console.log('='.repeat(70))
    
    // Top 5 usuarios con más casos
    const topUsers = Object.entries(userPermissions)
      .sort((a, b) => b[1].cases.length - a[1].cases.length)
      .slice(0, 5)
    
    console.log('\n📊 Top 5 usuarios con más casos asignados:')
    topUsers.forEach(([ email, user ], index) => {
      console.log(`   ${index + 1}. ${user.name} (${email})`)
      console.log(`      📁 ${user.cases.length} casos: ${user.cases.join(', ')}`)
    })

    console.log(`\n⏰ Finalizado: ${new Date().toLocaleString()}\n`)

  } catch (error) {
    console.error('\n❌ ERROR DURANTE LA SINCRONIZACIÓN:')
    console.error(error)
    process.exit(1)
  }
}

// Ejecutar sincronización
syncPermissions()
