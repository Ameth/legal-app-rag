# Sincronización de Notas - ACTS Law RAG

## 📝 Descripción

Este script sincroniza automáticamente las notas de los casos desde **Smart Advocate** hacia **Azure Storage**, permitiendo que sean consultables en el sistema RAG junto con los documentos legales.

## 🎯 Características

- ✅ Sincronización incremental (solo notas nuevas o modificadas)
- ✅ Un archivo por nota: `{CaseNumber}_{YYYYMMDD}_{NoteID}.txt`
- ✅ Metadata incluida en el texto para consultas avanzadas
- ✅ Limpieza automática de HTML entities y tags
- ✅ Cache local para evitar re-sincronizaciones innecesarias
- ✅ Indexación automática mediante Azure AI Search
- ✅ Formato estructurado y legible
- ✅ Granularidad por nota individual para búsquedas precisas

## 📋 Requisitos previos

1. **Variables de entorno** configuradas en `.env`:
   ```env
   AZURE_STORAGE_CONNECTION_STRING="..."
   AZURE_CONTAINER_NAME="testragdocuments"
   SA_API_BASE_URL="https://sa.actslaw.com/CaseSyncAPI"
   SA_USERNAME="OpenAI"
   SA_PASSWORD="..."
   ```

2. **Dependencias instaladas**:
   ```bash
   npm install @azure/storage-blob axios dotenv
   ```

3. **Azure AI Search Indexer** configurado para detectar automáticamente nuevos archivos en el storage.

## 🚀 Uso

### Sincronización manual

```bash
node sync-notes.js
```

### Sincronización con npm script

Añade en `package.json`:
```json
{
  "scripts": {
    "sync-notes": "node sync-notes.js",
    "sync-permissions": "node sync-permissions.js",
    "sync-all": "npm run sync-permissions && npm run sync-notes"
  }
}
```

Luego ejecuta:
```bash
npm run sync-notes
```

## 📂 Estructura de archivos generados

### Ubicación en Azure Storage
```
testragdocuments/
  ├── 25092/
  │   ├── notes/
  │   │   ├── 25092_20251111_711618.txt
  │   │   ├── 25092_20251017_689349.txt
  │   │   ├── 25092_20250918_663279.txt
  │   │   ├── 25092_20250107_446102.txt
  │   │   └── 25092_20250106_444612.txt
  │   └── [otros documentos legales]
  ├── 25096/
  │   ├── notes/
  │   │   ├── 25096_20251101_XXXXXX.txt
  │   │   └── 25096_20251015_YYYYYY.txt
  │   └── [otros documentos]
  └── 25097/
      ├── notes/
      │   └── 25097_20250920_ZZZZZZ.txt
      └── [otros documentos]
```

**Formato del nombre**: `{CaseNumber}_{YYYYMMDD}_{NoteID}.txt`
- `CaseNumber`: Número del caso (ej: 25092)
- `YYYYMMDD`: Fecha de la nota en formato numérico (ej: 20251111)
- `NoteID`: ID único de la nota (ej: 711618)

### Formato del contenido de cada archivo

```txt
CASE NOTE 25092
================================================================================

NOTE ID: 711618
CASE: 25092

================================================================================

METADATA:
  • Date: 11/11/2025 10:52:00
  • Created: 11/11/2025 10:52:10
  • Author: Julian-Jones, Rhys
  • User ID: 797
  • Note Type: Call[ed]
  • Priority: Normal
  • Subject: No subject

================================================================================

CONTENT:

Called Jeff Hughes assistant Kate McBride...

================================================================================

File generated: 2025-11-14T15:30:45.000Z
```

## 🔍 Consultas posibles en el RAG

Una vez sincronizadas, los usuarios podrán hacer preguntas como:

- ✅ "¿Qué notas hay del caso 25092?"
- ✅ "Muéstrame las notas de Lindsey Downey del 17 de octubre"
- ✅ "¿Qué notas de tipo Expert hay?"
- ✅ "¿Qué se discutió sobre Jeff Hughes?"
- ✅ "¿Cuáles son las últimas notas del caso?"
- ✅ "Resumen de las notas sobre estimados de reparación"

## 🔄 Proceso de sincronización

1. **Autenticación** en Smart Advocate API
2. **Lectura de casos** desde Azure Storage
3. **Consulta de notas** para cada caso vía API
4. **Comparación con cache** para detectar cambios
5. **Generación de archivos individuales** por cada nota nueva/modificada
6. **Upload a Azure Storage** en carpeta `{caseNumber}/notes/`
7. **Actualización del cache** local
8. **Indexación automática** por Azure AI Search

## 📊 Cache local

El archivo `notes-cache.json` almacena el estado de las notas sincronizadas:

```json
{
  "25092": {
    "711618": {
      "createdDate": "2025-11-11T10:52:10.107-08:00",
      "modifiedDate": null,
      "noteDate": "2025-11-11T10:52:00-08:00"
    },
    "689349": {
      "createdDate": "2025-10-17T14:23:56.617-07:00",
      "modifiedDate": "2025-10-17T15:39:00-07:00",
      "noteDate": "2025-10-17T14:11:00-07:00"
    }
  }
}
```

**No es necesario hacer commit** de este archivo, se genera automáticamente.

## 🛡️ Permisos y seguridad

- Los usuarios solo pueden consultar notas de los **casos a los que tienen acceso**
- El filtrado de permisos se maneja en el backend (`server.js`)
- No requiere cambios adicionales en el código del servidor

## ⚙️ Configuración avanzada

### Frecuencia de sincronización

Puedes configurar un **cron job** para sincronización automática:

```bash
# Sincronizar notas cada 6 horas
0 */6 * * * cd /ruta/tu/proyecto && npm run sync-notes >> logs/sync-notes.log 2>&1
```

### Delay entre requests

Para no saturar la API de Smart Advocate, hay un delay de 300ms entre cada consulta:

```javascript
// En sync-notes.js, línea ~XXX
await new Promise(resolve => setTimeout(resolve, 300))
```

Puedes ajustarlo según necesites.

## 📈 Estadísticas de ejemplo

```
📊 ESTADÍSTICAS:
   • Total de casos procesados: 8
   • Casos con notas: 6
   • Casos actualizados: 3
   • Casos sin cambios: 3
   • Total de notas: 47
   • Errores: 0
```

## ❗ Troubleshooting

### Error: "Token de Smart Advocate no disponible"
**Solución**: Verifica las credenciales en `.env` (SA_USERNAME y SA_PASSWORD)

### Error: "No se encontraron casos en Azure Storage"
**Solución**: Asegúrate de que existen carpetas con números de caso en el contenedor

### Error: "Error conectando a Azure Storage"
**Solución**: Verifica el AZURE_STORAGE_CONNECTION_STRING en `.env`

### Las notas no aparecen en el RAG
**Solución**: 
1. Verifica que el indexer esté corriendo
2. Espera unos minutos para la indexación automática
3. Verifica los logs del indexer en Azure Portal

## 🔗 Archivos relacionados

- `sync-notes.js` - Script principal de sincronización
- `sync-permissions.js` - Sincronización de permisos de usuarios
- `notes-cache.json` - Cache local (auto-generado)
- `server.js` - Backend que maneja las consultas RAG
- `example-all-notes.txt` - Ejemplo del formato de salida

## 📞 Soporte

Para preguntas o problemas, contacta al equipo de desarrollo de ACTS Law.

---

**Última actualización**: Noviembre 2025
