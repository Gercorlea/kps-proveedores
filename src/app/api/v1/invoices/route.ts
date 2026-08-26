import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth/server'
import { InvoiceSubmitError, SUBMIT_ERROR, submitInvoice } from '@/lib/invoices/submit'
import type { ArchivoEntrante } from '@/lib/storage/documents'

/**
 * POST /api/v1/invoices
 *
 * El proveedor envia su factura a revision: XML, PDF y evidencia en un solo
 * multipart. Es lo que crea la peticion que KPS ve en /peticiones.
 *
 * Todo llega junto a proposito. Subir los archivos por separado obligaria a
 * mantener un borrador a medias en la base, y §10.2 ya define BORRADOR como otra
 * cosa; ademas una carga incompleta no se puede validar, y validar es lo unico
 * que justifica aceptar el envio.
 */
export const runtime = 'nodejs'

function problem(status: number, title: string, detail: string, extra: object = {}) {
  // RFC 7807, como pide §13.
  return NextResponse.json(
    { type: 'about:blank', title, status, detail, ...extra },
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  )
}

async function archivo(entrada: FormDataEntryValue | null): Promise<ArchivoEntrante | null> {
  if (!(entrada instanceof File) || entrada.size === 0) return null
  return {
    filename: entrada.name,
    contentType: entrada.type,
    bytes: Buffer.from(await entrada.arrayBuffer()),
  }
}

export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return problem(401, 'Sin sesion', 'Inicia sesion para enviar una factura.')

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return problem(
      400,
      'Peticion invalida',
      'Envia los archivos como multipart/form-data en los campos "xml", "pdf" y "evidencia".',
    )
  }

  const [xml, pdf, evidencia] = await Promise.all([
    archivo(form.get('xml')),
    archivo(form.get('pdf')),
    archivo(form.get('evidencia')),
  ])
  const titulo = String(form.get('titulo') ?? '').trim()
  const descripcion = String(form.get('descripcion') ?? '').trim()


  // M5/S4 exigen XML y PDF; M6/S3 exigen evidencia con titulo y descripcion. Se
  // enumera TODO lo que falta de una vez: devolver solo el primero obligaria al
  // proveedor a reenviar tres veces para enterarse de las tres cosas.
  const faltantes = [
    !xml && 'el XML timbrado',
    !pdf && 'el PDF de la factura',
    !evidencia && 'el archivo de evidencia',
    !titulo && 'el titulo de la evidencia',
    !descripcion && 'la descripcion de la evidencia',
  ].filter((x): x is string => typeof x === 'string')

  if (faltantes.length > 0) {
    return problem(
      400,
      'Falta completar la carga',
      `Para enviar la factura a revision necesitas subir ${faltantes.join(', ')}.`,
      { code: SUBMIT_ERROR.FALTA_ARCHIVO, faltantes },
    )
  }

  try {
    const resultado = await submitInvoice({
      session,
      xml: xml!,
      pdf: pdf!,
      evidencia: { archivo: evidencia!, titulo, descripcion },
    })
    return NextResponse.json({ ok: true, ...resultado }, { status: 201 })
  } catch (error) {
    if (error instanceof InvoiceSubmitError) {
      return problem(error.status, 'No se pudo enviar la factura', error.message, {
        code: error.code,
        validaciones: error.validaciones ?? [],
      })
    }
    throw error
  }
}
