import { getSapClient } from '../sap'

/**
 * Que impide recibir un articulo desde el portal.
 *
 * POR QUE EXISTE. B1 rechaza ciertos articulos en una entrada de mercancia con
 * mensajes que no le dicen nada a quien captura:
 *
 *   - No inventariable (`InventoryItem: tNO`): no tiene cuentas de almacen, asi
 *     que la personalizacion de KPS falla al buscarlas y responde
 *     `[1299] no data found: "SBO_SP_TRANSACTIONNOTIFICATION" line 47`. De ahi
 *     nadie deduce que el problema es el articulo.
 *   - Por numero de serie: exige identificar pieza por pieza, y esta pantalla no
 *     lo captura. B1 responde "Cannot add row without complete selection of
 *     batch/serial numbers", en ingles y sin decir de que articulo.
 *
 * EL LOTE YA NO ES UN IMPEDIMENTO. La pantalla lo captura y `create.ts` lo manda
 * en `BatchNumbers`; aqui solo se informa para que el formulario sepa que
 * renglones tienen que pedirlo.
 *
 * El coste de averiguarlo despues es alto: se teclean cantidades, se pulsa
 * guardar, y llega un error de base de datos. Preguntarlo antes cuesta una
 * lectura del maestro de articulos.
 *
 * NO SUSTITUYE AL RECHAZO DE B1. B1 sigue siendo la autoridad —puede haber
 * motivos que esto no cubre— y por eso una lectura fallida NO bloquea: se deja
 * pasar y que decida B1. Inventarse un bloqueo por un mal minuto del Service
 * Layer impediria capturar entradas legitimas.
 */

export interface RestriccionArticulo {
  readonly itemCode: string
  /** `InventoryItem`. Si es false, no puede entrar por una entrada de mercancia. */
  readonly inventariable: boolean
  readonly lote: boolean
  readonly serie: boolean
}

/**
 * Si este articulo se puede capturar hoy desde el portal.
 *
 * El LOTE ya no impide nada: la pantalla lo captura y `create.ts` lo manda en
 * `BatchNumbers`. Lo que sigue fuera son los no inventariables —no tienen donde
 * registrarse— y los de numero de serie, que exigen identificar pieza por pieza.
 */
export function sePuedeCapturar(r: RestriccionArticulo): boolean {
  return r.inventariable && !r.serie
}

/**
 * El motivo, en palabras, o null si no hay ninguno.
 *
 * Solo el motivo: que hacer al respecto lo dice la pantalla una vez, debajo de
 * la lista. Repetirlo en cada renglon daba tres veces "registralo en Business
 * One" para una orden con tres articulos malos.
 */
export function motivoDeNoCaptura(r: RestriccionArticulo): string | null {
  if (!r.inventariable) {
    return `${r.itemCode} no es artículo de inventario. Business One no lo admite en una entrada de mercancía, y ese renglón se factura sin ella.`
  }
  if (r.serie) {
    return `${r.itemCode} se maneja por número de serie, y esta pantalla todavía no los captura.`
  }
  return null
}

/**
 * Lee las restricciones de varios articulos de una vez.
 *
 * Los que no se pudieron leer NO aparecen en el mapa, y quien llama debe
 * tratarlos como "sin restriccion conocida".
 */
export async function leerRestricciones(
  codigos: readonly string[],
): Promise<Map<string, RestriccionArticulo>> {
  const mapa = new Map<string, RestriccionArticulo>()
  const unicos = [...new Set(codigos.filter((c) => c && c.trim() !== ''))]
  if (unicos.length === 0) return mapa

  try {
    for (const it of await getSapClient().listItems(unicos)) {
      mapa.set(it.ItemCode, {
        itemCode: it.ItemCode,
        // Ausente se toma como `true`: el default de B1 es articulo de
        // inventario, y asumir lo contrario bloquearia por un $select corto.
        inventariable: it.InventoryItem !== 'tNO',
        lote: it.ManageBatchNumbers === 'tYES',
        serie: it.ManageSerialNumbers === 'tYES',
      })
    }
  } catch {
    return mapa
  }
  return mapa
}

/**
 * Los motivos que impiden capturar estos renglones, uno por articulo afectado.
 *
 * Vacio significa "adelante": o no hay restricciones, o no se pudieron leer y
 * decide B1.
 */
export async function motivosQueImpidenCapturar(
  codigos: readonly string[],
): Promise<readonly string[]> {
  const restricciones = await leerRestricciones(codigos)
  const motivos: string[] = []
  for (const r of restricciones.values()) {
    const motivo = motivoDeNoCaptura(r)
    if (motivo) motivos.push(motivo)
  }
  return motivos
}
