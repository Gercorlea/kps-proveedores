import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth/server'
import { esInterno } from '@/lib/auth/session'
import { readDocument } from '@/lib/storage/documents'

/**
 * GET /api/v1/documents/[key]
 *
 * Descarga un archivo cargado por un proveedor: el XML, el PDF o la evidencia.
 *
 * La clave NO es la autorizacion. Cada descarga comprueba la sesion: KPS ve
 * cualquier archivo y un proveedor solo los suyos. Ese `supplierCode !==` de
 * abajo es el `supplierScope` de §02 aplicado a archivos —Mongo no tiene
 * row-level security y el aislamiento vive en la aplicacion—, y sin el bastaria
 * con tener una clave ajena para leer la factura de otra empresa.
 *
 * Se responde 404 y no 403 cuando el archivo es de otro: un 403 confirmaria que
 * esa clave existe.
 */
export const runtime = 'nodejs'

export async function GET(_request: Request, { params }: { params: Promise<{ key: string }> }) {
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ error: 'Inicia sesion para descargar el archivo.' }, { status: 401 })
  }

  const { key } = await params
  const doc = await readDocument(key)
  if (!doc) return NextResponse.json({ error: 'Ese archivo no existe.' }, { status: 404 })

  if (!esInterno(session.roles) && doc.supplierCode !== session.supplierCode) {
    return NextResponse.json({ error: 'Ese archivo no existe.' }, { status: 404 })
  }

  return new NextResponse(new Uint8Array(doc.bytes.buffer), {
    headers: {
      'Content-Type': doc.contentType,
      'Content-Length': String(doc.size),
      // `inline` para poder mirar el PDF sin bajarlo; el nombre se conserva.
      'Content-Disposition': `inline; filename="${doc.filename.replace(/"/g, '')}"`,
      // Privado y sin cache compartida: lo sirve una ruta autenticada.
      'Cache-Control': 'private, no-store',
    },
  })
}
