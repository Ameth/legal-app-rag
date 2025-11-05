// test-api.js - Script de testing para ACTS Law RAG API
// Versión ES Module - Compatible con "type": "module"

import axios from 'axios';

const BASE_URL = 'http://localhost:3001';

// Colores para la consola
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function separator(char = '=', length = 60) {
  console.log(char.repeat(length));
}

function testHeader(number, title) {
  console.log('\n');
  log(`📊 Test ${number}: ${title}`, 'yellow');
  separator('-', 60);
}

function printJSON(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

async function runTests() {
  log('\n' + '='.repeat(60), 'cyan');
  log('       ACTS Law RAG API Testing Suite', 'cyan');
  log('='.repeat(60) + '\n', 'cyan');

  let allTestsPassed = true;
  let token1, token2, token3;

  // ==================== TEST 1: Health Check ====================
  try {
    testHeader(1, 'Health Check');
    
    const response = await axios.get(`${BASE_URL}/health`);
    printJSON(response.data);
    
    if (response.data.status === 'ok') {
      log('\n✅ Health check passed!', 'green');
    } else {
      log('\n❌ Health check failed!', 'red');
      allTestsPassed = false;
    }
  } catch (error) {
    log('\n❌ Health check failed!', 'red');
    log(`Error: ${error.message}`, 'red');
    log('\n⚠️  El servidor debe estar corriendo en http://localhost:3001', 'yellow');
    log('⚠️  Ejecuta en otra terminal: npm run dev', 'yellow');
    return;
  }

  // ==================== TEST 2: Login as Attorney 1 ====================
  try {
    testHeader(2, 'Login as Attorney 1 (Cases: 25092, 25096)');
    
    const response = await axios.post(`${BASE_URL}/api/login`, {
      email: 'abogado1@actslaw.com',
      password: 'password123'
    });
    
    printJSON(response.data);
    token1 = response.data.token;
    
    if (token1) {
      log('\n✅ Login successful! Token obtained.', 'green');
    } else {
      log('\n❌ Login failed! No token received.', 'red');
      allTestsPassed = false;
      return;
    }
  } catch (error) {
    log('\n❌ Login failed!', 'red');
    log(`Error: ${error.message}`, 'red');
    allTestsPassed = false;
    return;
  }

  // ==================== TEST 3: Get User Info ====================
  try {
    testHeader(3, 'Get User Info (Attorney 1)');
    
    const response = await axios.get(`${BASE_URL}/api/me`, {
      headers: { Authorization: `Bearer ${token1}` }
    });
    
    printJSON(response.data);
    
    if (response.data.email === 'abogado1@actslaw.com') {
      log('\n✅ User info retrieved successfully!', 'green');
    } else {
      log('\n❌ User info mismatch!', 'red');
      allTestsPassed = false;
    }
  } catch (error) {
    log('\n❌ Get user info failed!', 'red');
    log(`Error: ${error.message}`, 'red');
    allTestsPassed = false;
  }

  // ==================== TEST 4: Chat Query - Case 25092 Info ====================
  try {
    testHeader(4, 'Chat Query - Information from Case 25092');
    log('Question: What information is available about Mitra Farokhpay?\n', 'cyan');
    
    const response = await axios.post(`${BASE_URL}/api/chat`, {
      message: 'What information is available about Mitra Farokhpay?'
    }, {
      headers: { Authorization: `Bearer ${token1}` }
    });
    
    console.log('Response:');
    printJSON({
      message: response.data.message.substring(0, 200) + '...',
      citations_count: response.data.citations.length,
      sample_citation: response.data.citations[0] || null
    });
    
    if (response.data.citations.length > 0) {
      log('\n✅ Query successful! Found relevant documents.', 'green');
      log(`   📄 Citations found: ${response.data.citations.length}`, 'blue');
    } else {
      log('\n⚠️  Query returned no citations. This might indicate:', 'yellow');
      log('   - No documents indexed for case 25092', 'yellow');
      log('   - Filtering issue with parent_id', 'yellow');
      log('   - Azure Search configuration problem', 'yellow');
    }
  } catch (error) {
    log('\n❌ Chat query failed!', 'red');
    log(`Error: ${error.response?.data?.error || error.message}`, 'red');
    allTestsPassed = false;
  }

  // ==================== TEST 5: Chat Query - Property Address ====================
  try {
    testHeader(5, 'Chat Query - Property Address');
    log('Question: What is the property address in case 25092?\n', 'cyan');
    
    const response = await axios.post(`${BASE_URL}/api/chat`, {
      message: 'What is the property address in case 25092?'
    }, {
      headers: { Authorization: `Bearer ${token1}` }
    });
    
    console.log('Response:');
    printJSON({
      message: response.data.message.substring(0, 200) + '...',
      citations_count: response.data.citations.length
    });
    
    if (response.data.citations.length > 0) {
      log('\n✅ Query successful!', 'green');
    } else {
      log('\n⚠️  No citations found', 'yellow');
    }
  } catch (error) {
    log('\n❌ Chat query failed!', 'red');
    log(`Error: ${error.response?.data?.error || error.message}`, 'red');
  }

  // ==================== TEST 6: Login as Attorney 2 ====================
  try {
    testHeader(6, 'Login as Attorney 2 (Only Case: 25092)');
    
    const response = await axios.post(`${BASE_URL}/api/login`, {
      email: 'abogado2@actslaw.com',
      password: 'password123'
    });
    
    printJSON(response.data);
    token2 = response.data.token;
    
    if (token2) {
      log('\n✅ Login successful!', 'green');
    }
  } catch (error) {
    log('\n❌ Login failed!', 'red');
    log(`Error: ${error.message}`, 'red');
  }

  // ==================== TEST 7: Chat from Attorney 2 ====================
  try {
    testHeader(7, 'Chat Query from Attorney 2');
    log('Question: Tell me about Wilshire Regent Homeowners Association\n', 'cyan');
    
    const response = await axios.post(`${BASE_URL}/api/chat`, {
      message: 'Tell me about Wilshire Regent Homeowners Association'
    }, {
      headers: { Authorization: `Bearer ${token2}` }
    });
    
    console.log('Response:');
    printJSON({
      message: response.data.message.substring(0, 200) + '...',
      citations_count: response.data.citations.length
    });
    
    if (response.data.citations.length > 0) {
      log('\n✅ Query successful!', 'green');
    } else {
      log('\n⚠️  No citations found', 'yellow');
    }
  } catch (error) {
    log('\n❌ Chat query failed!', 'red');
    log(`Error: ${error.response?.data?.error || error.message}`, 'red');
  }

  // ==================== TEST 8: Login as Attorney 3 ====================
  try {
    testHeader(8, 'Login as Attorney 3 (Only Case: 25097 - No documents)');
    
    const response = await axios.post(`${BASE_URL}/api/login`, {
      email: 'abogado3@actslaw.com',
      password: 'password123'
    });
    
    printJSON(response.data);
    token3 = response.data.token;
    
    if (token3) {
      log('\n✅ Login successful!', 'green');
    }
  } catch (error) {
    log('\n❌ Login failed!', 'red');
    log(`Error: ${error.message}`, 'red');
  }

  // ==================== TEST 9: Chat from Attorney 3 (Should be denied) ====================
  try {
    testHeader(9, 'Chat Query from Attorney 3 (Should have no access to case 25092)');
    log('Question: What information is available about case 25092?\n', 'cyan');
    
    const response = await axios.post(`${BASE_URL}/api/chat`, {
      message: 'What information is available about case 25092?'
    }, {
      headers: { Authorization: `Bearer ${token3}` }
    });
    
    console.log('Response:');
    printJSON({
      message: response.data.message.substring(0, 300) + '...',
      citations_count: response.data.citations.length
    });
    
    if (response.data.citations.length === 0) {
      log('\n✅ Access control working! Attorney 3 cannot access case 25092.', 'green');
    } else {
      log('\n❌ SECURITY ISSUE! Attorney 3 should NOT have access to case 25092!', 'red');
      allTestsPassed = false;
    }
  } catch (error) {
    log('\n❌ Chat query failed!', 'red');
    log(`Error: ${error.response?.data?.error || error.message}`, 'red');
  }

  // ==================== TEST 10: Invalid Token ====================
  try {
    testHeader(10, 'Invalid Token Test (Should be rejected)');
    
    await axios.get(`${BASE_URL}/api/me`, {
      headers: { Authorization: 'Bearer invalid_token_here' }
    });
    
    log('\n❌ SECURITY ISSUE! Invalid token was accepted!', 'red');
    allTestsPassed = false;
  } catch (error) {
    if (error.response?.status === 403) {
      log('\n✅ Security working! Invalid token was rejected.', 'green');
    } else {
      log('\n⚠️  Unexpected error', 'yellow');
    }
  }

  // ==================== SUMMARY ====================
  console.log('\n');
  separator('=', 60);
  if (allTestsPassed) {
    log('🎉 ALL TESTS PASSED! Sistema funcionando correctamente.', 'green');
  } else {
    log('⚠️  SOME TESTS FAILED. Revisa los errores arriba.', 'yellow');
  }
  separator('=', 60);
  console.log('\n');

  // ==================== RECOMMENDATIONS ====================
  log('📋 Recomendaciones:', 'cyan');
  log('   1. Verifica que el backend esté corriendo (npm run dev)', 'blue');
  log('   2. Revisa que Azure Search tenga documentos indexados', 'blue');
  log('   3. Verifica las credenciales en el archivo .env', 'blue');
  log('   4. Revisa los logs del servidor para más detalles', 'blue');
  console.log('\n');
}

// Ejecutar tests
log('\n🚀 Iniciando tests del sistema RAG...', 'cyan');
log('⏳ Por favor espera, esto puede tomar unos segundos...\n', 'cyan');

runTests().catch(error => {
  log('\n❌ Error fatal en los tests:', 'red');
  console.error(error);
  process.exit(1);
});