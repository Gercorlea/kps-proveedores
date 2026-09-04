import Link from 'next/link'
import { getSession } from '@/lib/auth/server'
import { puedeCapturarEntradas, puedeTocarOrdenDe } from '@/lib/receipts/acceso'
import { leerRestricciones, motivoDeNoCaptura } from '@/lib/receipts/articulos'
import { moneyOrZero } from '@/lib/money'
import { calcularRecepcion, renglonDesdeB1, type LineaEntrada } from '@/lib/matching/recepciones'
import { leerOrdenParaEntrada, ReceiptError } from '@/lib/receipts/create'
import { leerEntradasDeOrdenes } from '@/lib/sap/entradas'
import Captura, { type RenglonOc } from './captura'

/**
 * P04c · Registrar una entrada de mercancia.
 *
 * Se llega con `?oc=<DocEntry>` desde /entradas o desde la orden. La orden se
 * lee de Business One aqui, en el servidor, y sus renglones bajan al formulario
 * como props: el cliente nunca decide de que orden se trata ni de quien es.
 *
 * SOLO INTERNOS. Segunda capa del guard de §06 —la primera es el menu, la
 * tercera la ruta de API—. Un proveedor que teclee la URL a mano se topa aqui.
 */
export const dynamic = 'force-dynamic'

interface Props {
  searchParams: Promise<{ oc?: string }>
}

/**
 * Las entradas de mercancia ya registradas contra esta orden.
 *
 * Devuelve `null` —no una lista vacia— cuando B1 no contesta, porque las dos
 * cosas significan lo contrario: vacia es "no ha llegado nada" y hay que ofrecer
 * la orden entera; sin respuesta es "no se sabe", y confundirlas apagaria el
 * formulario de una orden que si se puede recibir.
 */
async function leerRecibidas(
  docEntry: number,
  docDate: string | null | undefined,
  cardCode: string,
): Promise<readonly LineaEntrada[] | null> {
  try {
    const { porOrden } = await leerEntradasDeOrdenes({
      ordenes: [{ DocEntry: docEntry, DocDate: docDate }],
      cardCode,
    })
    return porOrden.get(docEntry) ?? []
  } catch {
    return null
  }
}

function Aviso({ titulo, children }: { titulo: string; children?: React.ReactNode }) {
  return (
    <>
      <div className="cr-page-head">
        <h1>Registrar entrada</h1>
      </div>
      <div className="cr-empty">
        <div className="cr-empty__title">{titulo}</div>
        {children}
      </div>
    </>
  )
}

export default async function Page({ searchParams }: Props) {
  const { oc: crudo } = await searchParams

  const session = await getSession()
  if (!session) {
    return (
      <div className="cr-info" data-tone="danger">
        <span className="cr-info__label">Sin sesión</span>
        <p>Vuelve a entrar para registrar una entrada.</p>
      </div>
    )
  }

  if (!puedeCapturarEntradas(session)) {
    return (
      <Aviso titulo="Esta sección es de KPS.">
        <p>
          Las entradas de mercancía las registra almacén, no el proveedor. Si esperas una factura,
          ve a <Link href="/facturas">tus facturas</Link>.
        </p>
      </Aviso>
    )
  }

  const docEntry = Number.parseInt(crudo ?? '', 10)
  if (!Number.isFinite(docEntry)) {
    return (
      <Aviso titulo="No dijiste contra qué orden.">
        <p>
          Elige una orden en <Link href="/entradas">la lista de órdenes por recibir</Link>.
        </p>
      </Aviso>
    )
  }

  let orden
  try {
    orden = await leerOrdenParaEntrada(docEntry)
  } catch (error) {
    if (error instanceof ReceiptError) {
      return (
        <Aviso titulo={error.message}>
          <p>
            <Link href="/entradas">Volver a las órdenes por recibir</Link>
          </p>
        </Aviso>
      )
    }
    throw error
  }

  // De quien es la orden. Con `FEATURE_ENTRADAS_PROVEEDOR` encendida esta
  // pantalla la ve tambien un proveedor, y el `?oc=` viaja en la URL: sin esta
  // comprobacion bastaria teclear otro numero para ver los renglones, cantidades
  // y precios de la orden de otra empresa.
  //
  // Se responde "no existe" y no "no es tuya": distinguirlos confirmaria que esa
  // orden existe y de quien es.
  if (!puedeTocarOrdenDe(session, orden.CardCode)) {
    return (
      <Aviso titulo={`No hay ninguna orden con el numero ${docEntry}.`}>
        <p>
          <Link href="/entradas">Volver a las órdenes por recibir</Link>
        </p>
      </Aviso>
    )
  }

  // Articulos que B1 no admite en una entrada. Se pregunta ANTES de pintar el
  // formulario: el rechazo de B1 llega como un error de HANA con el numero de
  // linea de un procedimiento almacenado, y descubrirlo despues de teclear las
  // cantidades convierte un aviso en trabajo perdido.
  //
  // Una lectura fallida no bloquea —el mapa vuelve vacio— y decide B1 al crear.
  //
  // Va en paralelo con las entradas ya registradas: son dos viajes a B1 que no
  // dependen uno del otro y encadenarlos solo sumaria latencia al formulario.
  const [restricciones, recibidas] = await Promise.all([
    leerRestricciones(
      (orden.DocumentLines ?? []).map((l) => l.ItemCode).filter((c): c is string => Boolean(c)),
    ),
    leerRecibidas(orden.DocEntry, orden.DocDate, orden.CardCode),
  ])
  const impedimentos = [...restricciones.values()]
    .map(motivoDeNoCaptura)
    .filter((m): m is string => m !== null)

  // El estado de la orden se comprueba aqui y no solo al enviar: pintar el
  // formulario de una orden cerrada seria invitar a teclear cantidades que B1
  // va a rechazar al final.
  const cerrada = orden.DocumentStatus !== 'bost_Open'
  const cancelada = orden.Cancelled === 'tYES'

  const lineas = orden.DocumentLines ?? []

  // Cuanto se puede capturar de verdad en cada renglon.
  //
  // No se lee de `RemainingOpenQuantity` directamente porque ese campo miente en
  // los dos sentidos —ver `recibible` en el modulo de recepciones—. Se cruza con
  // las entradas ya registradas para no ofrecer mercancia que B1 rechazaria
  // despues de teclear las cantidades.
  //
  // Si B1 no contesto las entradas, `recibidas` es null y se cae al campo crudo:
  // es el limite mas permisivo, y `crearEntradaDeMercancia` lo vuelve a
  // comprobar. Perder un dato no justifica bloquear una captura legitima.
  const recepcion = recibidas
    ? calcularRecepcion({ orden: lineas.map(renglonDesdeB1), entradas: recibidas })
    : null
  const recibiblePorRenglon = new Map(
    (recepcion?.renglones ?? []).map((r) => [r.lineNum, r.recibible.toNumber()]),
  )

  const renglones: RenglonOc[] = lineas.map((l) => {
    const pedido = moneyOrZero(l.Quantity)
    // Cuando B1 no manda `RemainingOpenQuantity` se asume que todo sigue
    // abierto: es el limite mas permisivo, y el servidor lo vuelve a comprobar
    // al crear la entrada.
    const abierta =
      l.RemainingOpenQuantity === null || l.RemainingOpenQuantity === undefined
        ? pedido
        : moneyOrZero(l.RemainingOpenQuantity)
    const pendiente = recibiblePorRenglon.get(l.LineNum) ?? abierta.toNumber()
    return {
      lineNum: l.LineNum,
      itemCode: l.ItemCode ?? null,
      descripcion: l.ItemDescription ?? l.ItemCode ?? `Renglón ${l.LineNum}`,
      pedido: pedido.toNumber(),
      pendiente,
      unidad: l.MeasureUnit ?? l.UoMCode ?? null,
      // Lo dice el maestro de articulos, no el formulario. El servidor lo
      // vuelve a comprobar al crear: esto solo decide que campos se pintan.
      pideLote: l.ItemCode ? (restricciones.get(l.ItemCode)?.lote ?? false) : false,
    }
  })

  const porRecibir = renglones.filter((r) => r.pendiente > 0)

  return (
    <>
      <div className="cr-page-head">
        <div>
          <h1>Registrar entrada · OC {orden.DocNum}</h1>
          <p className="cr-lead cr-flush">
            {orden.CardCode}
            {orden.CardName ? ` · ${orden.CardName}` : ''}
          </p>
        </div>
        <div className="cr-page-head__meta">
          <span className="cr-meta">Business One · PurchaseDeliveryNotes</span>
          <br />
          <span className="cr-meta">
            {porRecibir.length} de {renglones.length}{' '}
            {renglones.length === 1 ? 'renglón' : 'renglones'} por recibir
          </span>
        </div>
      </div>

      <Link
        href={`/ordenes/${orden.DocEntry}`}
        className="cr-btn cr-mb-4"
        data-variant="secondary"
      >
        Ver la orden completa
      </Link>

      {(cancelada || cerrada) && (
        <div className="cr-info" data-tone="danger">
          <span className="cr-info__label">
            {cancelada ? 'Esta orden está cancelada' : 'Esta orden ya no está abierta'}
          </span>
          <p>Business One no acepta entradas contra ella, así que no hay nada que capturar aquí.</p>
        </div>
      )}

      {!cancelada && !cerrada && renglones.length === 0 && (
        <div className="cr-info" data-tone="warn">
          <span className="cr-info__label">La orden no tiene renglones</span>
          <p>Business One la devolvió sin líneas. No hay nada que recibir.</p>
        </div>
      )}

      {!cancelada && !cerrada && renglones.length > 0 && porRecibir.length === 0 && (
        <div className="cr-info" data-tone="ok">
          <span className="cr-info__label">Ya llegó todo</span>
          <p>Ningún renglón sigue abierto. La orden ya se puede facturar.</p>
        </div>
      )}

      {/* Articulos que Business One no admite en una entrada. Se ensena en lugar
          del formulario, no encima de el: dejar teclear cantidades que van a ser
          rechazadas es peor que decir que no desde el principio. */}
      {!cancelada && !cerrada && porRecibir.length > 0 && impedimentos.length > 0 && (
        <div className="cr-info" data-tone="danger">
          <span className="cr-info__label">
            Esta orden no se puede capturar desde el portal
          </span>
          {impedimentos.map((m) => (
            <p key={m}>{m}</p>
          ))}
          <p className="cr-small cr-muted">
            Regístrala en Business One. Desde ahí el proveedor ya puede facturar contra ella.
          </p>
        </div>
      )}

      {!cancelada && !cerrada && porRecibir.length > 0 && impedimentos.length === 0 && (
        <>
          <div className="cr-info">
            <span className="cr-info__label">Qué hace esto</span>
            <p>
              Crea la entrada en Business One copiando los renglones de esta orden. Business One
              descuenta lo recibido, y la factura del proveedor se coteja contra lo que llegó.
            </p>
          </div>

          <Captura
            poDocEntry={orden.DocEntry}
            docNum={orden.DocNum}
            cardCode={orden.CardCode}
            cardName={orden.CardName ?? null}
            renglones={renglones}
            hoy={new Date().toISOString().slice(0, 10)}
          />
        </>
      )}
    </>
  )
}
