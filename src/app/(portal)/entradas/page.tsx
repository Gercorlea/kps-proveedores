import Link from 'next/link'
import { getSession } from '@/lib/auth/server'
import { esInterno } from '@/lib/auth/session'
import { puedeCapturarEntradas } from '@/lib/receipts/acceso'
import { getSapClient, SapError, type B1PurchaseOrder } from '@/lib/sap'
import { leerEntradasDeOrdenes } from '@/lib/sap/entradas'
import { Buscador } from '../buscador'
import { enlacePagina } from '../paginacion'
import { TablaAdaptable } from '../tabla-adaptable'

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
  searchParams: Promise<{ q?: string; capturables?: string; p?: string }>
}

/** Tope de ordenes que se traen por visita. Mismo criterio que /ordenes. */
const MAX_ORDENES = 400

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
  return [String(oc.DocNum), `OC ${oc.DocNum}`, oc.CardCode, oc.CardName ?? '',
    fecha(oc.DocDate), money(oc.DocTotal), oc.DocCurrency ?? ''].some((campo) =>
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
    return { ok: true, ordenes: ordenes.slice(0, MAX_ORDENES) }
  } catch (error) {
    if (error instanceof SapError) return { ok: false, error: error.message }
    return { ok: false, error: error instanceof Error ? error.message : 'Error desconocido.' }
  }
}

export default async function Page({ searchParams }: Props) {
  const { q, capturables, p } = await searchParams
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
        <div className="cr-page-head cr-page-head--listado">
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
  let gestionDisponible = true
  try {
    for (const it of await getSapClient().listItemsConGestion()) conGestion.add(it.ItemCode)
  } catch {
    // Sin informacion: no se descarta ninguna.
    gestionDisponible = false
  }

  const esSimple = (oc: B1PurchaseOrder): boolean =>
    (oc.DocumentLines ?? [])
      .filter((l) => (l.RemainingOpenQuantity ?? l.Quantity) > 0)
      .every((l) => !l.ItemCode || !conGestion.has(l.ItemCode))

  const soloSimples = capturables !== '0'
  const porTermino = termino ? todas.filter((oc) => coincide(oc, compacto(termino))) : todas
  const filtradas = soloSimples ? porTermino.filter(esSimple) : porTermino

  // Una lectura agrupada alimenta todas las páginas del listado acotado.
  // El proveedor conserva su alcance también en el historial de entregas.
  let entregas = new Map<number, number>()
  let entregasDisponibles = true
  let entregasTruncadas = false
  if (filtradas.length > 0) {
    try {
      const { porOrden, truncado } = await leerEntradasDeOrdenes({
        ordenes: filtradas.map((oc) => ({ DocEntry: oc.DocEntry, DocDate: oc.DocDate })),
        cardCode: esInterno(session.roles) ? undefined : session.supplierCode,
      })
      entregasTruncadas = truncado
      entregas = new Map(
        [...porOrden].map(([docEntry, lineas]) => [
          docEntry,
          // Documentos distintos, no renglones: una entrega de cinco articulos
          // es UNA entrega.
          new Set(lineas.map((l) => l.docNum)).size,
        ]),
      )
    } catch {
      entregasDisponibles = false
      // Si falla, la columna sale vacia. Perder el dato de cuantas entregas
      // lleva no justifica tumbar la pantalla entera.
    }
  }

  const filtros = { q: termino || undefined, capturables: soloSimples ? undefined : '0' }
  const verTodas = enlacePagina('/entradas', { q: termino || undefined, capturables: '0' }, 1)

  return (
    <>
      <div className="cr-page-head cr-page-head--listado">
        <div>
          <h1>Entradas de mercancía</h1>
          <p className="cr-small cr-flush cr-ink-3">Recepción de mercancía contra órdenes de compra abiertas</p>
        </div>
      </div>

      {!resultado.ok ? (
        <div className="cr-info" data-tone="danger">
          <span className="cr-info__label">No se pudieron consultar las órdenes</span>
          <p>{resultado.error}</p>
          <Link href="/entradas" className="cr-btn cr-btn--secondary cr-btn--sm">Reintentar</Link>
        </div>
      ) : (
        <section className="cr-panel cr-listado" aria-label="Órdenes por recibir">
          <div className="cr-panel__head">
            <div>
              <h2 className="cr-panel__title">Órdenes por recibir</h2>
              <p className="cr-small cr-flush cr-ink-3">
                {filtradas.length} de {todas.length} órdenes abiertas
              </p>
            </div>
            <div className="cr-panel__controles">
              <Buscador base="/entradas" termino={termino}
                filtros={{ capturables: filtros.capturables }}
                placeholder="Orden, proveedor o importe"
                etiqueta="Buscar por orden, proveedor, fecha o importe" />
              <div className="cr-segment" role="group" aria-label="Filtrar órdenes">
                <Link href={enlacePagina('/entradas', { q: termino || undefined }, 1)}
                  className="cr-segment__item" aria-current={soloSimples ? 'page' : undefined}>
                  Sin lotes
                </Link>
                <Link href={verTodas} className="cr-segment__item"
                  aria-current={!soloSimples ? 'page' : undefined}>Todas</Link>
              </div>
            </div>
          </div>

          {todas.length >= MAX_ORDENES && (
            <p className="cr-listado__aviso">Se muestran las primeras {MAX_ORDENES} órdenes consultadas. La búsqueda se limita a este listado.</p>
          )}
          {!gestionDisponible && (
            <p className="cr-listado__aviso">No se pudo comprobar qué artículos requieren lote o serie. Se muestran todas las órdenes encontradas.</p>
          )}
          {(!entregasDisponibles || entregasTruncadas) && (
            <p className="cr-listado__aviso">
              {entregasDisponibles
                ? 'El historial de entregas está incompleto. Los conteos con + son mínimos confirmados.'
                : 'No se pudo consultar el historial de entregas. Puedes abrir una orden para continuar.'}
            </p>
          )}

          {filtradas.length === 0 ? (
            <div className="cr-empty cr-empty--compacto">
              <div className="cr-empty__title">
                {termino ? `Sin resultados para "${termino}".`
                  : todas.length === 0 ? 'No hay órdenes abiertas.' : 'No hay órdenes sin lotes en esta vista.'}
              </div>
              <p>{todas.length === 0
                ? 'Las órdenes cerradas o canceladas no admiten nuevas entradas.'
                : <Link href={enlacePagina('/entradas', { capturables: '0' }, 1)}>Ver todas las órdenes abiertas</Link>}</p>
            </div>
          ) : (
            <TablaAdaptable base="/entradas" unidad="órdenes" pagina={p} filtros={filtros}
              className="cr-table cr-table--stack cr-listado__tabla cr-entradas__tabla"
              cabecera={
                <>
                  <colgroup>
                    <col className="cr-entradas__orden" /><col />
                    <col className="cr-entradas__fecha" /><col className="cr-entradas__total" />
                    <col className="cr-entradas__entregas" /><col className="cr-entradas__accion" />
                  </colgroup>
                  <thead><tr>
                    <th>Orden</th><th>Proveedor</th><th>Emitida</th>
                    <th className="cr-num">Total</th><th className="cr-num">Entregas</th>
                    <th className="cr-num">Acción</th>
                  </tr></thead>
                </>
              }
              filas={filtradas.map((oc) => {
                const recibidas = entregas.get(oc.DocEntry) ?? 0
                return (
                  <tr key={oc.DocEntry}>
                    <td className="cr-code" data-label="Orden">
                      <Link href={`/ordenes/${oc.DocEntry}`}>OC {oc.DocNum}</Link>
                    </td>
                    <td data-label="Proveedor" title={`${oc.CardName ?? ''} ${oc.CardCode}`}>
                      <span className="cr-listado__proveedor">
                        <span className="cr-listado__nombre">{oc.CardName || oc.CardCode}</span>
                        {oc.CardName && <span className="cr-listado__codigo">{oc.CardCode}</span>}
                      </span>
                    </td>
                    <td className="cr-code" data-label="Emitida">{fecha(oc.DocDate)}</td>
                    <td className="cr-num" data-label="Total">{money(oc.DocTotal)} {oc.DocCurrency ?? ''}</td>
                    <td className="cr-num" data-label="Entregas">
                      {!entregasDisponibles || (entregasTruncadas && recibidas === 0)
                        ? <span className="cr-muted" title="Historial de entregas no disponible o incompleto">—</span>
                        : <span className="cr-badge" data-tone={recibidas > 0 ? 'ok' : undefined}>
                            {recibidas > 0 ? `${recibidas}${entregasTruncadas ? '+' : ''}` : 'Sin recibir'}
                          </span>}
                    </td>
                    <td className="cr-num" data-label="Acción">
                      <Link href={`/entradas/nueva?oc=${oc.DocEntry}`} className="cr-btn cr-btn--primary cr-btn--sm">
                        Registrar entrada
                      </Link>
                    </td>
                  </tr>
                )
              })}
            />
          )}
        </section>
      )}
    </>
  )
}
