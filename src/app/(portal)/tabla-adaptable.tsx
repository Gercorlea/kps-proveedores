'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { enlacePagina, paginar, Paginador, POR_PAGINA_LINEA } from './paginacion'

/** Mide filas reales; también responde al zoom y a la carga de las fuentes. */
export function TablaAdaptable({ cabecera, filas, pagina, filtros, base, unidad, className }: {
  cabecera: ReactNode
  filas: ReactNode[]
  pagina?: string
  filtros: Record<string, string | undefined>
  base: string
  unidad: string
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [capacidad, setCapacidad] = useState(POR_PAGINA_LINEA)
  useEffect(() => {
    const elemento = ref.current
    if (!elemento) return
    const medir = () => {
      const tabla = elemento.querySelector('table')
      const fila = elemento.querySelector('tbody tr')
      const head = elemento.querySelector('thead')
      const pie = elemento.querySelector('.cr-pager')
      if (!tabla || !fila || !head || !pie) return
      const alto = fila.getBoundingClientRect().height
      const disponible = window.innerHeight - (tabla.getBoundingClientRect().top + window.scrollY)
        - head.getBoundingClientRect().height - Math.max(53, pie.getBoundingClientRect().height) - 32
      if (alto > 0) setCapacidad(Math.max(1, Math.floor(disponible / alto)))
    }
    const observer = new ResizeObserver(medir)
    observer.observe(elemento)
    window.addEventListener('resize', medir)
    void document.fonts.ready.then(medir)
    medir()
    return () => { observer.disconnect(); window.removeEventListener('resize', medir) }
  }, [])
  const pag = paginar(filas, pagina, capacidad)
  return (
    <div ref={ref} className="cr-tabla-adaptable">
      <table className={className}>
        {cabecera}
        <tbody>{pag.filas}</tbody>
      </table>
      <Paginador pie pagina={pag} unidad={unidad} href={(n) => enlacePagina(base, filtros, n)} />
    </div>
  )
}
