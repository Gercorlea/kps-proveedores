import Link from 'next/link'

/**
 * Paginacion de los listados del portal.
 *
 * UNA SOLA IMPLEMENTACION para todas las pantallas. Antes cada listado resolvia
 * lo suyo: /ordenes tenia paginas de verdad y el resto solo pintaba un contador
 * —"9 documentos"— que parecia un pie de tabla pero no llevaba a ningun sitio.
 * Con la logica repartida, cambiar el tamano de pagina obligaba a tocar seis
 * ficheros y a acordarse de los seis.
 *
 * LA PAGINA VIAJA EN LA URL, no en un estado del cliente: las pantallas son
 * Server Components, asi que sin esto habria que convertirlas a cliente solo
 * para pasar de pagina. Ademas el enlace se puede compartir y recargar.
 *
 * Se corta en memoria y no en la consulta a proposito: los listados ya llegan
 * acotados por su propio limite —MAX_ORDENES y compania—, asi que aqui no hay
 * nada que ahorrar y si un salto de pagina que costaria una ida a SAP.
 */

/**
 * Filas por pagina por defecto. Cambiarlo aqui lo cambia en todo el portal.
 *
 * Cinco es el tamano de los listados de FILAS ALTAS —/ordenes y /entradas
 * apilan dos renglones por celda—, no un maximo. Un listado de filas de una
 * sola linea cabe muy por encima de eso, y dejarlo en cinco desperdicia
 * pantalla y obliga a paginar lo que se veia de un vistazo: por eso `paginar`
 * acepta su propio tamano.
 */
export const POR_PAGINA = 5

/**
 * Filas de UNA LINEA que caben sin que el pie de la tabla se salga de un 1080p.
 *
 * Es la regla de bulto de la spec (§07: una linea → ~18) y no una medida del
 * alto real disponible. La spec pide medir con un hook y recalcular en
 * `resize`; aqui no se hace porque estas pantallas son Server Components y
 * convertir la tabla a cliente solo para contar pixeles costaria mas de lo que
 * arregla. Si algun dia el pie queda bajo el pliegue en una pantalla concreta,
 * ESTE es el numero que se toca.
 */
export const POR_PAGINA_LINEA = 18

/**
 * Los numeros de la pagina, sin las filas.
 *
 * La barra solo pinta cuentas, asi que se tipa contra esto y no contra
 * `Pagina<T>`: una pantalla que elige entre dos listados de tipos distintos
 * —/ordenes, con sus dos pestanas— le pasaria una union que no encaja en
 * ningun `T` concreto. Con la metadata suelta, las dos valen.
 */
export interface PaginaMeta {
  /** Pagina actual, ya acotada al rango valido. */
  numero: number
  totalPaginas: number
  /** Indice de la primera fila visible, en base 1. Para "6-10 de 37". */
  desde: number
  /** Indice de la ultima fila visible, en base 1. */
  hasta: number
  total: number
}

export interface Pagina<T> extends PaginaMeta {
  /** Las filas que se pintan. */
  filas: T[]
}

/**
 * Corta un listado en la pagina pedida.
 *
 * `solicitada` viene de la URL, asi que NO se confia en ella: puede ser texto,
 * un negativo o un numero mayor que el total. Se acota al rango valido en vez
 * de fallar —una URL vieja, despues de que KPS cierre documentos, no deberia
 * dar una pantalla en blanco sino la ultima pagina que si existe—.
 */
export function paginar<T>(
  filas: readonly T[],
  solicitada: string | undefined,
  porPagina: number = POR_PAGINA,
): Pagina<T> {
  const total = filas.length
  // Un tamano de cero o negativo dejaria `totalPaginas` en infinito y la pagina
  // en blanco. Se acota antes de dividir.
  const tamano = Math.max(1, Math.trunc(porPagina))
  const totalPaginas = Math.max(1, Math.ceil(total / tamano))
  const pedida = Number.parseInt(solicitada ?? '1', 10)
  const numero = Math.min(Math.max(Number.isFinite(pedida) ? pedida : 1, 1), totalPaginas)
  const inicio = (numero - 1) * tamano
  const visibles = filas.slice(inicio, inicio + tamano)
  return {
    numero,
    totalPaginas,
    filas: visibles,
    desde: total === 0 ? 0 : inicio + 1,
    hasta: inicio + visibles.length,
    total,
  }
}

/**
 * Arma el enlace de una pagina conservando los filtros que ya haya en la URL.
 *
 * La pagina 1 se escribe SIN el parametro: asi la URL "limpia" de un listado es
 * siempre la misma y no aparecen dos direcciones distintas para la misma vista.
 */
export function enlacePagina(
  base: string,
  filtros: Record<string, string | undefined>,
  numero: number,
  clave = 'p',
): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(filtros)) {
    if (v !== undefined && v !== '') params.set(k, v)
  }
  if (numero > 1) params.set(clave, String(numero))
  const cadena = params.toString()
  return cadena === '' ? base : `${base}?${cadena}`
}

interface Props {
  pagina: PaginaMeta
  /** Construye el enlace de una pagina conservando los demas filtros. */
  href: (numero: number) => string
  /** Como se llaman las filas. "documentos", "ordenes", "avisos"... */
  unidad?: string
  /** Texto extra, a continuacion del conteo. */
  nota?: string
  /**
   * Pie DEL PANEL en vez de bloque suelto: se pega al borde inferior, con su
   * hairline y su franja. La clase va en el propio `.cr-pager` y no en un div
   * que lo envuelva, porque envolverlo dejaba dos paddings, uno dentro de otro.
   */
  pie?: boolean
}

/**
 * La barra de paginacion.
 *
 * Con una sola página se mantienen el conteo y las flechas deshabilitadas,
 * para conservar la misma composición y altura del pie.
 */
function FlechaPagina({ anterior = false }: { anterior?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={anterior ? 'm15 18-6-6 6-6' : 'm9 18 6-6-6-6'} />
    </svg>
  )
}

export function Paginador({ pagina, href, unidad = 'documentos', nota, pie }: Props) {
  const { numero, totalPaginas, desde, hasta, total } = pagina

  return (
    <div className={pie ? 'cr-pager cr-pager--pie' : 'cr-pager'}>
      <span>
        {total === 0
          ? `Sin ${unidad}`
          : `Mostrando ${desde} - ${hasta} de ${total} ${unidad}`}
        {nota !== undefined && ` · ${nota}`}
      </span>

      {total > 0 && (
        <nav className="cr-pager__nav" aria-label={`Paginación de ${unidad}`}>
          {numero > 1 ? (
            <Link className="cr-pager__arrow" aria-label="Página anterior" title="Página anterior" href={href(numero - 1)} scroll={false}>
              <FlechaPagina anterior />
            </Link>
          ) : (
            <button type="button" className="cr-pager__arrow" aria-label="Página anterior" disabled>
              <FlechaPagina anterior />
            </button>
          )}
          <span className="cr-pager__page" aria-current="page">
            Página {numero} de {totalPaginas}
          </span>
          {numero < totalPaginas ? (
            <Link className="cr-pager__arrow" aria-label="Página siguiente" title="Página siguiente" href={href(numero + 1)} scroll={false}>
              <FlechaPagina />
            </Link>
          ) : (
            <button type="button" className="cr-pager__arrow" aria-label="Página siguiente" disabled>
              <FlechaPagina />
            </button>
          )}
        </nav>
      )}
    </div>
  )
}
