import { useState } from 'react'

/**
 * Custom hook para manejar la exportación de chats
 * @param {Array} messages - Array de mensajes del chat
 * @param {Object} user - Objeto de usuario con name y cases
 * @returns {Object} - Funciones y estado para exportar el chat
 */
export const useExportChat = (messages, user) => {
  const [showExportDropdown, setShowExportDropdown] = useState(false)

  /**
   * Formatea la fecha y hora actual
   */
  const formatDatetime = () => {
    const now = new Date()
    return now.toLocaleString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    })
  }

  /**
   * Filtra mensajes válidos (excluye errores)
   */
  const getValidMessages = () => {
    return messages.filter((msg) => msg.role !== 'error')
  }

  /**
   * Valida que haya mensajes para exportar
   */
  const validateExport = () => {
    if (messages.length === 0) {
      alert('No messages to export')
      return false
    }

    const validMessages = getValidMessages()
    if (validMessages.length === 0) {
      alert('No valid messages to export')
      return false
    }

    return true
  }

  /**
   * Copia contenido al portapapeles
   */
  const copyToClipboard = async (content, format) => {
    try {
      await navigator.clipboard.writeText(content)
      alert(`✅ Chat exported as ${format} and copied to clipboard!`)
      setShowExportDropdown(false)
      return true
    } catch (err) {
      console.error('Failed to copy:', err)
      alert('❌ Failed to copy to clipboard. Please try again.')
      return false
    }
  }

  /**
   * Exporta el chat en formato Markdown
   */
  const exportAsMarkdown = () => {
    if (!validateExport()) return

    const validMessages = getValidMessages()
    const datetime = formatDatetime()

    let markdown = `# ACTS Law RAG - Chat Export\n\n`
    markdown += `**User:** ${user.name}\n`
    markdown += `**Date:** ${datetime}\n`
    markdown += `---\n\n`

    validMessages.forEach((msg, index) => {
      if (msg.role === 'user') {
        markdown += `## ${user.name}\n\n`
        markdown += `${msg.content}\n\n`
      } else if (msg.role === 'assistant') {
        markdown += `## ACTS Law Assistant\n\n`
        markdown += `${msg.content}\n\n`
      }

      if (index < validMessages.length - 1) {
        markdown += `---\n\n`
      }
    })

    copyToClipboard(markdown, 'Markdown')
  }

  /**
   * Exporta el chat en formato texto plano
   */
  const exportAsPlainText = () => {
    if (!validateExport()) return

    const validMessages = getValidMessages()
    const datetime = formatDatetime()

    let text = `ACTS LAW RAG - CHAT EXPORT\n`
    text += `${'='.repeat(60)}\n\n`
    text += `User: ${user.name}\n`
    text += `Date: ${datetime}\n`
    text += `${'='.repeat(60)}\n\n`

    validMessages.forEach((msg, index) => {
      if (msg.role === 'user') {
        text += `[${user.name}]\n`
        text += `${msg.content}\n\n`
      } else if (msg.role === 'assistant') {
        text += `[ACTS Law Assistant]\n`
        text += `${msg.content}\n\n`
      }

      if (index < validMessages.length - 1) {
        text += `${'-'.repeat(60)}\n\n`
      }
    })

    copyToClipboard(text, 'Plain Text')
  }

  /**
   * Convierte markdown básico a HTML con soporte para listas anidadas
   */
  const convertMarkdownToHTML = (text) => {
    let html = escapeHtml(text)

    // Convertir headers ANTES de procesar listas
    html = html.replace(/^### (.*$)/gim, '___H3___$1___/H3___')
    html = html.replace(/^## (.*$)/gim, '___H2___$1___/H2___')
    html = html.replace(/^# (.*$)/gim, '___H1___$1___/H1___')

    // Convertir negritas (**texto** o __texto__)
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    html = html.replace(/__(.*?)__/g, '<strong>$1</strong>')

    // Convertir cursivas (*texto* solo si no es parte de lista)
    html = html.replace(/(?<!^|\s)\*([^*\n]+?)\*(?!\s|$)/g, '<em>$1</em>')

    // Dividir en líneas para procesar listas
    const lines = html.split('\n')
    const processedLines = []
    let listStack = [] // Stack para manejar anidación

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const trimmedLine = line.trim()

      // Contar espacios de indentación
      const indentMatch = line.match(/^(\s*)/)
      const indentLevel = indentMatch
        ? Math.floor(indentMatch[1].length / 2)
        : 0

      // Detectar lista numerada (1. texto, 2. texto, etc.)
      const orderedMatch = trimmedLine.match(/^(\d+)\.\s+(.+)$/)
      if (orderedMatch) {
        handleListItem(
          processedLines,
          listStack,
          'ol',
          indentLevel,
          orderedMatch[2]
        )
        continue
      }

      // Detectar lista con viñetas (- texto o * texto)
      const unorderedMatch = trimmedLine.match(/^[-*]\s+(.+)$/)
      if (unorderedMatch) {
        handleListItem(
          processedLines,
          listStack,
          'ul',
          indentLevel,
          unorderedMatch[1]
        )
        continue
      }

      // Si no es una lista, cerrar todas las listas abiertas
      if (listStack.length > 0 && trimmedLine) {
        while (listStack.length > 0) {
          const lastList = listStack.pop()
          processedLines.push(`</${lastList}>`)
        }
      }

      // Línea normal (no agregar líneas vacías dentro de listas)
      if (trimmedLine || listStack.length === 0) {
        processedLines.push(line)
      }
    }

    // Cerrar listas si quedaron abiertas
    while (listStack.length > 0) {
      const lastList = listStack.pop()
      processedLines.push(`</${lastList}>`)
    }

    html = processedLines.join('\n')

    // Restaurar headers
    html = html.replace(/___H1___(.*?)___\/H1___/g, '<h1>$1</h1>')
    html = html.replace(/___H2___(.*?)___\/H2___/g, '<h2>$1</h2>')
    html = html.replace(/___H3___(.*?)___\/H3___/g, '<h3>$1</h3>')

    // Convertir código inline (`código`)
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>')

    // Convertir bloques de código (```código```)
    html = html.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')

    // Convertir enlaces [texto](url)
    html = html.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    )

    // Limpiar múltiples líneas vacías consecutivas
    html = html.replace(/\n{3,}/g, '\n\n')

    // Convertir saltos de línea dobles en párrafos
    html = html
      .split('\n\n')
      .map((block) => {
        const trimmed = block.trim()
        // No envolver en <p> si ya tiene tags de bloque
        if (trimmed.match(/^<(h[1-6]|ul|ol|pre|div|blockquote|li)/)) {
          return trimmed
        }
        // No envolver líneas vacías
        if (!trimmed) {
          return ''
        }
        // Si tiene saltos de línea simples, convertirlos a <br>
        return `<p>${trimmed.replace(/\n/g, '<br>')}</p>`
      })
      .filter((block) => block)
      .join('\n')

    return html
  }

  /**
   * Función auxiliar para manejar items de lista con anidación
   */
  const handleListItem = (
    processedLines,
    listStack,
    listType,
    indentLevel,
    content
  ) => {
    // Ajustar el stack al nivel de indentación actual
    while (listStack.length > indentLevel + 1) {
      const closingTag = listStack.pop()
      processedLines.push(`</${closingTag}>`)
    }

    // Si necesitamos abrir una nueva lista
    if (listStack.length === indentLevel) {
      processedLines.push(`<${listType}>`)
      listStack.push(listType)
    }

    // Si cambiamos de tipo de lista al mismo nivel
    if (listStack.length > 0 && listStack[listStack.length - 1] !== listType) {
      const oldType = listStack.pop()
      processedLines.push(`</${oldType}>`)
      processedLines.push(`<${listType}>`)
      listStack.push(listType)
    }

    // Agregar el item
    processedLines.push(`<li>${content}</li>`)
  }

  /**
   * Escapa caracteres HTML para prevenir inyección
   */
  const escapeHtml = (text) => {
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;',
    }
    return text.replace(/[&<>"']/g, (m) => map[m])
  }

  /**
   * Exporta el chat en formato HTML
   */
  const exportAsHTML = () => {
    if (!validateExport()) return

    const validMessages = getValidMessages()
    const datetime = formatDatetime()

    let html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ACTS Law RAG - Chat Export</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            max-width: 1000px;
            margin: 0 auto;
            padding: 30px 20px;
            background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
            color: #1a202c;
            line-height: 1.6;
        }
        
        .container {
            background: white;
            border-radius: 16px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.15);
            overflow: hidden;
        }
        
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 40px;
            text-align: center;
        }
        
        .header h1 {
            font-size: 32px;
            font-weight: 700;
            margin-bottom: 20px;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 12px;
        }
        
        .header-info {
            background: rgba(255, 255, 255, 0.15);
            backdrop-filter: blur(10px);
            border-radius: 12px;
            padding: 20px;
            margin-top: 20px;
            display: inline-block;
            text-align: left;
        }
        
        .header-info p {
            margin: 8px 0;
            font-size: 15px;
        }
        
        .header-info strong {
            font-weight: 600;
            margin-right: 8px;
        }
        
        .messages {
            padding: 30px;
        }
        
        .message {
            margin-bottom: 25px;
            padding: 25px;
            border-radius: 12px;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
            transition: transform 0.2s, box-shadow 0.2s;
            border-left: 5px solid;
        }
        
        .message:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
        }
        
        .message.user {
            background: linear-gradient(135deg, #e3f2fd 0%, #bbdefb 100%);
            border-left-color: #2196f3;
        }
        
        .message.assistant {
            background: linear-gradient(135deg, #f1f8e9 0%, #dcedc8 100%);
            border-left-color: #4caf50;
        }
        
        .message-header {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-bottom: 15px;
            padding-bottom: 12px;
            border-bottom: 2px solid rgba(0, 0, 0, 0.1);
        }
        
        .message-icon {
            font-size: 24px;
            line-height: 1;
        }
        
        .message-sender {
            font-weight: 700;
            font-size: 16px;
            color: #2d3748;
        }
        
        .message.user .message-sender {
            color: #1976d2;
        }
        
        .message.assistant .message-sender {
            color: #388e3c;
        }
        
        .message-content {
            color: #2d3748;
            font-size: 15px;
        }
        
        .message-content > *:first-child {
            margin-top: 0 !important;
        }
        
        .message-content > *:last-child {
            margin-bottom: 0 !important;
        }
        
        .message-content p {
            margin: 8px 0;
            line-height: 1.6;
        }
        
        .message-content h1 {
            font-size: 24px;
            font-weight: 700;
            margin: 16px 0 10px 0;
            color: #1a202c;
        }
        
        .message-content h2 {
            font-size: 20px;
            font-weight: 700;
            margin: 14px 0 8px 0;
            color: #1a202c;
        }
        
        .message-content h3 {
            font-size: 18px;
            font-weight: 600;
            margin: 12px 0 6px 0;
            color: #2d3748;
        }
        
        .message-content strong {
            font-weight: 700;
            color: #1a202c;
        }
        
        .message-content em {
            font-style: italic;
            color: #4a5568;
        }
        
        .message-content code {
            background: rgba(0, 0, 0, 0.08);
            padding: 2px 6px;
            border-radius: 4px;
            font-family: 'Monaco', 'Courier New', monospace;
            font-size: 13px;
            color: #c7254e;
        }
        
        .message-content pre {
            background: #2d3748;
            color: #e2e8f0;
            padding: 16px;
            border-radius: 8px;
            overflow-x: auto;
            margin: 12px 0;
        }
        
        .message-content pre code {
            background: none;
            color: inherit;
            padding: 0;
            font-size: 14px;
        }
        
        .message-content ul,
        .message-content ol {
            margin: 6px 0;
            padding-left: 28px;
        }
        
        .message-content ul ul,
        .message-content ol ul,
        .message-content ul ol,
        .message-content ol ol {
            margin: 4px 0;
            padding-left: 24px;
        }
        
        .message-content li {
            margin: 4px 0;
            padding-left: 6px;
            line-height: 1.5;
        }
        
        .message-content ul > li {
            list-style-type: disc;
        }
        
        .message-content ul ul > li {
            list-style-type: circle;
        }
        
        .message-content ul ul ul > li {
            list-style-type: square;
        }
        
        .message-content ol > li {
            list-style-type: decimal;
        }
        
        .message-content ol ol > li {
            list-style-type: lower-alpha;
        }
        
        .message-content ol ol ol > li {
            list-style-type: lower-roman;
        }
        
        .message-content a {
            color: #2563eb;
            text-decoration: none;
            border-bottom: 1px solid #93c5fd;
            transition: all 0.2s;
        }
        
        .message-content a:hover {
            color: #1d4ed8;
            border-bottom-color: #2563eb;
        }
        
        .message-content br {
            line-height: 1.6;
        }
        
        .footer {
            text-align: center;
            padding: 30px;
            background: linear-gradient(135deg, #f5f7fa 0%, #e9ecef 100%);
            color: #718096;
            font-size: 13px;
        }
        
        .footer p {
            margin: 6px 0;
        }
        
        .footer strong {
            color: #4a5568;
        }
        
        @media print {
            body {
                background: white;
                padding: 0;
            }
            
            .container {
                box-shadow: none;
            }
            
            .message {
                break-inside: avoid;
                box-shadow: none;
                border: 1px solid #e2e8f0;
            }
            
            .message:hover {
                transform: none;
            }
        }
        
        @media (max-width: 768px) {
            body {
                padding: 15px 10px;
            }
            
            .header {
                padding: 30px 20px;
            }
            
            .header h1 {
                font-size: 24px;
            }
            
            .messages {
                padding: 20px 15px;
            }
            
            .message {
                padding: 20px;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1><span>🤖</span> ACTS Law RAG - Chat Export</h1>
            <div class="header-info">
                <p><strong>👤 User:</strong> ${user.name}</p>
                <p><strong>📅 Date:</strong> ${datetime}</p>
            </div>
        </div>
        
        <div class="messages">`

    validMessages.forEach((msg) => {
      const messageClass = msg.role === 'user' ? 'user' : 'assistant'
      const senderName = msg.role === 'user' ? user.name : 'ACTS Law Assistant'
      const icon = msg.role === 'user' ? '👤' : '🤖'

      const htmlContent = convertMarkdownToHTML(msg.content)

      html += `
            <div class="message ${messageClass}">
                <div class="message-header">
                    <span class="message-icon">${icon}</span>
                    <span class="message-sender">${senderName}</span>
                </div>
                <div class="message-content">
                    ${htmlContent}
                </div>
            </div>`
    })

    html += `
        </div>
        
        <div class="footer">
            <p><strong>Generated by ACTS Law RAG System</strong></p>
            <p>Powered by Azure AI Foundry Agent</p>
            <p>© ${new Date().getFullYear()} ACTS Law Firm</p>
        </div>
    </div>
</body>
</html>`

    copyToClipboard(html, 'HTML')
  }

  /**
   * Verifica si hay mensajes válidos para habilitar el botón
   */
  const hasValidMessages = () => {
    return getValidMessages().length > 0
  }

  return {
    showExportDropdown,
    setShowExportDropdown,
    exportAsMarkdown,
    exportAsPlainText,
    exportAsHTML,
    hasValidMessages,
  }
}
