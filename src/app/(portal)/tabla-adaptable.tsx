'use client'

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { enlacePagina, paginar, Paginador, POR_PAGINA_LINEA } from './paginacion'

/** Mide filas reales; también responde al zoom y a la carga de las fuentes. */
export function TablaAdaptable({ cabecera, filas, pagina, filtros, base, unidad, className, clavePagina = 'p', reservaInferior = 0, expandible = false }: {
  cabecera: ReactNode
  filas: ReactNode[]
  pagina?: string
  filtros: Record<string, string | undefined>
  base: string
  unidad: string
  className?: string
  clavePagina?: string
  reservaInferior?: number
  /** Excepción autorizada para los documentos del detalle lateral de Órdenes. */
  expandible?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [capacidad, setCapacidad] = useState(POR_PAGINA_LINEA)
  const [expandida, setExpandida] = useState(false)
  const [altoTabla, setAltoTabla] = useState(200)
  const contenidoId = useId()
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
        - head.getBoundingClientRect().height - Math.max(53, pie.getBoundingClientRect().height) - 32 - reservaInferior
      if (alto > 0) {
        const cantidad = Math.max(1, Math.floor(disponible / alto))
        setCapacidad(cantidad)
        setAltoTabla(head.getBoundingClientRect().height + cantidad * alto)
      }
    }
    const observer = new ResizeObserver(medir)
    observer.observe(elemento)
    window.addEventListener('resize', medir)
    void document.fonts.ready.then(medir)
    medir()
    return () => { observer.disconnect(); window.removeEventListener('resize', medir) }
  }, [reservaInferior])
  const pag = paginar(filas, expandible ? '1' : pagina, capacidad)
  const tabla = (
    <table className={className}>
      {cabecera}
      <tbody>{expandible && expandida ? filas : pag.filas}</tbody>
    </table>
  )
  return (
    <div ref={ref} className="cr-tabla-adaptable">
      {expandible ? (
        <>
          <div id={contenidoId} className="cr-tabla-expandible" data-expandida={expandida ? 'true' : undefined}
            style={expandida ? { maxHeight: altoTabla } : undefined}
            tabIndex={expandida ? 0 : undefined} role={expandida ? 'region' : undefined}
            aria-label={expandida ? `Lista completa de ${unidad}` : undefined}>
            {tabla}
          </div>
          <div className="cr-pager cr-pager--pie">
            <span>{expandida ? `${filas.length} ${unidad}` : `Mostrando 1 - ${pag.hasta} de ${filas.length} ${unidad}`}</span>
            {filas.length > capacidad && (
              <button type="button" className="cr-tabla-expandible__toggle" aria-expanded={expandida}
                aria-controls={contenidoId} onClick={() => setExpandida(!expandida)}>
                {expandida ? 'Mostrar menos' : 'Mostrar todos'}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
                  <path d={expandida ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'} />
                </svg>
              </button>
            )}
          </div>
        </>
      ) : <>{tabla}<Paginador pie pagina={pag} unidad={unidad} href={(n) => enlacePagina(base, filtros, n, clavePagina)} /></>}
    </div>
  )
}
