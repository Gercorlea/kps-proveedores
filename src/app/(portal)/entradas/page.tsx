import Link from 'next/link'
import { getSession } from '@/lib/auth/server'
import { esInterno } from '@/lib/auth/session'
import { puedeCapturarEntradas } from '@/lib/receipts/acceso'
import { getSapClient, SapError, type B1PurchaseOrder } from '@/lib/sap'
import { leerEntradasDeOrdenes } from '@/lib/sap/entradas'

/**
 * P04d · Ordenes por recibir.
 *
 * Punto de entrada de la captura de entradas de mercancia: lista las ordenes
 * abiertas de Business One y, de cada una, cuantas entregas lleva ya. Desde
 * aqui se salta a capturar.
 *
 * SOLO INTERNOS. Primera capa visible del guard de §06; la de verdad esta en la
 * pagina de captura y en la ruta de API.
 *
 * Igual que /ordenes, lee B1 en vivo y sin cache: lo que se ve es lo que hay en
 * SAP en este momento.
 */
export const dynamic = 'force-dynamic'

interface Props {
  searchParams: Promise<{ q?: string; capturables?: string }>
}

/** Tope de ordenes que se traen por visita. Mismo criterio que /ordenes. */
const MAX_ORDENES = 400
/** Filas que se pintan. El resto se alcanza afinando la busqueda. */
const VISIBLES = 50

function money(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  return new Intl.NumberFormat('es-MX', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

const MESES = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC']

function fecha(raw: string | null | undefined): string {
  if (!raw) return '—'
  const [y, m, d] = raw.slice(0, 10).split('-')
  return `${d} ${MESES[Number(m) - 1] ?? m} ${y}`
}

/** Minusculas, sin acentos y sin signos: para que "OC 1098" y "oc1098" busquen igual. */
function compacto(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

function coincide(oc: B1PurchaseOrder, termino: string): boolean {
  return [String(oc.DocNum), `OC ${oc.DocNum}`, oc.CardCode, oc.CardName ?? ''].some((campo) =>
    compacto(campo).includes(termino),
  )
}

type Resultado = { ok: true; ordenes: readonly B1PurchaseOrder[] } | { ok: false; error: string }

/**
 * `cardCode` acota la lectura al proveedor de la sesion, y NO es opcional para
 * un no-interno.
 *
 * Con `FEATURE_ENTRADAS_PROVEEDOR` encendida esta pantalla la ve tambien un
 * proveedor. El filtro viaja a B1 en el $filter, no en un descarte posterior:
 * traer las ordenes de todos y quitarlas al pintar pondria en memoria —y en el
 * HTML, si algo se cuela— las compras de otras empresas (§02).
 */
async function cargarAbiertas(cardCode: string | null): Promise<Resultado> {
  const sap = getSapClient()
  const ordenes: B1PurchaseOrder[] = []
  try {
    let skip = 0
    for (;;) {
      // Con renglones: hacen falta los codigos de articulo para saber que
      // ordenes se pueden capturar sin lotes. Es mas pesado que la lista pelada,
      // pero es el unico sitio donde vive el enlace orden -> articulo.
      const page = await sap.listPurchaseOrdersWithLines({
        openOnly: true,
        skip,
        ...(cardCode ? { cardCode } : {}),
      })
      ordenes.push(...page.items)
      if (page.nextSkip === undefined || page.items.length === 0) break
      if (ordenes.length >= MAX_ORDENES) break
      skip = page.nextSkip
    }
    return { ok: true, ordenes }
  } catch (error) {
    if (error instanceof SapError) return { ok: false, error: error.message }
    return { ok: false, error: error instanceof Error ? error.message : 'Error desconocido.' }
  }
}

export default async function Page({ searchParams }: Props) {
  const { q, capturables } = await searchParams
  const termino = q?.trim() ?? ''

  const session = await getSession()
  if (!session) {
    return (
      <div className="cr-info" data-tone="danger">
        <span className="cr-info__label">Sin sesión</span>
        <p>Vuelve a entrar para ver las órdenes por recibir.</p>
      </div>
    )
  }

  if (!puedeCapturarEntradas(session)) {
    return (
      <>
        <div className="cr-page-head">
          <h1>Entradas de mercancía</h1>
        </div>
        <div className="cr-empty">
          <div className="cr-empty__title">Esta sección es de KPS.</div>
          <p>
            Las entradas de mercancía las registra almacén cuando llega el material, no el
            proveedor. Si esperas el estatus de una factura, ve a{' '}
            <Link href="/facturas">tus facturas</Link>.
          </p>
        </div>
      </>
    )
  }

  // Un interno ve todas las ordenes; un proveedor, solo las suyas. La decision
  // se toma aqui, con la sesion delante, y no dentro de `cargarAbiertas`: asi la
  // funcion no tiene que saber de roles y no puede "olvidarse" del filtro.
  const resultado = await cargarAbiertas(esInterno(session.roles) ? null : session.supplierCode ?? null)
  const todas = resultado.ok ? resultado.ordenes : []

  // Ordenes "simples": ninguno de sus renglones abiertos pide dato extra al
  // capturar —ni lote, ni numero de serie, ni articulo no inventariable—.
  //
  // El lote SI se puede capturar, pero pide teclear numero, cantidad y
  // caducidad por renglon. Este filtro existe para quien solo quiere recibir y
  // seguir, no porque el lote sea un impedimento.
  //
  // Una lectura fallida deja el conjunto vacio, y entonces todas cuentan como
  // simples: es preferible ofrecer una que pida lote a esconder las que si se
  // pueden por un mal minuto del Service Layer.
  const conGestion = new Set<string>()
  try {
    for (const it of await getSapClient().listItemsConGestion()) conGestion.add(it.ItemCode)
  } catch {
    // Sin informacion: no se descarta ninguna.
  }

  const esSimple = (oc: B1PurchaseOrder): boolean =>
    (oc.DocumentLines ?? [])
      .filter((l) => (l.RemainingOpenQuantity ?? l.Quantity) > 0)
      .every((l) => !l.ItemCode || !conGestion.has(l.ItemCode))

  const soloSimples = capturables !== '0'
  const porTermino = termino ? todas.filter((oc) => coincide(oc, compacto(termino))) : todas
  const filtradas = soloSimples ? porTermino.filter(esSimple) : porTermino
  const ocultas = porTermino.length - filtradas.length
  const visibles = filtradas.slice(0, VISIBLES)

  // Cuantas entregas lleva ya cada orden visible. Se pide solo de las que caben
  // en pantalla: preguntar por las 400 seria carisimo y nadie las mira.
  //
  // Sin `cardCode` a proposito: quien llega aqui es interno y necesita ver las
  // ordenes de todos los proveedores.
  let entregas = new Map<number, number>()
  if (visibles.length > 0) {
    try {
      const { porOrden } = await leerEntradasDeOrdenes({
        ordenes: visibles.map((oc) => ({ DocEntry: oc.DocEntry, DocDate: oc.DocDate })),
      })
      entregas = new Map(
        [...porOrden].map(([docEntry, lineas]) => [
          docEntry,
          // Documentos distintos, no renglones: una entrega de cinco articulos
          // es UNA entrega.
          new Set(lineas.map((l) => l.docNum)).size,
        ]),
      )
    } catch {
      // Si falla, la columna sale vacia. Perder el dato de cuantas entregas
      // lleva no justifica tumbar la pantalla entera.
    }
  }

  return (
    <>
      <div className="cr-page-head">
        <div>
          <h1>Entradas de mercancía</h1>
          <p className="cr-lead cr-flush">
            {!resultado.ok
              ? 'No se pudieron leer las órdenes'
              : termino !== ''
                ? `${filtradas.length} de ${todas.length} coinciden con "${termino}"`
                : `${todas.length} ${todas.length === 1 ? 'orden abierta' : 'órdenes abiertas'}`}
          </p>
        </div>
        <div className="cr-page-head__meta">
          <span className="cr-meta">Business One</span>
        </div>
      </div>

      <div className="cr-info">
        <span className="cr-info__label">Para qué sirve esto</span>
        <p>
          Registrar que llegó la mercancía de una orden. La entrada se crea en Business One, que
          descuenta lo recibido; a partir de ahí el proveedor puede facturar contra lo que llegó de
          verdad, que es la unidad de facturación de este flujo.
        </p>
      </div>

      {!resultado.ok && (
        <div className="cr-info" data-tone="danger">
          <span className="cr-info__label">No hay conexión con Business One</span>
          <p>{resultado.error}</p>
          <p className="cr-small">
            Comprueba la conexión con <span className="cr-mono">pnpm sap:check</span>.
          </p>
        </div>
      )}

      {resultado.ok && (
        <>
          <section className="cr-section">
            <form method="get" className="cr-field cr-filtros__buscar">
              <label className="cr-field__label" htmlFor="q">
                Número de orden o proveedor
              </label>
              <div className="cr-btn-row">
                <input
                  id="q"
                  name="q"
                  className="cr-input"
                  defaultValue={termino}
                  placeholder="Escribe un número de orden o un proveedor"
                  autoComplete="off"
                />
                <button type="submit" className="cr-btn">
                  Buscar
                </button>
                {termino !== '' && (
                  <Link href="/entradas" className="cr-btn" data-variant="secondary">
                    Limpiar
                  </Link>
                )}
              </div>

              {/* El filtro viaja en la URL y no en un estado del cliente para que
                  la pantalla siga siendo un Server Component: no hace falta
                  JavaScript, y el enlace se puede compartir tal cual. */}
              <div className="cr-segment cr-mt-2" role="group" aria-label="Vista">
                <Link
                  href={termino ? `/entradas?q=${encodeURIComponent(termino)}` : '/entradas'}
                  className="cr-segment__item"
                  {...(soloSimples ? { 'aria-current': 'page' as const } : {})}
                >
                  Sin lotes
                </Link>
                <Link
                  href={
                    termino
                      ? `/entradas?q=${encodeURIComponent(termino)}&capturables=0`
                      : '/entradas?capturables=0'
                  }
                  className="cr-segment__item"
                  {...(soloSimples ? {} : { 'aria-current': 'page' as const })}
                >
                  Todas
                </Link>
              </div>

              {soloSimples && ocultas > 0 && (
                <p className="cr-small cr-muted cr-mt-2">
                  Se ocultan {ocultas}{' '}
                  {ocultas === 1 ? 'orden que pide' : 'órdenes que piden'} lote, número de serie o
                  llevan artículos no inventariables. Las de lote sí se pueden capturar —hay que
                  teclear número, cantidad y caducidad de cada uno—; pulsa <strong>Todas</strong>{' '}
                  para verlas.
                </p>
              )}
              <div className="cr-field__help">
                Busca entre las órdenes abiertas. No distingue mayúsculas ni acentos.
              </div>
            </form>
          </section>

          <section className="cr-section">
            <span className="cr-label">Órdenes que pueden recibir mercancía</span>

            {visibles.length === 0 ? (
              <div className="cr-empty">
                <div className="cr-empty__title">
                  {termino !== ''
                    ? `Ninguna orden abierta coincide con "${termino}".`
                    : 'No hay órdenes abiertas en Business One.'}
                </div>
                <p>
                  {termino !== '' ? (
                    <Link href="/entradas">Ver todas las abiertas</Link>
                  ) : (
                    'Una orden cerrada o cancelada ya no admite entradas de mercancía.'
                  )}
                </p>
              </div>
            ) : (
              <>
                <table className="cr-table cr-table--stack">
                  <thead>
                    <tr>
                      <th>Orden</th>
                      <th>Proveedor</th>
                      <th>Emitida</th>
                      <th className="cr-num">Total</th>
                      <th className="cr-num">Entregas</th>
                      <th>Acción</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibles.map((oc) => {
                      const recibidas = entregas.get(oc.DocEntry) ?? 0
                      return (
                        <tr key={oc.DocEntry}>
                          <td className="cr-code" data-label="Orden">
                            <Link href={`/ordenes/${oc.DocEntry}`}>OC {oc.DocNum}</Link>
                          </td>
                          <td data-label="Proveedor">
                            <span className="cr-mono">{oc.CardCode}</span>
                            {oc.CardName ? ` · ${oc.CardName}` : ''}
                          </td>
                          <td data-label="Emitida">{fecha(oc.DocDate)}</td>
                          <td className="cr-num" data-label="Total">
                            {money(oc.DocTotal)} {oc.DocCurrency ?? ''}
                          </td>
                          <td className="cr-num" data-label="Entregas">
                            {recibidas > 0 ? (
                              <span className="cr-status" data-tone="ok">
                                {recibidas}
                              </span>
                            ) : (
                              <span className="cr-muted">sin recibir</span>
                            )}
                          </td>
                          <td data-label="Acción">
                            <Link
                              href={`/entradas/nueva?oc=${oc.DocEntry}`}
                              className="cr-btn"
                             
                            >
                              Registrar entrada
                            </Link>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>

                <div className="cr-pager">
                  <span>
                    {visibles.length} de {filtradas.length}
                  </span>
                  {filtradas.length > visibles.length && (
                    <span>Afina la búsqueda para ver las demás</span>
                  )}
                </div>
              </>
            )}
          </section>
        </>
      )}
    </>
  )
}
