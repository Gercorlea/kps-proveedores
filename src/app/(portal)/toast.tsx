'use client'

import { useCallback, useEffect, useState } from 'react'

type Aviso = { mensaje: string; detalle?: string; tono: 'error' | 'success' | 'info'; id: number }
const evento = 'cronos:toast'
const DURACION = 3500
const SALIDA = 180
let siguienteId = 0

export function mostrarToast(mensaje: string, tono: Aviso['tono'] = 'info', detalle?: string) {
  window.dispatchEvent(new CustomEvent(evento, { detail: { mensaje, detalle, tono, id: siguienteId++ } }))
}

export function AvisoToast({ mensaje, titulo = 'No se pudo completar la acción', tono = 'error' }: { mensaje: string; titulo?: string; tono?: Aviso['tono'] }) {
  useEffect(() => { mostrarToast(titulo, tono, mensaje) }, [mensaje, titulo, tono])
  return null
}

export default function Toast() {
  const [avisos, setAvisos] = useState<Aviso[]>([])
  useEffect(() => {
    const recibir = (event: Event) => setAvisos((actuales) => [...actuales, (event as CustomEvent<Aviso>).detail])
    window.addEventListener(evento, recibir)
    return () => window.removeEventListener(evento, recibir)
  }, [])
  const quitar = useCallback((id: number) => setAvisos((actuales) => actuales.filter((a) => a.id !== id)), [])
  return <div className="cr-toast-zona" aria-live="polite" aria-atomic="false">
    {avisos.map((aviso) => <Mensaje key={aviso.id} aviso={aviso} quitar={quitar} />)}
  </div>
}

function Mensaje({ aviso, quitar }: { aviso: Aviso; quitar: (id: number) => void }) {
  const [saliendo, setSaliendo] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setSaliendo(true), DURACION)
    return () => clearTimeout(timer)
  }, [])
  useEffect(() => {
    if (!saliendo) return
    const timer = setTimeout(() => quitar(aviso.id), SALIDA)
    return () => clearTimeout(timer)
  }, [saliendo, aviso.id, quitar])
  const tono = aviso.tono === 'error' ? 'danger' : aviso.tono === 'info' ? 'warn' : 'ok'
  return <div className={`cr-toast cr-toast--${tono}${saliendo ? ' cr-toast--saliendo' : ''}`} role={tono === 'danger' ? 'alert' : 'status'}>
    <div className="cr-toast__cuerpo">
      <p className="cr-toast__titulo">{aviso.mensaje}</p>
      {aviso.detalle && <p className="cr-toast__detalle">{aviso.detalle}</p>}
    </div>
    <button type="button" className="cr-toast__cerrar" aria-label="Cerrar aviso" onClick={() => setSaliendo(true)}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true"><path d="m18 6-12 12M6 6l12 12" /></svg>
    </button>
    <span className="cr-toast__barra" style={{ animationDuration: `${DURACION}ms` }} aria-hidden="true" />
  </div>
}
