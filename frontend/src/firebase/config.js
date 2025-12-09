import { initializeApp } from 'firebase/app'
import { getAuth, OAuthProvider, signInWithPopup } from 'firebase/auth'

// Tu configuración de Firebase (obtenerla de Firebase Console)
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
}

// Validar que todas las variables estén configuradas
if (!firebaseConfig.apiKey || !firebaseConfig.authDomain) {
  console.error('❌ Firebase configuration is missing. Check your .env file.')
}

// Inicializar Firebase
const app = initializeApp(firebaseConfig)
export const auth = getAuth(app)

// Configurar proveedor de Microsoft
export const microsoftProvider = new OAuthProvider('microsoft.com')
microsoftProvider.setCustomParameters({
  tenant: 'common', // o tu tenant ID específico
  prompt: 'select_account',
})

// Función de login con Microsoft
export const signInWithMicrosoft = async () => {
  try {
    const result = await signInWithPopup(auth, microsoftProvider)
    const user = result.user // Este es el objeto completo de Firebase User

    return { success: true, user: user } // Retornar el objeto completo
  } catch (error) {
    console.error('Error signing in with Microsoft:', error)
    return { success: false, error: error.message }
  }
}

// Función de logout
export const signOut = async () => {
  try {
    await auth.signOut()
    return { success: true }
  } catch (error) {
    console.error('Error signing out:', error)
    return { success: false, error: error.message }
  }
}
