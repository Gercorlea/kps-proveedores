import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth/server'
import { getConfig } from '@/lib/config'
import { parseCfdi } from '@/lib/cfdi/parser'
import { CfdiParseError, TIPO_NOTA_CREDITO } from '@/lib/cfdi/types'
import {
  bloqueantes,
  pendientes as reglasPendientes,
  validarCfdi,
  type ContextoValidacion,
} from '@/lib/cfdi/validations'
import { invoices, suppliers } from '@/lib/mongo'

/**
 * POST /api/v1/cfdi/parse
 *
 * Extrae los datos fiscales de un CFDI 4.0 y corre las validaciones que no
 * dependen de nada externo. §04 principio 5: "cero captura manual de datos
 * fiscales" — el proveedor sube el archivo y el portal lee, no pregunta.
 *
 * ALCANCE: esto NO guarda la factura. Es la vista previa de P06 —el proveedor
 * suelta el XML y ve lo que el portal leyo antes de decidir si lo envia—; quien
 * guarda es POST /invoices, que vuelve a parsear y a validar por su cuenta.
 *
 * Las reglas las aplica `@/lib/cfdi/validations`, el mismo modulo que usa el
 * envio definitivo. Compartirlo es lo que impide que esta pantalla diga "todo
 * correcto" y el envio rechace despues por una regla que aqui no existia.
 *
 * Lo que no se pudo comprobar sale en `pendientes`, nunca como un "pasa"
 * gratis, para que nadie confunda "paso lo que se pudo revisar" con "la factura
 * es valida".
 */

export const runtime = 'nodejs'

const MAX_BYTES = 5 * 1024 * 1024

function problem(status: number, title: string, detail: string, extra: object = {}) {
  // RFC 7807, como pide §13.
  return NextResponse.json(
    { type: 'about:blank', title, status, detail, ...extra },
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  )
}

/**
 * Lo que se sabe al momento de mirar este XML.
 *
 * Con sesion de proveedor se pueden correr dos reglas mas —que la factura sea
 * suya y que su cuenta este activa— y comprobar el duplicado en el portal. Si la
 * base no responde, el contexto se queda corto y esas reglas se reportan como
 * pendientes: preferible a dar por bueno lo que no se miro.
 */
async function contexto(): Promise<ContextoValidacion> {
  const base: ContextoValidacion = { rfcKps: getConfig().kps.taxId }
  const session = await getSession()
  if (!session?.supplierCode) return base

  try {
    const proveedor = await (await suppliers()).findOne({ supplierCode: session.supplierCode })
    if (!proveedor) return base
    return {
      ...base,
      proveedor: {
        taxId: proveedor.taxId,
        legalName: proveedor.legalName,
        status: proveedor.status,
        blocked: proveedor.blocked,
        blockReason: proveedor.blockReason,
      },
    }
  } catch (error) {
    console.warn('[cfdi/parse] no se pudo leer el proveedor de la sesion:', error)
    return base
  }
}

async function uuidYaCargado(uuid: string): Promise<boolean | undefined> {
  try {
    return (await (await invoices()).countDocuments({ uuid }, { limit: 1 })) > 0
  } catch (error) {
    console.warn('[cfdi/parse] no se pudo comprobar el duplicado:', error)
    return undefined
  }
}

export async function POST(request: Request) {
  let file: File | null = null

  try {
    const form = await request.formData()
    const entry = form.get('xml')
    file = entry instanceof File ? entry : null
  } catch {
    return problem(
      400,
      'Peticion invalida',
      'Envia el archivo como multipart/form-data en el campo "xml".',
    )
  }

  if (!file) {
    return problem(400, 'Falta el XML', 'No se recibio ningun archivo en el campo "xml".')
  }
  if (file.size === 0) {
    return problem(400, 'El XML esta vacio', 'El archivo que subiste no tiene contenido.')
  }
  if (file.size > MAX_BYTES) {
    return problem(413, 'El XML es demasiado grande', `El limite es ${MAX_BYTES / 1024 / 1024} MB.`)
  }

  const xml = Buffer.from(await file.arrayBuffer())

  let cfdi
  try {
    cfdi = parseCfdi(xml)
  } catch (error) {
    if (error instanceof CfdiParseError) {
      // El codigo del parser es el motivo concreto: el proveedor ve que arreglar.
      return problem(422, 'El XML no se pudo procesar', error.message, { code: error.code })
    }
    throw error
  }

  const ctx = await contexto()
  ctx.uuidDuplicado = await uuidYaCargado(cfdi.timbre.uuid)

  const validaciones = validarCfdi(cfdi, ctx)
  const pendientes = reglasPendientes(ctx)

  const bloqueantesFallidas = bloqueantes(validaciones)

  return NextResponse.json({
    ok: bloqueantesFallidas.length === 0,
    esNotaDeCredito: cfdi.tipoDeComprobante === TIPO_NOTA_CREDITO,
    comprobante: {
      version: cfdi.version,
      tipo: cfdi.tipoDeComprobante,
      serie: cfdi.serie ?? null,
      folio: cfdi.folio ?? null,
      fecha: cfdi.fecha.toISOString(),
      moneda: cfdi.moneda,
      tipoCambio: cfdi.tipoCambio?.toFixed(6) ?? null,
      formaPago: cfdi.formaPago ?? null,
      metodoPago: cfdi.metodoPago ?? null,
      usoCFDI: cfdi.receptor.usoCFDI,
      lugarExpedicion: cfdi.lugarExpedicion,
      subTotal: cfdi.subTotal.toFixed(2),
      descuento: cfdi.descuento.toFixed(2),
      trasladados: cfdi.impuestos.totalTrasladados.toFixed(2),
      retenidos: cfdi.impuestos.totalRetenidos.toFixed(2),
      total: cfdi.total.toFixed(2),
    },
    emisor: cfdi.emisor,
    receptor: {
      rfc: cfdi.receptor.rfc,
      nombre: cfdi.receptor.nombre,
      regimenFiscal: cfdi.receptor.regimenFiscal,
      domicilioFiscal: cfdi.receptor.domicilioFiscal,
    },
    timbre: {
      uuid: cfdi.timbre.uuid,
      fechaTimbrado: cfdi.timbre.fechaTimbrado.toISOString(),
      noCertificadoSAT: cfdi.timbre.noCertificadoSAT,
    },
    conceptos: cfdi.conceptos.map((c) => ({
      linea: c.lineNumber,
      claveProdServ: c.claveProdServ,
      claveUnidad: c.claveUnidad,
      noIdentificacion: c.noIdentificacion ?? null,
      descripcion: c.descripcion,
      cantidad: c.cantidad.toFixed(3),
      valorUnitario: c.valorUnitario.toFixed(4),
      importe: c.importe.toFixed(2),
      descuento: c.descuento.toFixed(2),
      trasladados: c.totalTrasladados.toFixed(2),
      retenidos: c.totalRetenidos.toFixed(2),
    })),
    relacionados: cfdi.cfdiRelacionados.map((r) => ({
      tipoRelacion: r.tipoRelacion,
      uuids: [...r.uuids],
    })),
    validaciones,
    pendientes,
  })
}
