import type { SessionPayload } from '../auth/session'
import { esInterno } from '../auth/session'
import { getConfig } from '../config'

/**
 * Quien puede capturar entradas de mercancia.
 *
 * POR QUE VIVE AQUI Y NO REPETIDO EN CADA GUARD. La regla la comprueban cuatro
 * sitios —el menu, /entradas, /entradas/nueva y la ruta de API— y una bandera de
 * entorno leida cuatro veces es una bandera que tarde o temprano se enciende en
 * tres. Un permiso que discrepa entre la pantalla y la API es peor que no
 * tenerlo: la pantalla ofrece algo que la API rechaza, o —mucho peor— la API
 * acepta algo que la pantalla ya no ofrece y nadie lo revisa.
 *
 * POR OMISION SOLO INTERNOS. En la operacion real la entrada la registra almacen
 * cuando el camion descarga: es la constancia de KPS de que el material llego, y
 * es la mitad del cotejo (§06). Si la captura el proveedor, el cotejo deja de
 * comparar dos fuentes independientes —lo recibido contra lo facturado— para
 * comparar al proveedor consigo mismo, y deja de detectar nada.
 *
 * `FEATURE_ENTRADAS_PROVEEDOR=true` lo abre para poder recorrer el flujo entero
 * con una sola sesion en pruebas. NO debe encenderse en produccion.
 */
export function puedeCapturarEntradas(session: SessionPayload): boolean {
  if (esInterno(session.roles)) return true
  if (!getConfig().goodsReceipts.supplierCanCapture) return false
  // Un no-interno sin proveedor asignado no tiene ordenes propias contra las que
  // capturar: dejarlo pasar seria abrirle las de todos.
  return Boolean(session.supplierCode)
}

/**
 * Si esta sesion puede tocar la orden de este proveedor.
 *
 * Es la segunda mitad del permiso y no se puede omitir: `puedeCapturarEntradas`
 * dice si la seccion esta abierta, esta dice contra QUE ordenes. Sin ella, un
 * proveedor con la bandera encendida podria capturar una entrada contra la orden
 * de otra empresa —el `poDocEntry` viaja en el cuerpo de la peticion— y B1 lo
 * aceptaria sin rechistar, porque la orden existe.
 */
export function puedeTocarOrdenDe(session: SessionPayload, cardCode: string): boolean {
  if (esInterno(session.roles)) return true
  return Boolean(session.supplierCode) && session.supplierCode === cardCode
}

/** El texto que se le ensena a quien no puede entrar. */
export const MOTIVO_SIN_ACCESO =
  'Las entradas de mercancia las registra KPS cuando el material llega al almacen.'
