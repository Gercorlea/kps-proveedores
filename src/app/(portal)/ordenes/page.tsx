import Link from 'next/link'
import { getSession } from '@/lib/auth/server'
import { esInterno } from '@/lib/auth/session'
import { InvoiceStatus } from '@/lib/domain/enums'
import { fromDecimal128, invoices, supplierScope, type InvoiceDoc } from '@/lib/mongo'
import { calcularRecepcion, renglonDesdeB1, type Recepcion } from '@/lib/matching/recepciones'
import type { Decimal } from '@/lib/money'
import { getSapClient, SapError, type B1PurchaseOrder } from '@/lib/sap'
import { leerEntradasDeOrdenes } from '@/lib/sap/entradas'
import { describirPlazo, leerPlazos } from '@/lib/sap/plazos'

/**
 * P04 · Ordenes de compra.
 *
 * Lee de Business One en vivo. B1 es la fuente de verdad de las ordenes y aqui
 * no hay cache local: lo que se ve es lo que hay en SAP en este momento.
 *
 * AISLAMIENTO. El filtro por proveedor va en el `$filter` que se manda a B1, no
 * despues de leer. Traerse todas las ordenes de la empresa y descartar las
 * ajenas en memoria pondria los datos de todos los proveedores en el proceso, y
 * un descuido bastaria para enseñarlos.
 *
 * Nota de arquitectura: §04 principio 2 dice que ninguna llamada a SAP ocurre
 * dentro de un request HTTP. Esta pantalla lo incumple a proposito: es una
 * lectura, no una escritura, y encolarla obligaria al proveedor a esperar sin
 * saber a que. Lo que si tiene que ir a la cola es toda escritura hacia B1.
 */
export const dynamic = 'force-dynamic'

interface Props {
  searchParams: Promise<{ q?: string; p?: string; tab?: string }>
}

/** Filas por pagina. */
const POR_PAGINA = 20

/**
 * Tope de ordenes que se traen por visita.
 *
 * Se paginan en memoria porque el $filter de este Service Layer no tiene
 * `toupper` —responde "Property 'toupper' of 'Document' is invalid"— y su
 * `contains` distingue mayusculas, asi que buscar del lado de B1 obligaria a
 * escribir la razon social con las mayusculas exactas.
 */
const MAX_ORDENES = 1000

const ESTATUS_SAP: Record<string, { label: string; tone?: string }> = {
  bost_Open: { label: 'Abierta' },
  bost_Close: { label: 'Cerrada', tone: 'ok' },
  bost_Paid: { label: 'Pagada', tone: 'ok' },
  bost_Delivered: { label: 'Entregada', tone: 'ok' },
}

function formatMoney(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  return new Intl.NumberFormat('es-MX', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

function formatDate(raw: string | null | undefined): string {
  if (!raw) return '—'
  // El Service Layer devuelve 'YYYY-MM-DD'. Se formatea sin construir un Date
  // para no desplazar el dia por la zona horaria del servidor.
  const [y, m, d] = raw.slice(0, 10).split('-')
  const meses = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC']
  const mes = meses[Number(m) - 1] ?? m
  return `${d} ${mes} ${y}`
}

/** Cantidades, no importes: son piezas y se leen mal con dos decimales. */
function qty(value: Decimal): string {
  return new Intl.NumberFormat('es-MX', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  }).format(value.toNumber())
}

/**
 * Minusculas y sin acentos: quien busca "pena" espera encontrar "Peña", y quien
 * teclea rapido no pone el acento.
 */
function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
}

/**
 * Compacta para comparar: quita todo lo que no sea letra o numero.
 *
 * La tabla muestra "OC 1098", asi que eso es lo que la gente copia al buscador.
 * Comparando solo contra el numero, buscar lo que se ve en pantalla no
 * encontraba nada. Con esto "OC 1098", "oc1098" y "1098" son el mismo termino.
 */
function compacto(texto: string): string {
  return normalizar(texto).replace(/[^a-z0-9]/g, '')
}

function coincide(oc: B1PurchaseOrder, termino: string): boolean {
  return [
    String(oc.DocNum),
    // Como se pinta en la tabla, para que copiar y pegar funcione.
    `OC ${oc.DocNum}`,
    oc.CardCode,
    oc.CardName ?? '',
    oc.NumAtCard ?? '',
  ].some((campo) => compacto(campo).includes(termino))
}

type Resultado =
  | { ok: true; ordenes: readonly B1PurchaseOrder[]; truncado: boolean }
  | { ok: false; error: string }

async function cargar(cardCode: string | undefined, soloAbiertas: boolean): Promise<Resultado> {
  const sap = getSapClient()
  const ordenes: B1PurchaseOrder[] = []
  let truncado = false

  try {
    let skip = 0
    for (;;) {
      const page = await sap.listPurchaseOrders({ openOnly: soloAbiertas, cardCode, skip })
      ordenes.push(...page.items)
      // Una pagina vacia con `nextSkip` dejaria el cursor donde estaba: se corta
      // aqui para no quedarse dando vueltas contra B1.
      if (page.nextSkip === undefined || page.items.length === 0) break
      if (ordenes.length >= MAX_ORDENES) {
        truncado = true
        break
      }
      skip = page.nextSkip
    }
    return { ok: true, ordenes, truncado }
  } catch (error) {
    if (error instanceof SapError) return { ok: false, error: error.message }
    return { ok: false, error: error instanceof Error ? error.message : 'Error desconocido.' }
  }
}

/**
 * Estado de cada orden EN EL PORTAL, derivado de sus facturas.
 *
 * B1 no sabe nada de esto: para SAP la orden sigue "Abierta" hasta que se
 * registre el documento. El proveedor necesita ver que ya envio algo, o la
 * pantalla le invita a subirlo otra vez.
 *
 * Se resuelve en UNA consulta para todas las ordenes visibles. Preguntar por
 * orden seria una consulta por fila de la tabla.
 */
const PRIORIDAD: Array<{ estados: string[]; label: string; tone?: string }> = [
  // El orden importa: se muestra lo mas accionable. Una orden con una factura
  // rechazada y otra aprobada tiene trabajo pendiente, y eso es lo que hay que
  // ver primero.
  { estados: ['RECHAZADA', 'DUPLICADA'], label: 'Rechazada', tone: 'danger' },
  { estados: ['EN_CORRECCION'], label: 'Por corregir', tone: 'warn' },
  { estados: ['BORRADOR'], label: 'Borrador sin enviar', tone: 'warn' },
  { estados: ['EN_REVISION', 'NC_EN_REVISION'], label: 'En revision', tone: 'warn' },
  { estados: ['PAGADA', 'CERRADA'], label: 'Pagada', tone: 'ok' },
  {
    estados: ['APROBADA_PAGO', 'REGISTRADA_SAP', 'CUENTAS_POR_PAGAR'],
    label: 'Aprobada',
    tone: 'ok',
  },
]

/**
 * Cuanto se lleva facturado de cada orden, por importe.
 *
 * Cuenta lo aprobado Y lo que esta en revision: para el proveedor una factura
 * enviada ya ocupa sitio en la orden, aunque KPS no haya decidido. Lo devuelto
 * y lo rechazado no cuenta, porque esa cantidad vuelve a estar pendiente.
 */
const OCUPAN: readonly InvoiceStatus[] = [
  InvoiceStatus.EN_REVISION,
  InvoiceStatus.NC_EN_REVISION,
  InvoiceStatus.APROBADA_PAGO,
  InvoiceStatus.REGISTRADA_SAP,
  InvoiceStatus.CUENTAS_POR_PAGAR,
  InvoiceStatus.PAGADA,
  InvoiceStatus.CERRADA,
]

async function facturadoPorOrden(ctx: {
  supplierCode?: string | null
  internal: boolean
}): Promise<Map<string, number>> {
  const docs = await (await invoices())
    .find(supplierScope<InvoiceDoc>({ status: { $in: [...OCUPAN] } }, ctx), {
      projection: { poNumber: 1, total: 1 },
    })
    .toArray()

  const suma = new Map<string, number>()
  for (const d of docs) {
    if (!d.poNumber) continue
    const importe = Number(fromDecimal128(d.total ?? null)?.toString() ?? 0)
    suma.set(d.poNumber, (suma.get(d.poNumber) ?? 0) + importe)
  }
  return suma
}

async function estadoEnPortal(
  numeros: readonly string[],
  ctx: { supplierCode?: string | null; internal: boolean },
): Promise<Map<string, { label: string; tone?: string; total: number }>> {
  const mapa = new Map<string, { label: string; tone?: string; total: number }>()
  if (numeros.length === 0) return mapa

  const docs = await (await invoices())
    .find(supplierScope<InvoiceDoc>({ poNumber: { $in: [...numeros] } }, ctx), {
      projection: { poNumber: 1, status: 1 },
    })
    .toArray()

  const porOrden = new Map<string, string[]>()
  for (const d of docs) {
    if (!d.poNumber) continue
    porOrden.set(d.poNumber, [...(porOrden.get(d.poNumber) ?? []), d.status])
  }

  for (const [orden, estados] of porOrden) {
    const encontrado = PRIORIDAD.find((p) => estados.some((e) => p.estados.includes(e)))
    mapa.set(orden, {
      label: encontrado?.label ?? estados[0],
      tone: encontrado?.tone,
      total: estados.length,
    })
  }
  return mapa
}

/**
 * Cuanta mercancia ha llegado de cada orden de la pagina.
 *
 * SOLO DE LAS VISIBLES. Calcularlo para las mil ordenes que puede traer el
 * listado obligaria a leer los renglones de todas y el historico entero de
 * entradas; para las 20 que se ven son dos consultas.
 *
 * POR QUE NO SALE DE LA PROPIA ORDEN. B1 no guarda cuanto llego, guarda cuanto
 * falta, y ese numero se va a cero tanto si llego todo como si alguien cerro el
 * renglon porque el resto ya no viene. Ver `@/lib/matching/recepciones`.
 */
async function recibidoDe(
  visibles: readonly B1PurchaseOrder[],
  cardCode: string | undefined,
): Promise<{ porOrden: Map<number, Recepcion>; truncado: boolean }> {
  const porOrden = new Map<number, Recepcion>()
  if (visibles.length === 0) return { porOrden, truncado: false }

  // Los renglones de las ordenes visibles, de una sola vez: el listado trae solo
  // cabeceras y lo pedido vive en la linea.
  const [conLineas, entradas] = await Promise.all([
    getSapClient().listPurchaseOrdersWithLines({
      docEntries: visibles.map((oc) => oc.DocEntry),
      top: visibles.length,
    }),
    leerEntradasDeOrdenes({
      ordenes: visibles.map((oc) => ({ DocEntry: oc.DocEntry, DocDate: oc.DocDate })),
      ...(cardCode ? { cardCode } : {}),
    }),
  ])

  for (const oc of conLineas.items) {
    porOrden.set(
      oc.DocEntry,
      calcularRecepcion({
        orden: (oc.DocumentLines ?? []).map(renglonDesdeB1),
        entradas: entradas.porOrden.get(oc.DocEntry) ?? [],
      }),
    )
  }
  return { porOrden, truncado: entradas.truncado }
}

function enlace(pagina: number, termino: string, tab: string): string {
  const params = new URLSearchParams()
  if (tab !== 'pendientes') params.set('tab', tab)
  if (termino) params.set('q', termino)
  if (pagina > 1) params.set('p', String(pagina))
  const qs = params.toString()
  return qs ? `/ordenes?${qs}` : '/ordenes'
}

export default async function Page({ searchParams }: Props) {
  const { q, p, tab } = await searchParams
  const termino = q?.trim() ?? ''
  const pestana = tab === 'completadas' ? 'completadas' : 'pendientes'

  const session = await getSession()
  if (!session) {
    return (
      <div className="ar-info" data-tone="danger">
        <span className="ar-info__label">Sin sesion</span>
        <p>Vuelve a entrar para ver tus ordenes de compra.</p>
      </div>
    )
  }

  const interno = esInterno(session.roles)

  // Un usuario sin proveedor y sin ser interno no tiene ordenes que ver. Se
  // corta antes de llamar a B1: sin `cardCode` la consulta traeria las de todos.
  if (!interno && !session.supplierCode) {
    return (
      <>
        <div className="ar-page-head">
          <h1>Ordenes de compra</h1>
        </div>
        <div className="ar-info" data-tone="warn">
          <span className="ar-info__label">Tu cuenta no esta vinculada a un proveedor</span>
          <p>Avisa a KPS para que la vincule; hasta entonces no hay ordenes que mostrar.</p>
        </div>
      </>
    )
  }

  const ctx = { supplierCode: session.supplierCode, internal: interno }
  // En "completadas" hace falta mirar tambien las cerradas en B1, asi que ahi no
  // se pide `openOnly`.
  const [resultado, facturado] = await Promise.all([
    cargar(interno ? undefined : session.supplierCode!, pestana === 'pendientes'),
    // Si la base falla, se sigue con el mapa vacio: las ordenes se ven igual y
    // solo se pierde la clasificacion.
    facturadoPorOrden(ctx).catch(() => new Map<string, number>()),
  ])

  const todas = resultado.ok ? resultado.ordenes : []

  /**
   * Una orden esta completada cuando ya no espera factura: o B1 la cerro, o lo
   * facturado en el portal cubre su total. El centavo de holgura evita que un
   * redondeo la deje eternamente "pendiente por 0.004".
   */
  const completada = (oc: B1PurchaseOrder) =>
    oc.DocumentStatus !== 'bost_Open' ||
    (facturado.get(String(oc.DocNum)) ?? 0) >= oc.DocTotal - 0.01

  const pendientes = todas.filter((oc) =>
    pestana === 'completadas' ? completada(oc) : !completada(oc),
  )
  const filtradas = termino ? pendientes.filter((oc) => coincide(oc, compacto(termino))) : pendientes

  const totalPaginas = Math.max(1, Math.ceil(filtradas.length / POR_PAGINA))
  // La pagina llega por la URL, asi que se acota en vez de confiar en ella:
  // ?p=99 o ?p=abc son un enlace viejo, no un error del que haya que quejarse.
  const solicitada = Number.parseInt(p ?? '1', 10)
  const pagina = Math.min(Math.max(Number.isFinite(solicitada) ? solicitada : 1, 1), totalPaginas)
  const inicio = (pagina - 1) * POR_PAGINA
  const visibles = filtradas.slice(inicio, inicio + POR_PAGINA)

  // El catalogo de condiciones de pago, una sola vez para toda la tabla. El
  // adaptador lo memoiza, y sin el la columna de plazo mostraria el codigo crudo.
  const plazos = await leerPlazos()

  // En paralelo: una mira la base del portal y la otra B1, no se necesitan entre
  // si. Si B1 falla, la tabla se pinta igual sin la columna de recibido: perder
  // el avance no justifica perder el listado.
  const [enPortal, recibido] = await Promise.all([
    estadoEnPortal(visibles.map((oc) => String(oc.DocNum)), {
      supplierCode: session.supplierCode,
      internal: interno,
    }),
    recibidoDe(visibles, interno ? undefined : (session.supplierCode ?? undefined)).catch(
      () => null,
    ),
  ])

  const resumen = !resultado.ok
    ? 'No se pudieron leer las ordenes'
    : termino !== ''
      ? `${filtradas.length} de ${pendientes.length} coinciden con "${termino}"`
      : pestana === 'completadas'
        ? `${pendientes.length} ordenes completadas`
        : `${pendientes.length} ordenes pendientes`

  return (
    <>
      <div className="ar-page-head">
        <div>
          <h1>Ordenes de compra</h1>
          <p className="ar-lead" style={{ marginBottom: 0 }}>
            {resumen}
          </p>
        </div>
        <div className="ar-page-head__meta">
          <span className="ar-meta">Business One</span>
          <br />
          <span className="ar-meta">
            {interno ? 'Todas · solo pendientes' : `${session.supplierCode} · solo pendientes`}
          </span>
        </div>
      </div>

      {!resultado.ok && (
        <div className="ar-info" data-tone="danger">
          <span className="ar-info__label">No hay conexion con Business One</span>
          <p>{resultado.error}</p>
          <p className="ar-small">
            Comprueba la conexion con <span className="ar-mono">pnpm sap:check</span>. Ese comando
            dice si el fallo es de red, de certificado, de credenciales o de permisos.
          </p>
        </div>
      )}

      {resultado.ok && (
        <>
          <section className="ar-section">
            <div className="ar-btn-row" style={{ marginBottom: 'var(--ar-s4)' }}>
              <Link
                href="/ordenes"
                className="ar-btn"
                data-variant={pestana === 'pendientes' ? undefined : 'secondary'}
              >
                Pendientes
              </Link>
              <Link
                href="/ordenes?tab=completadas"
                className="ar-btn"
                data-variant={pestana === 'completadas' ? undefined : 'secondary'}
              >
                Completadas
              </Link>
            </div>

            <form method="get" className="ar-field" style={{ maxWidth: 560, marginBottom: 0 }}>
              {/* La pestana viaja con la busqueda: sin esto, buscar dentro de
                  Completadas devolveria a Pendientes. */}
              {pestana === 'completadas' && <input type="hidden" name="tab" value="completadas" />}
              <label className="ar-field__label" htmlFor="q">
                Numero de orden o referencia
              </label>
              <div style={{ display: 'flex', gap: 'var(--ar-s2)' }}>
                <input
                  id="q"
                  name="q"
                  className="ar-input"
                  defaultValue={termino}
                  // El placeholder NO lleva un numero de ejemplo: en pantalla se
                  // lee igual que un valor ya escrito, y encima un numero que no
                  // fuera de este proveedor haria parecer que la busqueda falla.
                  placeholder="Escribe un numero de orden"
                  autoComplete="off"
                />
                <button type="submit" className="ar-btn">
                  Buscar
                </button>
                {termino !== '' && (
                  <Link
                    href={enlace(1, '', pestana)}
                    className="ar-btn"
                    data-variant="secondary"
                  >
                    Limpiar
                  </Link>
                )}
              </div>
              <div className="ar-field__help">
                Busca solo entre tus ordenes pendientes, por numero de orden o referencia. No
                distingue mayusculas ni acentos.
              </div>
            </form>
          </section>

          {resultado.truncado && (
            <div className="ar-info" data-tone="warn">
              <span className="ar-info__label">Listado recortado</span>
              <p>
                Hay mas de {MAX_ORDENES} ordenes pendientes y solo se cargaron las {MAX_ORDENES} mas
                recientes. Afina la busqueda para llegar a una anterior.
              </p>
            </div>
          )}

          {recibido?.truncado && (
            <div className="ar-info" data-tone="warn">
              <span className="ar-info__label">Recibido incompleto</span>
              <p>
                Hay mas entradas de mercancia de las que se pudieron leer de una vez. Los
                porcentajes de la columna Recibido son un minimo, no el total.
              </p>
            </div>
          )}

          <section className="ar-section">
            <span className="ar-eyebrow">
              {pestana === 'completadas' ? 'Ordenes completadas' : 'Pendientes de facturar'}
            </span>

            {visibles.length === 0 ? (
              <div className="ar-empty">
                {termino !== '' ? (
                  <>
                    <div className="ar-empty__title">
                      Ninguna orden pendiente coincide con &quot;{termino}&quot;.
                    </div>
                    <p>
                      Si ya se cerro o se pago, no sale aqui. Prueba con el numero de orden, o{' '}
                      <Link href="/ordenes">ve todas las pendientes</Link>.
                    </p>
                  </>
                ) : (
                  <>
                    <div className="ar-empty__title">
                      {pestana === 'completadas'
                        ? 'Todavia no tienes ordenes completadas.'
                        : 'No tienes ordenes de compra pendientes.'}
                    </div>
                    <p>
                      {pestana === 'completadas'
                        ? 'Aqui apareceran las ordenes que ya facturaste por completo, o que Business One cerro.'
                        : 'La consulta a Business One funciono: no hay ninguna orden abierta a tu nombre.'}
                    </p>
                  </>
                )}
              </div>
            ) : (
              <>
                <div className="ar-table-scroll">
                <table className="ar-table ar-table--stack">
                  <thead>
                    <tr>
                      <th>Orden</th>
                      {/* Se muestra siempre, tambien al proveedor: aunque todas
                          las filas sean suyas, ver a nombre de quien esta la
                          orden evita dudas al cotejarla con su propio sistema. */}
                      <th>Proveedor</th>
                      <th className="ar-date">Emitida</th>
                      <th className="ar-date">Vence</th>
                      <th className="ar-num">Plazo</th>
                      <th className="ar-num">Total</th>
                      {/* Sale de las entradas de mercancia, no de restarle a la
                          orden lo que falta: esa resta da por recibido lo que se
                          cerro sin llegar. */}
                      <th className="ar-num">Recibido</th>
                      {/* La resta va por renglon, no sobre el total: sumar
                          primero dejaria que las piezas de mas de un articulo
                          taparan las que faltan de otro. */}
                      <th className="ar-num">Falta</th>
                      <th>En Business One</th>
                      <th>En el portal</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibles.map((oc) => {
                      const estatus = ESTATUS_SAP[oc.DocumentStatus] ?? { label: oc.DocumentStatus }
                      return (
                        <tr key={oc.DocEntry}>
                          <td className="ar-code" data-label="Orden">
                            <Link href={`/ordenes/${oc.DocEntry}`}>OC {oc.DocNum}</Link>
                          </td>
                          <td data-label="Proveedor">
                            <span className="ar-mono">{oc.CardCode}</span>
                            {oc.CardName ? ` · ${oc.CardName}` : ''}
                          </td>
                          <td className="ar-date" data-label="Emitida">
                            {formatDate(oc.DocDate)}
                          </td>
                          <td className="ar-date" data-label="Vence">
                            {formatDate(oc.DocDueDate)}
                          </td>
                          {/* El plazo DE ESTA ORDEN, no el del proveedor: se
                              hereda de su ficha pero puede pactarse distinto
                              para una compra concreta, y entonces manda este. */}
                          <td className="ar-num" data-label="Plazo">
                            {describirPlazo(plazos, oc.PaymentGroupCode)}
                          </td>
                          <td className="ar-num" data-label="Total">
                            {formatMoney(oc.DocTotal)} {oc.DocCurrency ?? ''}
                          </td>
                          <td className="ar-num" data-label="Recibido">
                            {(() => {
                              const r = recibido?.porOrden.get(oc.DocEntry)
                              // Sin dato no se pinta un cero: no saber cuanto
                              // llego y saber que no llego nada son cosas
                              // distintas.
                              if (!r || r.pedido.lte(0)) return <span className="ar-muted">—</span>
                              const pct = r.recibido
                                .div(r.pedido)
                                .times(100)
                                .toDecimalPlaces(0)
                                .toNumber()
                              return (
                                <>
                                  <span>{pct}%</span>
                                  <div className="ar-small ar-muted">
                                    {qty(r.recibido)} de {qty(r.pedido)}
                                  </div>
                                  {/* El exceso se marca aunque el porcentaje se
                                      vea sano: un renglon con piezas de mas y
                                      otro corto se compensan en el total y la
                                      orden pareceria cuadrada. */}
                                  {r.excedente.gt(0) && (
                                    <div className="ar-small">
                                      <span className="ar-status" data-tone="warn">
                                        {qty(r.excedente)} de mas
                                      </span>
                                    </div>
                                  )}
                                </>
                              )
                            })()}
                          </td>
                          <td className="ar-num" data-label="Falta">
                            {(() => {
                              const r = recibido?.porOrden.get(oc.DocEntry)
                              if (!r) return <span className="ar-muted">—</span>
                              return (
                                <>
                                  {r.pendiente.gt(0) ? (
                                    qty(r.pendiente)
                                  ) : (
                                    <span className="ar-muted">—</span>
                                  )}
                                  {/* Lo que se cerro sin llegar NO se suma a lo
                                      que falta: eso ya nadie lo espera, y
                                      mezclarlo haria creer que va a llegar. */}
                                  {r.sinSurtir.gt(0) && (
                                    <div className="ar-small">
                                      <span className="ar-status" data-tone="danger">
                                        no llegaran {qty(r.sinSurtir)}
                                      </span>
                                    </div>
                                  )}
                                </>
                              )
                            })()}
                          </td>
                          <td data-label="En Business One">
                            <span className="ar-status" data-tone={estatus.tone}>
                              {oc.Cancelled === 'tYES' ? 'Cancelada' : estatus.label}
                            </span>
                          </td>
                          <td data-label="En el portal">
                            {(() => {
                              const p = enPortal.get(String(oc.DocNum))
                              if (!p) return <span className="ar-badge">Sin facturar</span>
                              return (
                                <span className="ar-status" data-tone={p.tone}>
                                  {p.label}
                                  {p.total > 1 ? ` · ${p.total} facturas` : ''}
                                </span>
                              )
                            })()}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                </div>

                <div className="ar-pager">
                  <span>
                    {inicio + 1}–{inicio + visibles.length} de {filtradas.length}
                  </span>
                  <span style={{ display: 'flex', gap: 'var(--ar-s3)', alignItems: 'center' }}>
                    {pagina > 1 ? (
                      <Link
                        className="ar-btn"
                        data-variant="secondary"
                        href={enlace(pagina - 1, termino, pestana)}
                      >
                        Anterior
                      </Link>
                    ) : (
                      <button type="button" className="ar-btn" data-variant="secondary" disabled>
                        Anterior
                      </button>
                    )}
                    <span>
                      Pagina {pagina} de {totalPaginas}
                    </span>
                    {pagina < totalPaginas ? (
                      <Link
                        className="ar-btn"
                        data-variant="secondary"
                        href={enlace(pagina + 1, termino, pestana)}
                      >
                        Siguiente
                      </Link>
                    ) : (
                      <button type="button" className="ar-btn" data-variant="secondary" disabled>
                        Siguiente
                      </button>
                    )}
                  </span>
                </div>
              </>
            )}
          </section>
        </>
      )}
    </>
  )
}
