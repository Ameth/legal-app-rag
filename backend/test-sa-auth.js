import axios from 'axios'
import dotenv from 'dotenv'

dotenv.config()

async function testAuth() {
  console.log('🔐 Probando autenticación en Smart Advocate...\n')

  try {
    const response = await axios.post(
      `${process.env.SA_API_BASE_URL}/Users/authenticate`,
      {
        Username: process.env.SA_USERNAME,
        Password: process.env.SA_PASSWORD
      }
    )

    console.log('✅ Autenticación exitosa!')
    console.log(`   Usuario: ${response.data.username}`)
    console.log(`   User ID: ${response.data.userID}`)
    console.log(`   Token: ${response.data.token.substring(0, 50)}...\n`)

    // Probar el token en una consulta
    const token = response.data.token
    const staffResponse = await axios.get(
      `${process.env.SA_API_BASE_URL}/case/staff/byCaseNumber?CaseNumber=25092`,
      {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      }
    )

    console.log(`✅ Consulta de staff exitosa!`)
    console.log(`   Usuarios encontrados: ${staffResponse.data.length}`)
  } catch (error) {
    console.error('❌ Error:', error.response?.data || error.message)
  }
}

testAuth()