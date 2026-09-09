'use client'

import { mostrarToast } from '@/app/(portal)/toast'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

/**
 * Boton de "marcar todas como leidas" de la pagina de avisos.
 *
 * Vive aparte porque la pagina es de servidor —lee la base directamente— y esto
 * necesita un manejador de eventos. Al terminar refresca el arbol de servidor en
 * vez de recargar la ventana: la lista se vuelve a pintar sin perder el sitio.
 */
export default function MarcarTodas() {
  const router = useRouter()
  const [enviando, setEnviando] = useState(false)

  async function marcar() {
    setEnviando(true)
    try {
      const respuesta = await fetch('/api/v1/notificaciones', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ todos: true }),
      })
      if (!respuesta.ok) throw new Error('No se pudieron actualizar los avisos')
      mostrarToast('Avisos marcados como leídos', 'success')
      router.refresh()
    } catch {
      mostrarToast('No se pudieron actualizar los avisos', 'error')
      // Sin red no hay nada que hacer aqui: el aviso sigue sin leer, que es el
      // estado seguro. Se devuelve el boton para poder reintentar.
    } finally {
      setEnviando(false)
    }
  }

  return (
    <button type="button" className="cr-btn" onClick={() => void marcar()} disabled={enviando}>
      {enviando ? 'Marcando…' : 'Marcar todas como leidas'}
    </button>
  )
}
