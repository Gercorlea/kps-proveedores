import { getSapClient } from './index'

/**
 * Los dias de credito de cada grupo de condiciones de pago.
 *
 * POR QUE HACE FALTA TRADUCIRLO. `PaymentGroupCode` es una llave al catalogo
 * OCTG: el numero por si solo no dice nada —"11" no le dice nada a nadie— y
 * ensenarlo crudo obliga a saberse la tabla de memoria.
 *
 * SE LEE DEL DOCUMENTO, NO DEL PROVEEDOR. Las condiciones se heredan del socio
 * de negocio al crear la orden, pero pueden pactarse distinto para una compra
 * concreta, y entonces manda la del documento. Comprobado en la base de KPS: el
 * proveedor P0309 tiene 60 dias y su OC 1043 se pacto con pago anticipado —grupo
 * 20, "50% upon PO issue and 50% before shipment"—, asi que su factura vencio el
 * mismo dia. Ensenar los 60 dias del proveedor ahi seria mentir.
 *
 * Los meses adicionales se convierten a dias a 30 por mes. Es una aproximacion
 * —los meses no duran lo mismo—, pero esto es una etiqueta para leer de un
 * vistazo, no el calculo del vencimiento: ese lo hace B1 y viaja en
 * `DocDueDate`.
 */

export interface Plazo {
  readonly codigo: number
  readonly nombre: string
  readonly dias: number
}

/**
 * El catalogo entero, indexado por codigo.
 *
 * Una sola lectura para toda la pantalla: pedir el plazo de cada orden por
 * separado serian veinte viajes a B1 para pintar una tabla. El adaptador ya
 * memoiza el catalogo, asi que llamarlo de mas tampoco cuesta.
 *
 * Nunca lanza: sin catalogo se devuelve vacio y quien lo use pinta un guion. Una
 * orden sin etiqueta de plazo es un detalle que falta; una pantalla caida por no
 * poder leer un catalogo de adorno es un problema.
 */
export async function leerPlazos(): Promise<ReadonlyMap<number, Plazo>> {
  const mapa = new Map<number, Plazo>()
  try {
    for (const t of await getSapClient().listPaymentTermsTypes()) {
      mapa.set(t.GroupNumber, {
        codigo: t.GroupNumber,
        nombre: t.PaymentTermsGroupName,
        dias: (t.NumberOfAdditionalDays ?? 0) + (t.NumberOfAdditionalMonths ?? 0) * 30,
      })
    }
  } catch {
    return mapa
  }
  return mapa
}

/**
 * El plazo en palabras: "30 dias", "Contado", "—".
 *
 * Se ensena el NUMERO y no el nombre del grupo porque los nombres de KPS no
 * siempre lo dicen: su grupo 1 se llama "Contado" y son 30 dias, y el 20 se
 * llama "50% upon PO issue and 50% before shipment". El numero es el dato que
 * responde "cuando cobro".
 */
export function describirPlazo(
  plazos: ReadonlyMap<number, Plazo>,
  codigo: number | null | undefined,
): string {
  if (codigo === null || codigo === undefined) return '—'
  const p = plazos.get(codigo)
  if (!p) return `Codigo ${codigo}`
  if (p.dias === 0) return 'Contado'
  return `${p.dias} dias`
}
