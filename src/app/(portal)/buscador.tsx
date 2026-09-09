'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Aspa, Lupa } from './iconos'

/**
 * Buscador de los listados del portal. FILTRA AL ESCRIBIR.
 *
 * UNA SOLA IMPLEMENTACION, como la paginacion. Nacio en /ordenes y estaba
 * clavado a esa ruta y a sus dos filtros; /facturas necesitaba lo mismo, asi
 * que en vez de un segundo buscador con las mismas trampas resueltas otra vez
 * —el rebote, la carrera contra la respuesta— la ruta y los filtros pasaron a
 * ser parametros. Dos pantallas que escriben su propia version de lo mismo
 * acaban comportandose distinto (§12).
 *
 * Antes de esto era un `<form method="get">` puro, que es lo correcto para un
 * Server Component: cero JavaScript y el enlace se comparte. El problema es que
 * nadie lo enviaba. Con la caja delante y las 187 ordenes debajo sin moverse,
 * teclear "oc 5" y ver la lista intacta se lee como que el buscador no sirve,
 * no como que falta pulsar Enter.
 *
 * El filtro sigue viviendo en la URL: esto no guarda estado propio, empuja `?q=`
 * y deja que la pantalla se vuelva a pintar en el servidor. Asi se sigue
 * pudiendo compartir el enlace, recargar y volver atras.
 *
 * EL COSTE. En /ordenes cada busqueda asentada es una lectura a B1, igual que
 * pulsar un chip. Por eso hay 350 ms de espera: mientras se teclea no se pide
 * nada, y una palabra entera cuesta una sola consulta, no una por letra.
 */
export function Buscador({
  base,
  termino,
  filtros,
  placeholder,
  etiqueta,
}: {
  /** Ruta del listado: "/ordenes", "/facturas". */
  base: string
  termino: string
  /**
   * Los filtros que NO son la busqueda y hay que conservar al escribir. Los
   * vacios y los `undefined` no se escriben, para que la URL limpia de un
   * listado sea siempre la misma.
   */
  filtros?: Record<string, string | undefined>
  placeholder: string
  /**
   * Que se busca. Va en la etiqueta del campo, que se oculta a la vista pero la
   * leen los lectores de pantalla.
   */
  etiqueta: string
}) {
  const router = useRouter()
  const [valor, setValor] = useState(termino)
  const [pendiente, iniciar] = useTransition()

  /**
   * Lo ultimo que este componente mando a la URL.
   *
   * Sin esto, la respuesta de una busqueda a medio teclear pisa lo que se lleva
   * escrito: se manda "oc", llega la navegacion con `termino = "oc"` cuando ya
   * hay "oc 5" en la caja, y el sincronizado lo devuelve a "oc". Con el registro
   * solo se acepta un `termino` que NO venga de nosotros: el boton de atras, o
   * un enlace compartido.
   */
  const propio = useRef(termino)

  useEffect(() => {
    if (termino === propio.current) return
    propio.current = termino
    setValor(termino)
  }, [termino])

  /**
   * Los filtros se leen por su contenido y no por identidad de objeto: quien
   * llama escribe `filtros={{ f: chip }}` en el JSX, que es un objeto NUEVO en
   * cada pintada. Como dependencia de efecto dispararia el rebote en cada
   * render, y la busqueda se mandaria sola.
   */
  const claveFiltros = JSON.stringify(filtros ?? {})

  function ir(q: string) {
    propio.current = q
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(filtros ?? {})) {
      if (v !== undefined && v !== '') params.set(k, v)
    }
    if (q) params.set('q', q)
    const qs = params.toString()
    // Sin `p`: un termino nuevo empieza en la pagina 1. Sin `sel`: lo que
    // estuviera abierto puede no estar entre lo que queda, y una ficha de algo
    // que ya no aparece en la lista no se entiende.
    iniciar(() => router.replace(qs ? `${base}?${qs}` : base, { scroll: false }))
  }

  // Espera a que pare de teclear. El `return` cancela el temporizador de la
  // pulsacion anterior, que es lo que hace que solo cuente la ultima.
  useEffect(() => {
    if (valor === propio.current) return
    const t = setTimeout(() => ir(valor), 350)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valor, base, claveFiltros])

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
      {/* La etiqueta va oculta a la vista: encima de la caja hacia el bloque mas
          alto que los chips y descuadraba la fila. El marcador de posicion no la
          sustituye —desaparece al escribir—, asi que se dice aqui. */}
      <label className="cr-sr-only" htmlFor="q">
        {etiqueta}
      </label>
      <div className="cr-search" data-pendiente={pendiente ? 'true' : undefined}>
        <input
          id="q"
          name="q"
          type="text"
          className="cr-search__input"
          value={valor}
          onChange={(e) => setValor(e.target.value)}
          placeholder={placeholder}
          autoComplete="off"
        />
        {/* Limpiar va DENTRO de la caja y como aspa: fuera y con texto, aparecer
            y desaparecer cambiaba el ancho del bloque y movia los chips de
            sitio. */}
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
        {/* Se queda aunque ya no haga falta pulsarlo: es lo que dice que la caja
            es un buscador, y Enter sigue funcionando. */}
        <button type="submit" className="cr-search__accion" aria-label="Buscar">
          <Lupa />
        </button>
      </div>
    </form>
  )
}
