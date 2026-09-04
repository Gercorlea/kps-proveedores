'use client'

import { useRef, useState } from 'react'

/** El boton de carga de una fila. Cliente porque sube un archivo y refresca. */
export default function Subir({ folio }: { folio: string }) {
  const ref = useRef<HTMLInputElement>(null)
  const [subiendo, setSubiendo] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function subir(file: File) {
    setSubiendo(true)
    setError(null)
    try {
      const body = new FormData()
      body.append('xml', file)
      const res = await fetch(`/api/v1/invoices/${folio}/complemento`, { method: 'POST', body })
      const data = await res.json()
      if (!res.ok) {
        setError(data.detail ?? 'No se pudo cargar el complemento.')
        return
      }
      // Recarga del servidor: la fila desaparece de la lista porque la factura
      // pasa a CERRADA, y el estado local no puede saberlo por su cuenta.
      window.location.reload()
    } catch {
      setError('No se pudo contactar al servidor.')
    } finally {
      setSubiendo(false)
    }
  }

  return (
    <>
      <button
        type="button"
        className="cr-btn"
        data-variant="secondary"
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
      {error && (
        <div className="cr-small cr-mt-2" data-tone="danger">
          {error}
        </div>
      )}
    </>
  )
}
