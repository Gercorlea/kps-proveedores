import { consultarLista69b } from './lista69b'
import { consultarSat } from './sat'
import type { ParsedCfdi } from './types'
import type { Validacion } from './validations'

/**
 * Las validaciones que salen a la red (§12.2 reglas SAT_VIGENTE y LISTA_69B).
 *
 * VIVEN APARTE DE `validations.ts` A PROPOSITO. Aquel modulo es una funcion pura
 * y se prueba sin nada montado; meterle una llamada al SAT lo convertiria en
 * algo que solo se puede probar con red, y a la larga en algo que nadie prueba.
 *
 * REGLA DE ORO: UN FALLO DE RED NO ES UN RECHAZO. El SAT se cae, y el CSV del
 * 69-B a veces no se puede bajar. Cuando eso pasa la regla se reporta como
 * INFO/no comprobada, nunca como BLOQUEANTE fallida. Rechazar la factura de un
 * proveedor porque el servicio publico del SAT tuvo un mal minuto le carga a el
 * un problema que no es suyo y que no puede arreglar.
 *
 * ES LO QUE SE CORRE UNA VEZ, AL CARGAR. No en cada pantallazo: las dos
 * consultas cachean por su cuenta, pero la que importa es la del momento en que
 * la factura entra al portal, porque es la que queda escrita en
 * `validationResults` como constancia de que se miro.
 */

/**
 * Corre SAT_VIGENTE y LISTA_69B. Nunca lanza.
 *
 * Las dos consultas van en paralelo: son independientes y encadenarlas sumaria
 * el peor caso de las dos a la espera del proveedor.
 */
export async function validarExterno(cfdi: ParsedCfdi): Promise<Validacion[]> {
  const [sat, efos] = await Promise.all([
    consultarSat({
      uuid: cfdi.timbre.uuid,
      rfcEmisor: cfdi.emisor.rfc,
      rfcReceptor: cfdi.receptor.rfc,
      total: cfdi.total,
      sello: cfdi.sello,
    }),
    consultarLista69b(cfdi.emisor.rfc),
  ])

  const validaciones: Validacion[] = []

  // --- SAT_VIGENTE --------------------------------------------------------
  if (sat.estado === 'VIGENTE') {
    validaciones.push({
      regla: 'SAT_VIGENTE',
      severidad: 'BLOQUEANTE',
      pasa: true,
      detalle: `El SAT confirma el folio ${cfdi.timbre.uuid} como vigente${sat.deCache ? ' (consultado hace menos de un dia)' : ''}.`,
    })
  } else if (sat.estado === 'CANCELADO') {
    validaciones.push({
      regla: 'SAT_VIGENTE',
      severidad: 'BLOQUEANTE',
      pasa: false,
      detalle: `El SAT tiene esta factura como CANCELADA${sat.estatusCancelacion ? ` (${sat.estatusCancelacion})` : ''}. Una factura cancelada no se puede pagar ni deducir: vuelve a timbrarla y sube el CFDI nuevo.`,
    })
  } else if (sat.estado === 'NO_ENCONTRADO') {
    validaciones.push({
      regla: 'SAT_VIGENTE',
      severidad: 'BLOQUEANTE',
      pasa: false,
      detalle: `El SAT no encuentra el folio fiscal ${cfdi.timbre.uuid}. O el comprobante no llego a timbrarse, o los datos del XML no son los que se timbraron.`,
    })
  } else {
    // INDETERMINADO. No se sabe, y no saber no es lo mismo que estar mal.
    validaciones.push({
      regla: 'SAT_VIGENTE',
      severidad: 'INFO',
      pasa: false,
      detalle:
        `No se pudo comprobar con el SAT. ${sat.motivo ?? ''} La factura sigue adelante, pero nadie ha confirmado que este vigente.`.trim(),
    })
  }

  // --- LISTA_69B ----------------------------------------------------------
  // El SAT devuelve `ValidacionEFOS` en la misma consulta del comprobante: `200`
  // significa limpio. Sirve de segunda fuente cuando el CSV no se pudo bajar.
  const efosSegunSat = Boolean(sat.validacionEfos && sat.validacionEfos.trim() !== '200')

  if (efos.motivo && !sat.validacionEfos) {
    validaciones.push({
      regla: 'LISTA_69B',
      severidad: 'INFO',
      pasa: false,
      detalle: `No se pudo comprobar si ${cfdi.emisor.rfc} esta en la lista del 69-B. ${efos.motivo}`,
    })
  } else if (efos.situacion === 'DEFINITIVO') {
    validaciones.push({
      regla: 'LISTA_69B',
      severidad: 'BLOQUEANTE',
      pasa: false,
      detalle: `El SAT tiene a ${cfdi.emisor.rfc} en la lista del articulo 69-B como DEFINITIVO. Sus comprobantes no producen efecto fiscal: KPS no puede deducir esta factura ni acreditar su IVA, ni siquiera pagandola.`,
    })
  } else if (efos.situacion === 'PRESUNTO') {
    validaciones.push({
      regla: 'LISTA_69B',
      severidad: 'ADVERTENCIA',
      pasa: false,
      detalle: `El SAT tiene a ${cfdi.emisor.rfc} como PRESUNTO en la lista del 69-B. Todavia puede desvirtuar la presuncion, pero si acaba en definitivo esta factura deja de ser deducible con efecto retroactivo. Que lo vea cuentas por pagar antes de aprobar.`,
    })
  } else if (efosSegunSat) {
    // El CSV no lo tiene senalado pero el SAT si. Puede pasar con una
    // publicacion mas nueva que la copia descargada.
    validaciones.push({
      regla: 'LISTA_69B',
      severidad: 'ADVERTENCIA',
      pasa: false,
      detalle: `El SAT devolvio ValidacionEFOS "${sat.validacionEfos}" para este comprobante, que no es el "200" de un emisor limpio. Que lo revise cuentas por pagar antes de aprobar.`,
    })
  } else if (efos.situacion === 'DESVIRTUADO' || efos.situacion === 'SENTENCIA_FAVORABLE') {
    validaciones.push({
      regla: 'LISTA_69B',
      severidad: 'INFO',
      pasa: true,
      detalle: `${cfdi.emisor.rfc} aparecio en la lista del 69-B pero la desvirtuo (${efos.situacion === 'DESVIRTUADO' ? 'desvirtuado' : 'sentencia favorable'}). Sus comprobantes valen.`,
    })
  } else {
    const cuando = efos.listaDescargadaEl?.toISOString().slice(0, 10)
    validaciones.push({
      regla: 'LISTA_69B',
      severidad: 'BLOQUEANTE',
      pasa: true,
      detalle: efos.rfcEnLista
        ? `${cfdi.emisor.rfc} no esta en la lista del 69-B (${efos.rfcEnLista.toLocaleString('es-MX')} RFC, descargada el ${cuando}).`
        : `${cfdi.emisor.rfc} no esta senalado por el SAT.`,
    })
  }

  return validaciones
}
