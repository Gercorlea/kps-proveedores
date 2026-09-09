'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'

export default function ModalOrden({ children }: { children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const router = useRouter()

  useEffect(() => {
    const element = dialog.current
    const trigger = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    element?.showModal()
    document.body.style.overflow = 'hidden'
    return () => {
      element?.close()
      document.body.style.overflow = overflow
      trigger?.focus()
    }
  }, [])

  function cerrar() {
    dialog.current?.close()
    router.back()
  }

  return (
    <dialog ref={dialog} className="cr-orden-modal" aria-labelledby="orden-modal-titulo"
      onCancel={(event) => { event.preventDefault(); cerrar() }}
      onClick={(event) => { if (event.target === event.currentTarget) cerrar() }}>
      <div className="cr-orden-modal__interior">
        <header className="cr-orden-modal__head">
          <h2 id="orden-modal-titulo">Orden completa</h2>
          <button type="button" className="cr-btn cr-btn--secondary cr-btn--sm" onClick={cerrar} autoFocus>Cerrar</button>
        </header>
        <div className="cr-orden-modal__contenido">{children}</div>
      </div>
    </dialog>
  )
}
