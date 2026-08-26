import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth/server'
import { esInterno } from '@/lib/auth/session'
import { createInvoiceFromOrder, InvoiceFromOrderError } from '@/lib/invoices/from-order'
import { getSapClient, SapError } from '@/lib/sap'
import type { ArchivoEntrante } from '@/lib/storage/documents'

/**
 * POST /api/v1/purchase-orders/[docEntry]/invoice
 *
 * El proveedor carga el XML de su factura desde la pantalla de la orden. Queda
 * como BORRADOR con el XML adjunto y aparece en /facturas.
 *
 * EL PROVEEDOR Y EL NUMERO DE ORDEN NO SE ACEPTAN DEL CLIENTE. Salen de la orden
 * leida de Business One. Si vinieran en el formulario, cualquiera podria colgar
 * su factura de la orden de otra empresa cambiando un campo del multipart.
 */
export const runtime = 'nodejs'

function problem(status: number, title: string, detail: string, extra: object = {}) {
  // RFC 7807, como pide §13.
  return NextResponse.json(
    { type: 'about:blank', title, status, detail, ...extra },
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  )
}

export async function POST(request: Request, { params }: { params: Promise<{ docEntry: string }> }) {
  const session = await getSession()
  if (!session) {
    return problem(401, 'Sin sesion', 'Inicia sesion para cargar una factura.')
  }

  const { docEntry } = await params
  const poDocEntry = Number.parseInt(docEntry, 10)
  if (!Number.isFinite(poDocEntry)) {
    return problem(400, 'Peticion invalida', `"${docEntry}" no es un numero de documento.`)
  }

  // B1 devuelve cualquier orden por DocEntry, sin saber quien pregunta: el
  // CardCode del documento se compara con el de la sesion antes de usarlo.
  let oc
  try {
    oc = await getSapClient().getPurchaseOrder(poDocEntry)
  } catch (error) {
    const mensaje = error instanceof SapError ? error.message : 'No se pudo consultar Business One.'
    return problem(502, 'Business One no responde', mensaje)
  }

  // Mismo 404 para "no existe" y "no es tuya": distinguirlas confirmaria que esa
  // orden existe y de quien es.
  const ajena = oc && !esInterno(session.roles) && oc.CardCode !== session.supplierCode
  if (!oc || ajena) {
    return problem(404, 'Orden no encontrada', `No hay ninguna orden con el numero ${poDocEntry}.`)
  }

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return problem(
      400,
      'Peticion invalida',
      'Envia el XML como multipart/form-data en el campo "xml".',
    )
  }

  const entrada = form.get('xml')
  if (!(entrada instanceof File) || entrada.size === 0) {
    return problem(400, 'Falta el XML', 'Adjunta el XML timbrado de la factura.')
  }

  const xml: ArchivoEntrante = {
    filename: entrada.name,
    contentType: entrada.type || 'application/xml',
    bytes: Buffer.from(await entrada.arrayBuffer()),
  }

  // Contra que entrada de mercancia se factura. OBLIGATORIO: en Business One la
  // factura se copia de la entrada (`BaseType: 20`), asi que una factura sin
  // ella no se puede registrar nunca. Aceptarla solo aplaza el rechazo hasta la
  // aprobacion, cuando el proveedor ya no puede corregir nada.
  const entradaCruda = form.get('entradaDocEntry')
  const entradaDocEntry =
    typeof entradaCruda === 'string' && /^\d+$/.test(entradaCruda.trim())
      ? Number.parseInt(entradaCruda.trim(), 10)
      : null

  if (entradaDocEntry === null) {
    return problem(
      422,
      'Falta la entrada de mercancia',
      `Indica contra que entrada de mercancia se factura. En Business One la factura se copia de la entrada, no de la orden: sin ese dato no se puede registrar. Si la OC ${oc.DocNum} todavia no tiene ninguna entrada abierta, hay que registrarla antes de facturar.`,
      { code: 'FALTA_ENTRADA' },
    )
  }

  try {
    const resultado = await createInvoiceFromOrder({
      actor: session,
      cardCode: oc.CardCode,
      poNumber: String(oc.DocNum),
      poDocEntry,
      goodsReceiptDocEntry: entradaDocEntry,
      xml,
      // La orden ya esta leida aqui arriba, con sus renglones. Se pasa para que
      // el cotejo pueda correr sin una segunda llamada a Business One.
      orden: oc,
    })
    return NextResponse.json({ ok: true, ...resultado }, { status: 201 })
  } catch (error) {
    if (error instanceof InvoiceFromOrderError) {
      return problem(error.status, 'No se pudo cargar la factura', error.message, {
        code: error.code,
        validaciones: error.validaciones ?? [],
      })
    }
    throw error
  }
}
