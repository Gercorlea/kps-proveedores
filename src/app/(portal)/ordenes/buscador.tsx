'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Aspa, Lupa } from '../iconos'

/**
 * Buscador de la lista de ordenes. FILTRA AL ESCRIBIR.
 *
 * Antes era un `<form method="get">` puro, que es lo correcto para un Server
 * Component: cero JavaScript y el enlace se comparte. El problema es que nadie
 * lo enviaba. Con la caja delante y las 187 ordenes debajo sin moverse, teclear
 * "oc 5" y ver la lista intacta se lee como que el buscador no sirve, no como
 * que falta pulsar Enter.
 *
 * El filtro sigue viviendo en la URL: esto no guarda estado propio, empuja
 * `?q=` y deja que la pantalla se vuelva a pintar en el servidor. Asi se sigue
 * pudiendo compartir el enlace, recargar y volver atras.
 *
 * EL COSTE. Cada busqueda asentada es una lectura a B1, igual que pulsar un
 * chip o cambiar de pestaña. Por eso hay 350 ms de espera: mientras se teclea
 * no se pide nada, y una palabra entera cuesta una sola consulta, no una por
 * letra.
 */
export function Buscador({
  termino,
  tab,
  chip,
}: {
  termino: string
  /** La pestaña actual, o `undefined` si es la de por defecto. */
  tab?: string
  /** El chip actual, o `undefined` si es "todas". */
  chip?: string
}) {
  const router = useRouter()
  const [valor, setValor] = useState(termino)
  const [pendiente, iniciar] = useTransition()

  /**
   * Lo ultimo que este componente mando a la URL.
   *
   * Sin esto, la respuesta de una busqueda a medio teclear pisa lo que se
   * lleva escrito: se manda "oc", llega la navegacion con `termino = "oc"`
   * cuando ya hay "oc 5" en la caja, y el sincronizado lo devuelve a "oc". Con
   * el registro solo se acepta un `termino` que NO venga de nosotros: el boton
   * de atras, o un enlace compartido.
   */
  const propio = useRef(termino)

  useEffect(() => {
    if (termino === propio.current) return
    propio.current = termino
    setValor(termino)
  }, [termino])

  function ir(q: string) {
    propio.current = q
    const params = new URLSearchParams()
    if (tab) params.set('tab', tab)
    if (chip) params.set('f', chip)
    if (q) params.set('q', q)
    const qs = params.toString()
    // Sin `p`: un termino nuevo empieza en la pagina 1. Sin `sel`: la orden
    // abierta puede no estar entre las que quedan, y una ficha de algo que ya
    // no aparece en la lista no se entiende.
    iniciar(() => router.replace(qs ? `/ordenes?${qs}` : '/ordenes', { scroll: false }))
  }

  // Espera a que pare de teclear. El `return` cancela el temporizador de la
  // pulsacion anterior, que es lo que hace que solo cuente la ultima.
  useEffect(() => {
    if (valor === propio.current) return
    const t = setTimeout(() => ir(valor), 350)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valor])

  return (
    <form
      role="search"
      className="cr-filtros__buscar"
      // Enter no espera los 350 ms: quien lo pulsa ya termino de escribir.
      onSubmit={(e) => {
        e.preventDefault()
        ir(valor)
      }}
    >
      {/* La etiqueta va oculta a la vista: encima de la caja hacia el bloque
          mas alto que los chips y descuadraba la fila. El marcador de posicion
          no la sustituye —desaparece al escribir—, asi que se dice aqui. */}
      <label className="cr-sr-only" htmlFor="q">
        Buscar por numero de orden, de entrada o folio de factura
      </label>
      <div className="cr-search" data-pendiente={pendiente ? 'true' : undefined}>
        <input
          id="q"
          name="q"
          type="text"
          className="cr-search__input"
          value={valor}
          onChange={(e) => setValor(e.target.value)}
          placeholder="Orden, entrada o folio"
          autoComplete="off"
        />
        {/* Limpiar va DENTRO de la caja y como aspa: fuera y con texto,
            aparecer y desaparecer cambiaba el ancho del bloque y movia los
            chips de sitio. */}
        {valor !== '' && (
          <button
            type="button"
            className="cr-search__accion"
            aria-label="Limpiar la busqueda"
            title="Limpiar"
            onClick={() => {
              setValor('')
              ir('')
            }}
          >
            <Aspa />
          </button>
        )}
        {/* Se queda aunque ya no haga falta pulsarlo: es lo que dice que la
            caja es un buscador, y Enter sigue funcionando. */}
        <button type="submit" className="cr-search__accion" aria-label="Buscar">
          <Lupa />
        </button>
      </div>
    </form>
  )
}
