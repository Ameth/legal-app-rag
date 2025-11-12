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
    hasValidMessages,
  }
}