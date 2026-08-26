import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth/server'
import { ComplementoError, registrarComplemento } from '@/lib/invoices/complementos'

/**
 * POST /api/v1/invoices/{folio}/complemento
 *
 * El proveedor carga el CFDI de tipo P que salda una factura PPD. Solo el XML:
 * el complemento no necesita evidencia —lo que respalda el pago es el propio
 * comprobante— y su PDF no aporta nada que el XML no diga.
 */
export const runtime = 'nodejs'

function problem(status: number, title: string, detail: string, extra: object = {}) {
  return NextResponse.json(
    { type: 'about:blank', title, status, detail, ...extra },
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  )
}

export async function POST(request: Request, { params }: { params: Promise<{ folio: string }> }) {
  const session = await getSession()
  if (!session) return problem(401, 'Sin sesion', 'Inicia sesion para cargar un complemento.')

  const { folio } = await params

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return problem(400, 'Peticion invalida', 'Envia el XML como multipart en el campo "xml".')
  }

  const entrada = form.get('xml')
  if (!(entrada instanceof File) || entrada.size === 0) {
    return problem(400, 'Falta el XML', 'Sube el XML timbrado del complemento de pago.')
  }

  try {
    const resultado = await registrarComplemento({
      session,
      folio,
      xml: {
        filename: entrada.name,
        contentType: entrada.type,
        bytes: Buffer.from(await entrada.arrayBuffer()),
      },
    })
    return NextResponse.json({ ok: true, ...resultado }, { status: 201 })
  } catch (error) {
    if (error instanceof ComplementoError) {
      return problem(error.status, 'No se pudo cargar el complemento', error.message, {
        code: error.code,
      })
    }
    throw error
  }
}
