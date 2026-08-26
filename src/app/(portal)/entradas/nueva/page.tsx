import Link from 'next/link'
import { getSession } from '@/lib/auth/server'
import { puedeCapturarEntradas, puedeTocarOrdenDe } from '@/lib/receipts/acceso'
import { leerRestricciones, motivoDeNoCaptura } from '@/lib/receipts/articulos'
import { moneyOrZero } from '@/lib/money'
import { leerOrdenParaEntrada, ReceiptError } from '@/lib/receipts/create'
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

function Aviso({ titulo, children }: { titulo: string; children?: React.ReactNode }) {
  return (
    <>
      <div className="ar-page-head">
        <h1>Registrar entrada</h1>
      </div>
      <div className="ar-empty">
        <div className="ar-empty__title">{titulo}</div>
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
      <div className="ar-info" data-tone="danger">
        <span className="ar-info__label">Sin sesión</span>
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
  const restricciones = await leerRestricciones(
    (orden.DocumentLines ?? []).map((l) => l.ItemCode).filter((c): c is string => Boolean(c)),
  )
  const impedimentos = [...restricciones.values()]
    .map(motivoDeNoCaptura)
    .filter((m): m is string => m !== null)

  // El estado de la orden se comprueba aqui y no solo al enviar: pintar el
  // formulario de una orden cerrada seria invitar a teclear cantidades que B1
  // va a rechazar al final.
  const cerrada = orden.DocumentStatus !== 'bost_Open'
  const cancelada = orden.Cancelled === 'tYES'

  const renglones: RenglonOc[] = (orden.DocumentLines ?? []).map((l) => {
    const pedido = moneyOrZero(l.Quantity)
    // Cuando B1 no manda `RemainingOpenQuantity` se asume que todo sigue
    // abierto: es el limite mas permisivo, y el servidor lo vuelve a comprobar
    // al crear la entrada.
    const pendiente =
      l.RemainingOpenQuantity === null || l.RemainingOpenQuantity === undefined
        ? pedido
        : moneyOrZero(l.RemainingOpenQuantity)
    return {
      lineNum: l.LineNum,
      itemCode: l.ItemCode ?? null,
      descripcion: l.ItemDescription ?? l.ItemCode ?? `Renglón ${l.LineNum}`,
      pedido: pedido.toNumber(),
      pendiente: pendiente.toNumber(),
      unidad: l.MeasureUnit ?? l.UoMCode ?? null,
      // Lo dice el maestro de articulos, no el formulario. El servidor lo
      // vuelve a comprobar al crear: esto solo decide que campos se pintan.
      pideLote: l.ItemCode ? (restricciones.get(l.ItemCode)?.lote ?? false) : false,
    }
  })

  const porRecibir = renglones.filter((r) => r.pendiente > 0)

  return (
    <>
      <div className="ar-page-head">
        <div>
          <h1>Registrar entrada · OC {orden.DocNum}</h1>
          <p className="ar-lead" style={{ marginBottom: 0 }}>
            {orden.CardCode}
            {orden.CardName ? ` · ${orden.CardName}` : ''}
          </p>
        </div>
        <div className="ar-page-head__meta">
          <span className="ar-meta">Business One · PurchaseDeliveryNotes</span>
          <br />
          <span className="ar-meta">
            {porRecibir.length} de {renglones.length}{' '}
            {renglones.length === 1 ? 'renglón' : 'renglones'} por recibir
          </span>
        </div>
      </div>

      <Link
        href={`/ordenes/${orden.DocEntry}`}
        className="ar-btn"
        data-variant="secondary"
        style={{ marginBottom: 16 }}
      >
        Ver la orden completa
      </Link>

      {(cancelada || cerrada) && (
        <div className="ar-info" data-tone="danger">
          <span className="ar-info__label">
            {cancelada ? 'Esta orden está cancelada' : 'Esta orden ya no está abierta'}
          </span>
          <p>Business One no acepta entradas contra ella, así que no hay nada que capturar aquí.</p>
        </div>
      )}

      {!cancelada && !cerrada && renglones.length === 0 && (
        <div className="ar-info" data-tone="warn">
          <span className="ar-info__label">La orden no tiene renglones</span>
          <p>Business One devolvió esta orden sin líneas: no hay nada que recibir.</p>
        </div>
      )}

      {!cancelada && !cerrada && renglones.length > 0 && porRecibir.length === 0 && (
        <div className="ar-info" data-tone="ok">
          <span className="ar-info__label">Ya llegó todo</span>
          <p>
            Ningún renglón de esta orden sigue abierto. La mercancía está completa y la orden puede
            facturarse.
          </p>
        </div>
      )}

      {/* Articulos que Business One no admite en una entrada. Se ensena en lugar
          del formulario, no encima de el: dejar teclear cantidades que van a ser
          rechazadas es peor que decir que no desde el principio. */}
      {!cancelada && !cerrada && porRecibir.length > 0 && impedimentos.length > 0 && (
        <div className="ar-info" data-tone="danger">
          <span className="ar-info__label">
            Esta orden no se puede capturar desde el portal
          </span>
          {impedimentos.map((m) => (
            <p key={m}>{m}</p>
          ))}
          <p className="ar-small ar-muted">
            Registrala directamente en Business One. En cuanto la entrada exista alli, aparecera
            en la pantalla de la orden y el proveedor podra facturar contra ella.
          </p>
        </div>
      )}

      {!cancelada && !cerrada && porRecibir.length > 0 && impedimentos.length === 0 && (
        <>
          <div className="ar-info">
            <span className="ar-info__label">Qué hace esto</span>
            <p>
              Crea el documento de entrada en Business One copiando los renglones de esta orden.
              Business One descuenta lo recibido y, a partir de ahí, la factura del proveedor se
              puede cotejar contra lo que llegó de verdad.
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
