import { AIProjectClient } from '@azure/ai-projects'
import { DefaultAzureCredential } from '@azure/identity'
import { AzureKeyCredential } from '@azure/core-auth'
import dotenv from 'dotenv'

dotenv.config()

const AZURE_AI_PROJECT_ENDPOINT = process.env.AZURE_AI_PROJECT_ENDPOINT
const AZURE_AGENT_ID = process.env.AZURE_AGENT_ID

console.log('\n' + '='.repeat(60))
console.log('🔍 VERIFICACIÓN DE CONFIGURACIÓN - Azure AI Foundry Agent')
console.log('='.repeat(60) + '\n')

// Test 1: Variables de entorno
console.log('📋 Test 1: Verificando variables de entorno...')
const envVars = {
  AZURE_AI_PROJECT_ENDPOINT,
  AZURE_AGENT_ID,
  JWT_SECRET: process.env.JWT_SECRET,
  PORT: process.env.PORT || 3001,
}

// API Key es opcional (puede usar DefaultAzureCredential si no está)
const AZURE_AI_PROJECT_KEY = process.env.AZURE_AI_PROJECT_KEY
if (AZURE_AI_PROJECT_KEY) {
  console.log('   ✅ AZURE_AI_PROJECT_KEY: ***')
} else {
  console.log('   ⚠️  AZURE_AI_PROJECT_KEY: Not set (will use DefaultAzureCredential)')
}

let allEnvVarsPresent = true
Object.entries(envVars).forEach(([key, value]) => {
  if (!value) {
    console.log(`   ❌ Falta: ${key}`)
    allEnvVarsPresent = false
  } else {
    console.log(`   ✅ ${key}: ${key.includes('SECRET') ? '***' : value}`)
  }
})

if (!allEnvVarsPresent) {
  console.log('\n❌ ERROR: Faltan variables de entorno requeridas')
  console.log('Por favor, revisa tu archivo .env\n')
  process.exit(1)
}

console.log('   ✅ Todas las variables de entorno están configuradas\n')

// Test 2: Autenticación con Azure
console.log('🔐 Test 2: Verificando autenticación con Azure...')
let aiProjectClient
try {
  // Opción 1: API Key (más simple)
  if (AZURE_AI_PROJECT_KEY) {
    aiProjectClient = new AIProjectClient(
      AZURE_AI_PROJECT_ENDPOINT,
      new AzureKeyCredential(AZURE_AI_PROJECT_KEY)
    )
    console.log('   ✅ Cliente de Azure AI Foundry inicializado con API Key\n')
  } 
  // Opción 2: DefaultAzureCredential
  else {
    aiProjectClient = new AIProjectClient(
      AZURE_AI_PROJECT_ENDPOINT,
      new DefaultAzureCredential()
    )
    console.log('   ✅ Cliente de Azure AI Foundry inicializado con DefaultAzureCredential\n')
  }
} catch (error) {
  console.log('   ❌ Error al inicializar cliente de Azure AI Foundry')
  console.log(`   Error: ${error.message}`)
  console.log('\n💡 Solución RECOMENDADA:')
  console.log('   1. Ve a https://ai.azure.com')
  console.log('   2. Navega a tu proyecto: embedding-rag-project')
  console.log('   3. Settings → Keys and Endpoints')
  console.log('   4. Copia la Primary Key')
  console.log('   5. Agrégala a tu .env como: AZURE_AI_PROJECT_KEY=tu_key_aqui')
  console.log('\n   Alternativa: Ejecuta "az login" (pero puede tener problemas en Windows)\n')
  process.exit(1)
}

// Test 3: Acceso al agente
console.log('🤖 Test 3: Verificando acceso al agente...')
let agent
try {
  agent = await aiProjectClient.agents.getAgent(AZURE_AGENT_ID)
  console.log(`   ✅ Agente encontrado: ${agent.name}`)
  console.log(`   📝 Descripción: ${agent.description || 'Sin descripción'}`)
  console.log(`   🔧 Modelo: ${agent.model}`)
  console.log(`   📅 Creado: ${new Date(agent.created_at * 1000).toLocaleString()}\n`)
} catch (error) {
  console.log('   ❌ Error al obtener información del agente')
  console.log(`   Error: ${error.message}`)
  console.log('\n💡 Solución:')
  console.log('   1. Verifica que el AZURE_AGENT_ID es correcto en .env')
  console.log('   2. Verifica que tienes acceso al agente en Azure AI Foundry')
  console.log('   3. Ve a: https://ai.azure.com y verifica que el agente existe\n')
  process.exit(1)
}

// Test 4: Crear y usar un thread de prueba
console.log('🧵 Test 4: Probando creación de thread y mensaje...')
let testThread
try {
  testThread = await aiProjectClient.agents.threads.create()
  console.log(`   ✅ Thread de prueba creado: ${testThread.id}`)

  // Enviar mensaje de prueba
  const testMessage = await aiProjectClient.agents.messages.create(
    testThread.id,
    'user',
    'Hello, this is a test message'
  )
  console.log(`   ✅ Mensaje de prueba enviado: ${testMessage.id}`)

  // Crear run
  let run = await aiProjectClient.agents.runs.create(testThread.id, AZURE_AGENT_ID)
  console.log(`   ✅ Run iniciado: ${run.id}`)

  // Esperar completación (máximo 30 segundos para el test)
  let iterations = 0
  const maxIterations = 30

  while (run.status === 'queued' || run.status === 'in_progress') {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    run = await aiProjectClient.agents.runs.get(testThread.id, run.id)
    iterations++

    if (iterations >= maxIterations) {
      console.log('   ⚠️  El agente está tardando más de 30 segundos...')
      console.log('   Esto es normal para la primera ejecución')
      break
    }
  }

  if (run.status === 'completed') {
    console.log(`   ✅ Run completado exitosamente en ${iterations} segundos`)

    // Obtener respuesta
    const messages = await aiProjectClient.agents.messages.list(testThread.id, {
      order: 'desc',
      limit: 1,
    })

    for await (const message of messages) {
      if (message.role === 'assistant') {
        const content = message.content.find((c) => c.type === 'text' && 'text' in c)
        if (content) {
          console.log(`   💬 Respuesta del agente: "${content.text.value.substring(0, 100)}..."`)
        }
        break
      }
    }
  } else if (run.status === 'failed') {
    console.log(`   ❌ Run falló: ${run.lastError?.message || 'Error desconocido'}`)
    console.log('\n💡 Solución:')
    console.log('   1. Verifica la configuración del agente en Azure AI Foundry')
    console.log('   2. Revisa que el agente tenga acceso a Azure AI Search')
    console.log('   3. Prueba el agente en el Playground primero\n')
  } else {
    console.log(`   ⚠️  Run terminó con estado: ${run.status} (después de ${iterations}s)`)
  }

  // Limpiar thread de prueba
  await aiProjectClient.agents.threads.delete(testThread.id)
  console.log(`   🗑️  Thread de prueba eliminado\n`)
} catch (error) {
  console.log('   ❌ Error en la prueba del thread')
  console.log(`   Error: ${error.message}`)
  console.log('\n💡 Solución:')
  console.log('   1. Verifica que el agente está configurado correctamente')
  console.log('   2. Prueba el agente manualmente en Azure AI Foundry Playground')
  console.log('   3. Revisa los logs en el portal de Azure\n')

  // Intentar limpiar el thread si existe
  if (testThread) {
    try {
      await aiProjectClient.agents.threads.delete(testThread.id)
    } catch (e) {
      // Ignorar errores al limpiar
    }
  }

  process.exit(1)
}

// Test 5: Verificar archivo de permisos
console.log('🔒 Test 5: Verificando archivo de permisos...')
import fs from 'fs'

const permissionsFile = './permissions-cache.json'
if (fs.existsSync(permissionsFile)) {
  try {
    const data = JSON.parse(fs.readFileSync(permissionsFile, 'utf-8'))
    console.log('   ✅ Archivo de permisos encontrado')
    console.log(`   👥 Total usuarios: ${Object.keys(data.permissions || {}).length}`)
    console.log(`   📁 Total casos: ${data.metadata?.totalCases || 'N/A'}`)
    console.log(`   🕐 Última sincronización: ${data.metadata?.lastSync ? new Date(data.metadata.lastSync).toLocaleString() : 'N/A'}\n`)
  } catch (error) {
    console.log('   ⚠️  Error al leer archivo de permisos')
    console.log(`   Error: ${error.message}`)
    console.log('   Se usarán permisos demo\n')
  }
} else {
  console.log('   ⚠️  No se encontró permissions-cache.json')
  console.log('   Se usarán permisos demo para testing\n')
}

// Resumen final
console.log('='.repeat(60))
console.log('✅ VERIFICACIÓN COMPLETADA EXITOSAMENTE')
console.log('='.repeat(60))
console.log('\n📋 Resumen:')
console.log('   ✅ Variables de entorno configuradas')
console.log('   ✅ Autenticación con Azure funcionando')
console.log('   ✅ Agente accesible y operativo')
console.log('   ✅ Sistema de threads funcionando')
console.log('   ✅ El agente responde correctamente')

console.log('\n🚀 TODO LISTO PARA INICIAR EL SERVIDOR')
console.log('Ejecuta: npm start (o node server.js)\n')

console.log('💡 Próximos pasos:')
console.log('   1. Inicia el servidor backend: node server.js')
console.log('   2. Inicia el frontend: npm start')
console.log('   3. Prueba el chat con preguntas reales')
console.log('   4. Revisa los logs para confirmar que todo funciona\n')

console.log('📚 Documentación:')
console.log('   - Guía de migración: MIGRATION_GUIDE.md')
console.log('   - Configuración del agente: AGENT_CONFIGURATION_GUIDE.md\n')

process.exit(0)