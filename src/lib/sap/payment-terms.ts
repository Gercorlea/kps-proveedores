import { getSapClient } from './index'

/**
 * `PayTermsGrpCode` del socio de negocio es una llave foranea a la tabla OCTG.
 * El numero por si solo no significa nada —"9" no le dice nada a nadie—, asi
 * que se resuelve contra el catalogo y se deja el codigo entre parentesis para
 * quien tenga que buscarlo en SAP.
 *
 * Vive aparte porque lo necesitan dos sitios: la ficha de la pantalla de
 * proveedores y el registro en Mongo, que guarda el texto ya resuelto.
 */
export async function describePaymentTerms(code: number | null | undefined): Promise<string> {
  if (code === null || code === undefined) return '—'
  try {
    const catalogo = await getSapClient().listPaymentTermsTypes()
    const term = catalogo.find((t) => t.GroupNumber === code)
    if (!term) return `Codigo ${code} (no esta en el catalogo)`
    const dias = term.NumberOfAdditionalDays ?? 0
    const meses = term.NumberOfAdditionalMonths ?? 0
    const plazo = meses > 0 ? `${meses} mes${meses === 1 ? '' : 'es'} y ${dias} dias` : `${dias} dias`
    return `${term.PaymentTermsGroupName} · ${plazo} (codigo ${code})`
  } catch {
    // El catalogo es un adorno: si B1 no responde, el codigo crudo basta para
    // no tumbar la pantalla ni el registro.
    return `Codigo ${code}`
  }
}
