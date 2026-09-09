'use client'

import { useRouter } from 'next/navigation'
import { mostrarToast } from '../toast'

import { useRef, useState } from 'react'

/** El boton de carga de una fila. Cliente porque sube un archivo y refresca. */
export default function Subir({ folio }: { folio: string }) {
  const ref = useRef<HTMLInputElement>(null)
  const [subiendo, setSubiendo] = useState(false)
  const router = useRouter()

  async function subir(file: File) {
    setSubiendo(true)

    try {
      const body = new FormData()
      body.append('xml', file)
      const res = await fetch(`/api/v1/invoices/${folio}/complemento`, { method: 'POST', body })
      const data = await res.json()
      if (!res.ok) {
        mostrarToast('No se pudo cargar el complemento', 'error', data.detail ?? 'Intenta nuevamente.')
        return
      }
      // Recarga del servidor: la fila desaparece de la lista porque la factura
      // pasa a CERRADA, y el estado local no puede saberlo por su cuenta.
      mostrarToast('Complemento cargado correctamente.', 'success')
      router.refresh()
    } catch {
      mostrarToast('No se pudo cargar el complemento', 'error', 'No se pudo contactar al servidor.')
    } finally {
      setSubiendo(false)
      if (ref.current) ref.current.value = ''
    }
  }

  return (
    <>
      <button
        type="button"
        className="cr-btn cr-btn--primary cr-btn--sm"
        disabled={subiendo}
        onClick={() => ref.current?.click()}
      >
        {subiendo ? 'Subiendo...' : 'Subir XML'}
      </button>
      <input
        ref={ref}
        type="file"
        accept=".xml,text/xml,application/xml"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void subir(f)
        }}
      />

    </>
  )
}
