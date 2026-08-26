import Link from 'next/link'
import { getSession } from '@/lib/auth/server'
import { esInterno } from '@/lib/auth/session'
import { fromDecimal128, invoices } from '@/lib/mongo'
import { calcularRecepcion, renglonDesdeB1, type LineaEntrada, type Recepcion } from '@/lib/matching/recepciones'
import { Decimal, moneyOrZero } from '@/lib/money'
import { getSapClient, SapError, type B1PurchaseOrder } from '@/lib/sap'
import { leerEntradasDeOrdenes } from '@/lib/sap/entradas'
import { leerEntradasFacturables } from '@/lib/sap/entradas-facturables'
import CargarXml, { type EntradaOpcion } from './cargar-xml'

/**
 * P04b · Detalle de una orden de compra.
 *
 * Lee la orden de Business One en vivo y deja cargar el CFDI contra ella.
 *
 * AISLAMIENTO. B1 devuelve cualquier orden por DocEntry, sin saber quien
 * pregunta: el CardCode del documento se compara con el de la sesion ANTES de
 * enseñar nada. Sin esa comprobacion, cambiar el numero de la URL mostraria las
 * ordenes de cualquier otro proveedor.
 *
 * Sobre el cotejo: §06 compara TRES fuentes —orden, entrada de mercancia y
 * factura— y la unidad de facturacion del flujo de mercancia es la ENTRADA, no
 * la orden (§00 consecuencia 01). Al cargar el XML se hace lo que si se puede
 * hacer sin la entrada: extraer los datos fiscales, validarlos y contrastar
 * moneda y total contra la orden. La pantalla dice que eso no es el cotejo.
 */
export const dynamic = 'force-dynamic'

interface Props {
  params: Promise<{ docEntry: string }>
}

const ESTATUS_SAP: Record<string, { label: string; tone?: string }> = {
  bost_Open: { label: 'Abierta' },
  bost_Close: { label: 'Cerrada', tone: 'ok' },
  bost_Paid: { label: 'Pagada', tone: 'ok' },
  bost_Delivered: { label: 'Entregada', tone: 'ok' },
}

function money(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  return new Intl.NumberFormat('es-MX', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

function formatDate(raw: string | null | undefined): string {
  if (!raw) return '—'
  const [y, m, d] = raw.slice(0, 10).split('-')
  const meses = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC']
  const mes = meses[Number(m) - 1] ?? m
  return `${d} ${mes} ${y}`
}

/**
 * Cantidades, no importes: se piden piezas enteras y escribir "4,141.00" en la
 * columna de al lado de un precio invita a leerlo como dinero.
 */
function qty(value: Decimal): string {
  return new Intl.NumberFormat('es-MX', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  }).format(value.toNumber())
}

const ESTADO_RENGLON: Record<string, { label: string; tone?: string }> = {
  SIN_RECIBIR: { label: 'Sin recibir' },
  PARCIAL: { label: 'Parcial', tone: 'warn' },
  COMPLETA: { label: 'Recibida', tone: 'ok' },
  CERRADA_SIN_COMPLETAR: { label: 'Cerrada incompleta', tone: 'danger' },
  EXCEDIDA: { label: 'Recibida de mas', tone: 'warn' },
}

type Entradas =
  | { ok: true; lineas: readonly LineaEntrada[]; truncado: boolean }
  | { ok: false; error: string }

/**
 * Las entregas que surtieron esta orden.
 *
 * La lectura contra B1 y el porque de hacerla asi viven en `@/lib/sap/entradas`;
 * aqui solo se traduce el fallo a algo que la pantalla pueda contar, porque una
 * caida de B1 no debe tumbar el detalle entero de la orden.
 *
 * Se pide con el `cardCode` de la propia orden, que quien llama ya comprobo que
 * coincide con el de la sesion.
 */
async function cargarEntradas(oc: B1PurchaseOrder): Promise<Entradas> {
  try {
    const { porOrden, truncado } = await leerEntradasDeOrdenes({
      ordenes: [{ DocEntry: oc.DocEntry, DocDate: oc.DocDate }],
      cardCode: oc.CardCode,
    })
    return { ok: true, lineas: porOrden.get(oc.DocEntry) ?? [], truncado }
  } catch (error) {
    if (error instanceof SapError) return { ok: false, error: error.message }
    return { ok: false, error: error instanceof Error ? error.message : 'Error desconocido.' }
  }
}

/**
 * Las entradas que se pueden facturar, para el selector de la carga.
 *
 * Nunca lanza: si B1 no responde se devuelve la lista vacia y el formulario
 * ensena "sin entrada de mercancia". Es un aviso de mas —el proveedor podria
 * guardar sin entrada teniendo una disponible— pero tumbar la pantalla entera
 * por esto le quitaria tambien la opcion de guardar el borrador.
 */
async function cargarFacturables(
  oc: B1PurchaseOrder,
): Promise<{ entradas: EntradaOpcion[]; truncado: boolean }> {
  try {
    const { entradas, truncado } = await leerEntradasFacturables({
      poDocEntry: oc.DocEntry,
      poDocDate: oc.DocDate,
      cardCode: oc.CardCode,
    })
    return {
      entradas: entradas.map((e) => ({
        docEntry: e.docEntry,
        docNum: e.docNum,
        fecha: e.fecha,
        renglones: e.renglones.length,
      })),
      truncado,
    }
  } catch {
    return { entradas: [], truncado: false }
  }
}

function NoEncontrada({ mensaje }: { mensaje: string }) {
  return (
    <>
      <div className="ar-page-head">
        <h1>Orden de compra</h1>
      </div>
      <div className="ar-empty">
        <div className="ar-empty__title">{mensaje}</div>
        <p>
          <Link href="/ordenes">Volver a las ordenes</Link>
        </p>
      </div>
    </>
  )
}

type Resultado = { ok: true; oc: B1PurchaseOrder } | { ok: false; error: string; noExiste?: boolean }

async function cargar(docEntry: number): Promise<Resultado> {
  try {
    const oc = await getSapClient().getPurchaseOrder(docEntry)
    if (!oc) return { ok: false, error: `No hay ninguna orden con el numero ${docEntry}.`, noExiste: true }
    return { ok: true, oc }
  } catch (error) {
    if (error instanceof SapError) return { ok: false, error: error.message }
    return { ok: false, error: error instanceof Error ? error.message : 'Error desconocido.' }
  }
}

export default async function Page({ params }: Props) {
  const { docEntry } = await params
  const numero = Number.parseInt(docEntry, 10)

  if (!Number.isFinite(numero)) {
    return <NoEncontrada mensaje={`"${docEntry}" no es un numero de documento.`} />
  }

  const session = await getSession()
  if (!session) {
    return (
      <div className="ar-info" data-tone="danger">
        <span className="ar-info__label">Sin sesion</span>
        <p>Vuelve a entrar para ver esta orden.</p>
      </div>
    )
  }

  const resultado = await cargar(numero)

  if (!resultado.ok) {
    if (resultado.noExiste) return <NoEncontrada mensaje={resultado.error} />
    return (
      <>
        <div className="ar-page-head">
          <h1>Orden de compra</h1>
        </div>
        <div className="ar-info" data-tone="danger">
          <span className="ar-info__label">No hay conexion con Business One</span>
          <p>{resultado.error}</p>
          <p className="ar-small">
            <Link href="/ordenes">Volver a las ordenes</Link>
          </p>
        </div>
      </>
    )
  }

  const { oc } = resultado
  const interno = esInterno(session.roles)

  // 'No existe' y 'no es tuya' se responden igual: distinguirlas confirmaria que
  // esa orden existe y de quien es.
  if (!interno && oc.CardCode !== session.supplierCode) {
    return <NoEncontrada mensaje={`No hay ninguna orden con el numero ${numero}.`} />
  }

  const estatus = ESTATUS_SAP[oc.DocumentStatus] ?? { label: oc.DocumentStatus }
  const moneda = oc.DocCurrency ?? 'MXP'
  const lineas = oc.DocumentLines ?? []

  // Se pide DESPUES de comprobar que la orden es de este proveedor: antes seria
  // leer entregas de una orden que quiza no se puede ni enseñar.
  //
  // Son dos lecturas y no una porque responden a preguntas distintas:
  // `cargarEntradas` cuenta cuanto llego —incluye lo ya facturado— y alimenta la
  // tabla de recepcion; `cargarFacturables` dice cual se puede facturar todavia,
  // que es lo que hay que ofrecer al subir el CFDI. Van en paralelo: son dos
  // viajes a B1 que no dependen uno del otro.
  const [entradas, facturables] = await Promise.all([cargarEntradas(oc), cargarFacturables(oc)])
  const recepcion: Recepcion | null = entradas.ok
    ? calcularRecepcion({ orden: lineas.map(renglonDesdeB1), entradas: entradas.lineas })
    : null

  // Cronologico y en una sola lista: el proveedor quiere ver sus entregas por
  // fecha, no agrupadas por renglon. Las huerfanas van con las demas para que no
  // desaparezcan del recuento.
  const entregas = recepcion
    ? [...recepcion.renglones.flatMap((r) => r.entradas), ...recepcion.huerfanas].sort((a, b) =>
        a.fecha === b.fecha ? a.docNum - b.docNum : a.fecha < b.fecha ? -1 : 1,
      )
    : []

  // Facturas ya cargadas contra esta orden. Sin esto no habria forma de saber
  // desde aqui si ya se facturo, y se cargaria dos veces.
  const cargadas = await (await invoices())
    .find(
      { poNumber: String(oc.DocNum), supplierCode: oc.CardCode },
      { projection: { folio: 1, status: 1, xmlFileKey: 1, total: 1, createdAt: 1 } },
    )
    // Por fecha ascendente: el saldo corrido solo tiene sentido en el orden en
    // que se fueron cargando.
    .sort({ createdAt: 1 })
    .toArray()

  // Saldo corrido: cada factura descuenta del total de la orden y la siguiente
  // arranca de lo que quedo. Las devueltas y rechazadas NO descuentan —esa
  // cantidad vuelve a estar pendiente—, y la fila lo dice en vez de saltarselas
  // en silencio.
  const NO_DESCUENTAN: readonly string[] = ['RECHAZADA', 'DUPLICADA', 'EN_CORRECCION']
  const filas: Array<{
    folio: string
    status: string
    xmlFileKey?: string | null
    importe: number
    descuenta: boolean
    saldo: number
  }> = []
  // Bucle y no `map` con acumulador externo: el compilador de React prohibe
  // reasignar una variable desde dentro de un callback, y con razon —el momento
  // en que corre no esta garantizado—.
  for (const f of cargadas) {
    const importe = Number(fromDecimal128(f.total ?? null)?.toString() ?? 0)
    const descuenta = !NO_DESCUENTAN.includes(f.status)
    const anterior = filas.length > 0 ? filas[filas.length - 1].saldo : oc.DocTotal
    filas.push({
      folio: f.folio,
      status: f.status,
      xmlFileKey: f.xmlFileKey ?? null,
      importe,
      descuenta,
      saldo: descuenta ? anterior - importe : anterior,
    })
  }
  const saldo = filas.length > 0 ? filas[filas.length - 1].saldo : oc.DocTotal

  const cabecera: Array<[string, string]> = [
    ['Proveedor', `${oc.CardCode}${oc.CardName ? ` · ${oc.CardName}` : ''}`],
    ['Emitida', formatDate(oc.DocDate)],
    ['Vence', formatDate(oc.DocDueDate)],
    ['Moneda', moneda],
    ['Subtotal', `${money(oc.DocTotal - (oc.VatSum ?? 0))} ${moneda}`],
    ['Impuestos', `${money(oc.VatSum)} ${moneda}`],
    ['Total con IVA', `${money(oc.DocTotal)} ${moneda}`],
    ['Referencia del proveedor', oc.NumAtCard ?? '—'],
    ['DocEntry', String(oc.DocEntry)],
  ]

  return (
    <>
      <div className="ar-page-head">
        <div>
          <h1>OC {oc.DocNum}</h1>
          <p className="ar-lead" style={{ marginBottom: 0 }}>
            {oc.CardCode}
            {oc.CardName ? ` · ${oc.CardName}` : ''}
          </p>
        </div>
        <div className="ar-page-head__meta">
          <span className="ar-status" data-tone={estatus.tone}>
            {oc.Cancelled === 'tYES' ? 'Cancelada' : estatus.label}
          </span>
          <br />
          <span className="ar-meta">Business One · PurchaseOrders</span>
        </div>
      </div>

      <Link href="/ordenes" className="ar-btn" data-variant="secondary" style={{ marginBottom: 16 }}>
        Volver a las ordenes
      </Link>

      <section className="ar-section">
        <span className="ar-eyebrow">Datos de la orden</span>
        <table className="ar-table ar-matrix">
          <tbody>
            {cabecera.map(([label, valor]) => (
              <tr key={label}>
                <td>{label}</td>
                <td className="ar-code">{valor}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {!entradas.ok && (
        <div className="ar-info" data-tone="warn">
          <span className="ar-info__label">No se pudieron leer las entradas de mercancia</span>
          <p>{entradas.error}</p>
          <p className="ar-small">
            Sin ellas no se puede decir cuanta mercancia llego. Lo que Business One guarda en el
            renglon es lo que <em>falta</em>, y ese numero vale cero tanto si llego todo como si el
            renglon se cerro antes de tiempo.
          </p>
        </div>
      )}

      {entradas.ok && entradas.truncado && (
        <div className="ar-info" data-tone="warn">
          <span className="ar-info__label">Entregas recortadas</span>
          <p>
            Hay mas entradas de mercancia de las que se pudieron leer de una vez. Lo recibido que
            se muestra abajo es un minimo, no el total.
          </p>
        </div>
      )}

      {recepcion && recepcion.renglonesSinSurtir > 0 && (
        <div className="ar-info" data-tone="danger">
          <span className="ar-info__label">
            {recepcion.renglonesSinSurtir === 1
              ? 'Un renglon se cerro sin completarse'
              : `${recepcion.renglonesSinSurtir} renglones se cerraron sin completarse`}
          </span>
          <p>
            Faltaron <strong>{qty(recepcion.sinSurtir)}</strong> piezas que ya no se esperan. El
            renglon esta cerrado, asi que Business One dejo de contarlas como pendientes aunque
            nunca llegaran.
          </p>
        </div>
      )}

      {recepcion && recepcion.renglonesExcedidos > 0 && (
        <div className="ar-info" data-tone="warn">
          <span className="ar-info__label">
            {recepcion.renglonesExcedidos === 1
              ? 'Un renglon recibio mas de lo pedido'
              : `${recepcion.renglonesExcedidos} renglones recibieron mas de lo pedido`}
          </span>
          <p>
            Llegaron <strong>{qty(recepcion.excedente)}</strong> piezas de mas. No se restan de lo
            que falta en otros renglones: mandar de mas un articulo no surte el que vino corto.
          </p>
        </div>
      )}

      {recepcion && recepcion.huerfanas.length > 0 && (
        <div className="ar-info" data-tone="warn">
          <span className="ar-info__label">Entregas sin renglon</span>
          <p>
            {recepcion.huerfanas.length} entrega(s) de mercancia apuntan a esta orden pero no a
            ninguno de sus renglones. Salen listadas abajo y no se suman a ninguna linea.
          </p>
        </div>
      )}

      <section className="ar-section">
        <span className="ar-eyebrow">
          Lineas <span className="ar-num">{lineas.length}</span>
        </span>

        {recepcion &&
          (recepcion.sinEntradas ? (
            <p className="ar-lead">
              Todavia no hay ninguna entrada de mercancia contra esta orden: no ha llegado nada.
            </p>
          ) : (
            <p className="ar-lead">
              Se pidieron {qty(recepcion.pedido)} piezas y han llegado{' '}
              <strong>{qty(recepcion.recibido)}</strong> en {recepcion.entregas.length}{' '}
              {recepcion.entregas.length === 1 ? 'entrega' : 'entregas'}
              {recepcion.pendiente.gt(0) ? `. Siguen pendientes ${qty(recepcion.pendiente)}` : ''}.
            </p>
          ))}

        {lineas.length === 0 ? (
          <div className="ar-empty">
            <div className="ar-empty__title">Esta orden no tiene lineas en Business One.</div>
          </div>
        ) : (
          <div className="ar-table-scroll">
          <table className="ar-table ar-table--stack">
            <thead>
              <tr>
                <th>#</th>
                <th>Articulo</th>
                <th>Descripcion</th>
                <th className="ar-num">Pedido</th>
                <th className="ar-num">Recibido</th>
                <th className="ar-num">Falta</th>
                <th>Estado</th>
                <th className="ar-num">Precio</th>
                <th className="ar-num">Importe</th>
                <th className="ar-num">IVA</th>
              </tr>
            </thead>
            <tbody>
              {lineas.map((l) => {
                const r = recepcion?.renglones.find((x) => x.lineNum === l.LineNum)
                const estado = r ? ESTADO_RENGLON[r.estado] : undefined
                return (
                  <tr key={l.LineNum}>
                    <td className="ar-code" data-label="#">
                      {l.LineNum}
                    </td>
                    <td className="ar-code" data-label="Articulo">
                      {l.ItemCode ?? '—'}
                    </td>
                    <td data-label="Descripcion">{l.ItemDescription ?? '—'}</td>
                    <td className="ar-num" data-label="Pedido">
                      {qty(moneyOrZero(l.Quantity))}
                    </td>
                    {/* Sale de las entradas de mercancia, no de restarle a la
                        orden lo que falta: esa resta da por recibido lo que se
                        cerro sin llegar. */}
                    <td className="ar-num" data-label="Recibido">
                      {r ? qty(r.recibido) : '—'}
                    </td>
                    <td className="ar-num" data-label="Falta">
                      {r ? (r.pendiente.gt(0) ? qty(r.pendiente) : '—') : '—'}
                    </td>
                    <td data-label="Estado">
                      {estado ? (
                        <>
                          <span className="ar-status" data-tone={estado.tone}>
                            {estado.label}
                          </span>
                          {r && r.sinSurtir.gt(0) && (
                            <div className="ar-small ar-muted">
                              no llegaran {qty(r.sinSurtir)}
                            </div>
                          )}
                          {r && r.excedente.gt(0) && (
                            <div className="ar-small ar-muted">
                              {qty(r.excedente)} de mas
                            </div>
                          )}
                        </>
                      ) : (
                        <span className="ar-muted">—</span>
                      )}
                    </td>
                    <td className="ar-num" data-label="Precio">
                      {money(l.UnitPrice ?? l.Price)}
                    </td>
                    <td className="ar-num" data-label="Importe">
                      {money(l.LineTotal)}
                    </td>
                    <td className="ar-num" data-label="IVA">
                      {money(l.TaxTotal)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          </div>
        )}
      </section>

      {entregas.length > 0 && (
        <section className="ar-section">
          <span className="ar-eyebrow">
            Entradas de mercancia <span className="ar-num">{recepcion?.entregas.length ?? 0}</span>
          </span>
          <div className="ar-table-scroll">
          <table className="ar-table ar-table--stack">
            <thead>
              <tr>
                <th>Entrada</th>
                <th>Fecha</th>
                <th>Renglon</th>
                <th>Articulo</th>
                <th className="ar-num">Cantidad</th>
                <th>Almacen</th>
              </tr>
            </thead>
            <tbody>
              {entregas.map((e, i) => {
                const huerfana = !lineas.some((l) => l.LineNum === e.lineaOrden)
                return (
                  <tr key={`${e.docEntry}-${e.lineaOrden}-${i}`}>
                    <td className="ar-code" data-label="Entrada">
                      {e.docNum}
                    </td>
                    <td data-label="Fecha">{formatDate(e.fecha)}</td>
                    <td className="ar-code" data-label="Renglon">
                      {huerfana ? <span className="ar-muted">sin renglon</span> : e.lineaOrden}
                    </td>
                    <td className="ar-code" data-label="Articulo">
                      {e.itemCode ?? '—'}
                    </td>
                    <td className="ar-num" data-label="Cantidad">
                      {qty(e.cantidad)}
                    </td>
                    <td data-label="Almacen">{e.almacen ?? '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          </div>
          <p className="ar-small ar-muted">
            Cada renglon es una entrega registrada en Business One el dia que la mercancia entro al
            almacen. Es la unica cifra que dice cuanto llego de verdad; las devoluciones posteriores
            no se descuentan aqui.
          </p>
        </section>
      )}

      {cargadas.length > 0 && (
        <section className="ar-section">
          <span className="ar-eyebrow">
            Facturas ya cargadas <span className="ar-num">{cargadas.length}</span>
          </span>
          <table className="ar-table ar-table--stack">
            <thead>
              <tr>
                <th>Folio</th>
                <th>Estatus</th>
                <th className="ar-num">Importe</th>
                <th className="ar-num">Queda por facturar</th>
                <th>Archivo</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td colSpan={3} data-label="Orden">
                  Total de la orden
                </td>
                <td className="ar-num" data-label="Queda por facturar">
                  {money(oc.DocTotal)} {moneda}
                </td>
                <td />
              </tr>
              {filas.map((f) => (
                <tr key={f.folio}>
                  <td className="ar-code" data-label="Folio">
                    {f.folio}
                  </td>
                  <td data-label="Estatus">{f.status}</td>
                  <td className="ar-num" data-label="Importe">
                    {f.descuenta ? `− ${money(f.importe)}` : money(f.importe)}
                  </td>
                  <td className="ar-num" data-label="Queda por facturar">
                    {f.descuenta ? (
                      money(f.saldo)
                    ) : (
                      <span className="ar-muted">no descuenta</span>
                    )}
                  </td>
                  <td data-label="Archivo">
                    {f.xmlFileKey ? (
                      <a className="ar-code" href={`/api/v1/documents/${f.xmlFileKey}`}>
                        XML
                      </a>
                    ) : (
                      <span className="ar-muted">sin XML</span>
                    )}
                  </td>
                </tr>
              ))}
              <tr data-diff={Math.abs(saldo) >= 0.01 ? 'true' : undefined}>
                <td colSpan={3} data-label="Resultado">
                  {Math.abs(saldo) < 0.01
                    ? 'La orden queda cubierta por importe'
                    : saldo > 0
                      ? 'Falta por facturar'
                      : 'Se facturo de mas'}
                </td>
                <td className="ar-num" data-label="Queda por facturar">
                  {money(Math.abs(saldo))} {moneda}
                </td>
                <td />
              </tr>
            </tbody>
          </table>
          <p className="ar-small ar-muted">
            El saldo va por importe. El detalle por articulo —cuantas piezas faltan de cada linea—
            lo ve KPS al revisar la factura.
          </p>
        </section>
      )}

      <CargarXml
        docEntry={oc.DocEntry}
        docNum={String(oc.DocNum)}
        cardCode={oc.CardCode}
        moneda={moneda}
        totalOc={oc.DocTotal}
        cancelada={oc.Cancelled === 'tYES'}
        cerrada={oc.DocumentStatus !== 'bost_Open'}
        entradas={facturables.entradas}
        entradasTruncadas={facturables.truncado}
      />
    </>
  )
}
