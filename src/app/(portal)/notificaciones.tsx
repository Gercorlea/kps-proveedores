'use client'

import { mostrarToast } from '@/app/(portal)/toast'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Campana de avisos de la topbar.
 *
 * NOTA. El documento de diseno (ARC-DS-2026-PP-001 §03) dice que la topbar no
 * lleva campana de notificaciones. Esta aqui por peticion explicita de KPS, que
 * manda sobre el documento; queda anotado para que quien lo lea despues no crea
 * que se colo por descuido.
 *
 * Solo avisa de lo que decide KPS sobre las facturas del proveedor —aprobada,
 * devuelta, rechazada, pagada—, nunca de lo que hace el propio proveedor.
 *
 * EL "LEIDO" VIVE EN LA BASE, por usuario. Guardarlo en el navegador sale mas
 * barato, pero hace que lo ya leido en la oficina vuelva a salir como nuevo
 * desde casa, y con avisos que piden accion —una factura devuelta— eso no es un
 * detalle cosmetico.
 */

interface Aviso {
  id: string
  folio: string
  titulo: string
  mensaje: string
  tono: 'ok' | 'warn' | 'danger' | 'ai' | null
  link: string | null
  facturaFolio: string | null
  ordenCompra: string | null
  leido: boolean
  cuando: string
}

/** Cada cuanto se vuelve a preguntar. Igual que el dashboard de planta. */
const SONDEO_MS = 30_000

function cuandoTexto(iso: string): string {
  const d = new Date(iso)
  const min = Math.floor((Date.now() - d.getTime()) / 60000)
  if (min < 1) return 'ahora'
  if (min < 60) return `hace ${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return `hace ${h} h`
  const dias = Math.floor(h / 24)
  if (dias < 30) return `hace ${dias} d`
  return d.toLocaleDateString('es-MX')
}

/**
 * El estado inicial lo calcula el servidor y llega por props. Pidiendolo desde
 * el navegador al montar, la campana se pinta un instante sin contador y luego
 * da un salto: con avisos que piden accion, ese parpadeo es justo el que hace
 * que no se lean.
 */
export default function Notificaciones({
  inicial,
}: {
  inicial: { avisos: Aviso[]; noLeidos: number }
}) {
  const router = useRouter()
  const [avisos, setAvisos] = useState<Aviso[]>(inicial.avisos)
  const [noLeidos, setNoLeidos] = useState(inicial.noLeidos)
  const [abierto, setAbierto] = useState(false)
  const caja = useRef<HTMLDivElement>(null)

  const cargar = useCallback(async () => {
    try {
      const r = await fetch('/api/v1/notificaciones', { cache: 'no-store' })
      if (!r.ok) return
      const d = (await r.json()) as { avisos?: Aviso[]; noLeidos?: number }
      setAvisos(d.avisos ?? [])
      setNoLeidos(d.noLeidos ?? 0)
    } catch {
      // Una campana rota no puede tumbar la barra de navegacion: se queda con lo
      // que tuviera y lo reintenta en el siguiente sondeo.
    }
  }, [])

  // Solo el sondeo: la primera lectura ya vino del servidor. Es tambien la
  // llamada que materializa los avisos nuevos, y por eso al abrir el panel se
  // vuelve a pedir aunque el reloj no haya dado la vuelta.
  useEffect(() => {
    const t = setInterval(() => void cargar(), SONDEO_MS)
    return () => clearInterval(t)
  }, [cargar])

  // Cerrar al pulsar fuera: sin esto el panel se queda abierto tapando la
  // pantalla hasta que se vuelve a pulsar la campana.
  useEffect(() => {
    if (!abierto) return
    function fuera(e: MouseEvent) {
      if (caja.current && !caja.current.contains(e.target as Node)) setAbierto(false)
    }
    document.addEventListener('mousedown', fuera)
    return () => document.removeEventListener('mousedown', fuera)
  }, [abierto])

  async function marcar(cuerpo: { id?: string; todos?: boolean }) {
    // Se pinta antes de que conteste el servidor: el aviso ya lo esta leyendo.
    // Si la escritura falla, el siguiente sondeo lo devuelve a no leido.
    if (cuerpo.todos) {
      setAvisos((prev) => prev.map((a) => ({ ...a, leido: true })))
      setNoLeidos(0)
    } else if (cuerpo.id) {
      setAvisos((prev) => prev.map((a) => (a.id === cuerpo.id ? { ...a, leido: true } : a)))
      setNoLeidos((n) => Math.max(0, n - 1))
    }
    try {
      const respuesta = await fetch('/api/v1/notificaciones', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cuerpo),
      })
      if (!respuesta.ok) throw new Error('No se pudieron actualizar los avisos')
      if (cuerpo.todos) mostrarToast('Avisos marcados como leidos', 'success')
    } catch {
      mostrarToast('No se pudieron actualizar los avisos', 'error')
      void cargar()
    }
  }

  function alPulsar(a: Aviso) {
    if (!a.leido) void marcar({ id: a.id })
    if (a.link) {
      setAbierto(false)
      router.push(a.link)
    }
  }

  return (
    <div className="nt-caja" ref={caja}>
      <button
        type="button"
        className="nt-boton"
        onClick={() => {
          const siguiente = !abierto
          setAbierto(siguiente)
          if (siguiente) void cargar()
        }}
        aria-expanded={abierto}
        aria-label={noLeidos > 0 ? `Avisos, ${noLeidos} sin leer` : 'Avisos'}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none">
          <path
            d="M8 1.5a4 4 0 0 0-4 4v2.6L2.8 10.4h10.4L12 8.1V5.5a4 4 0 0 0-4-4Z"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          <path d="M6.4 12.2a1.7 1.7 0 0 0 3.2 0" stroke="currentColor" strokeWidth="1.2" />
        </svg>
        {noLeidos > 0 && <span className="nt-punto">{noLeidos > 9 ? '9+' : noLeidos}</span>}
      </button>

      {abierto && (
        <div className="nt-panel" role="dialog" aria-label="Avisos">
          <div className="nt-panel__head">
            <span className="cr-label cr-flush">
              Avisos
            </span>
            {noLeidos > 0 && (
              <button
                type="button"
                className="nt-marcar"
                onClick={() => void marcar({ todos: true })}
              >
                Marcar todas como leidas
              </button>
            )}
          </div>

          {avisos.length === 0 ? (
            <p className="nt-vacio">Sin avisos.</p>
          ) : (
            <ul className="nt-lista">
              {avisos.map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    className="nt-item"
                    data-nuevo={a.leido ? undefined : 'si'}
                    onClick={() => alPulsar(a)}
                  >
                    <span className="nt-item__cabeza">
                      <span className="cr-status" data-tone={a.tono ?? undefined}>
                        {a.titulo}
                      </span>
                      <span className="cr-small cr-muted">{cuandoTexto(a.cuando)}</span>
                    </span>
                    <span className="nt-item__texto">{a.mensaje}</span>
                    {a.facturaFolio && (
                      <span className="cr-small cr-muted">
                        <span className="cr-mono">{a.facturaFolio}</span>
                        {a.ordenCompra ? ` · OC ${a.ordenCompra}` : ''}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <a href="/notificaciones" className="nt-todas cr-small">
            Ver todos los avisos
          </a>
        </div>
      )}

      <style>{`
        .nt-caja { position: relative; display: flex; align-items: center; }
        /* Caja con borde, no icono suelto: en una barra de cromo claro un
           glifo sin marco no se lee como algo pulsable. */
        .nt-boton {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 32px;
          height: 32px;
          border: 1px solid var(--cr-line-2);
          border-radius: var(--cr-r-xs);
          background: var(--cr-bg);
          color: var(--cr-ink-2);
          cursor: pointer;
          position: relative;
          transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
        }
        .nt-boton:hover { background: var(--cr-surface-2); color: var(--cr-ink); }
        .nt-boton:focus-visible { outline: none; box-shadow: var(--cr-ring); }
        /* El contador se monta en la esquina, mordiendo el borde: dentro de la
           caja competiria con el icono y a 9px no se leeria. El aro del color
           de la barra lo despega del borde que pisa. */
        .nt-punto {
          position: absolute;
          top: -6px;
          right: -6px;
          min-width: 16px;
          height: 16px;
          padding: 0 4px;
          border-radius: 8px;
          background: var(--cr-danger);
          color: var(--cr-on-accent);
          font-family: var(--cr-mono);
          font-size: 9.5px;
          font-weight: 500;
          line-height: 16px;
          text-align: center;
          box-shadow: 0 0 0 2px var(--cr-bg);
        }
        .nt-panel {
          position: absolute;
          top: calc(100% + var(--cr-s2));
          right: 0;
          width: 340px;
          max-height: 420px;
          overflow-y: auto;
          background: var(--cr-bg);
          border: 1px solid var(--cr-line-2);
          border-radius: var(--cr-r-sm);
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.1);
          z-index: 40;
        }
        .nt-panel__head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--cr-s2);
          padding: var(--cr-s3) var(--cr-s4);
          border-bottom: 1px solid var(--cr-line);
        }
        .nt-marcar {
          border: 0;
          background: transparent;
          padding: 0;
          font-size: 11.5px;
          color: var(--cr-ink-3);
          cursor: pointer;
        }
        .nt-marcar:hover { color: var(--cr-ink); text-decoration: underline; }
        /* 12px es el tamano de .cr-small del sistema: el panel no es sitio para
           texto de cuerpo. */
        .nt-vacio { padding: var(--cr-s4); color: var(--cr-ink-3); font-size: 12px; }
        .nt-lista { list-style: none; margin: 0; padding: 0; }
        .nt-item {
          display: flex;
          flex-direction: column;
          gap: var(--cr-s1);
          width: 100%;
          padding: var(--cr-s3) var(--cr-s4);
          border: 0;
          border-bottom: 1px solid var(--cr-line);
          background: transparent;
          text-align: left;
          cursor: pointer;
        }
        .nt-item:hover { background: var(--cr-surface-2); }
        /* El no leido se marca con una barra a la izquierda y no con el fondo:
           el fondo ya lo usa el hover y los dos juntos se confunden. */
        .nt-item[data-nuevo='si'] { box-shadow: inset 2px 0 0 var(--cr-accent); }
        .nt-item__cabeza {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--cr-s2);
        }
        .nt-item__texto { font-size: 12px; color: var(--cr-ink-2); }
        .nt-todas {
          display: block;
          padding: var(--cr-s3) var(--cr-s4);
          text-align: center;
          color: var(--cr-ink-2);
        }
      `}</style>
    </div>
  )
}
