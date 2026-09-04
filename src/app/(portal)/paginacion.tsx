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

/** Filas por pagina. Cambiarlo aqui lo cambia en todo el portal. */
export const POR_PAGINA = 5

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
export function paginar<T>(filas: readonly T[], solicitada: string | undefined): Pagina<T> {
  const total = filas.length
  const totalPaginas = Math.max(1, Math.ceil(total / POR_PAGINA))
  const pedida = Number.parseInt(solicitada ?? '1', 10)
  const numero = Math.min(Math.max(Number.isFinite(pedida) ? pedida : 1, 1), totalPaginas)
  const inicio = (numero - 1) * POR_PAGINA
  const visibles = filas.slice(inicio, inicio + POR_PAGINA)
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
}

/**
 * La barra de paginacion.
 *
 * Con una sola pagina se sigue pintando —solo el conteo, sin los botones—: que
 * la barra aparezca y desaparezca segun cuantas filas haya mueve el pie de la
 * tabla y descoloca a quien la estaba mirando.
 */
export function Paginador({ pagina, href, unidad = 'documentos', nota }: Props) {
  const { numero, totalPaginas, desde, hasta, total } = pagina
  const hayVarias = totalPaginas > 1

  return (
    <div className="cr-pager">
      <span>
        {total === 0
          ? `Sin ${unidad}`
          : hayVarias
            ? `${desde}–${hasta} de ${total} ${unidad}`
            : `${total} ${unidad}`}
        {nota !== undefined && ` · ${nota}`}
      </span>

      {hayVarias && (
        <span className="cr-row cr-row--wide">
          {numero > 1 ? (
            <Link className="cr-btn cr-btn--sm" data-variant="secondary" href={href(numero - 1)}>
              Anterior
            </Link>
          ) : (
            <button type="button" className="cr-btn cr-btn--sm" data-variant="secondary" disabled>
              Anterior
            </button>
          )}
          <span>
            Pagina {numero} de {totalPaginas}
          </span>
          {numero < totalPaginas ? (
            <Link className="cr-btn cr-btn--sm" data-variant="secondary" href={href(numero + 1)}>
              Siguiente
            </Link>
          ) : (
            <button type="button" className="cr-btn cr-btn--sm" data-variant="secondary" disabled>
              Siguiente
            </button>
          )}
        </span>
      )}
    </div>
  )
}
