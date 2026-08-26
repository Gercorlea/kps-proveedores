import { randomUUID } from 'node:crypto'
import { Binary, type ClientSession } from 'mongodb'
import { storedDocuments, type StoredDocumentDoc } from '../mongo'

/**
 * Almacen de los archivos que sube el proveedor.
 *
 * ALCANCE. §04 pide un object store privado con URLs firmadas de 5 minutos y la
 * config ya trae las variables de S3, pero no hay bucket montado. Mientras no lo
 * haya, los bytes viven en Mongo (coleccion `documents`) y se sirven por
 * `/api/v1/documents/[key]`, que comprueba la sesion en cada descarga. No hay
 * URL publica: la clave sola no basta para bajar un archivo.
 *
 * La forma de la clave es la misma que tendria con S3, asi que el dia que exista
 * el bucket solo cambian este modulo y la ruta de descarga; ni la factura ni las
 * pantallas se enteran.
 */

/**
 * Tope por archivo. BSON no admite documentos de mas de 16 MB y el binario no es
 * lo unico que ocupa, asi que se deja margen. `MAX_UPLOAD_BYTES` de la config
 * (20 MB por omision) es el limite del futuro bucket, no el de esta caja.
 */
export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024

export interface ArchivoEntrante {
  filename: string
  contentType: string
  bytes: Buffer
}

export class DocumentTooLargeError extends Error {
  constructor(
    readonly filename: string,
    readonly size: number,
  ) {
    super(
      `${filename} pesa ${(size / 1024 / 1024).toFixed(1)} MB y el limite por archivo es ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB.`,
    )
    this.name = 'DocumentTooLargeError'
  }
}

/**
 * Guarda un archivo y devuelve su clave.
 *
 * Se escribe FUERA de la transaccion que crea la factura a proposito: una
 * transaccion de Mongo cabe en un solo registro del oplog —16 MB— y tres
 * archivos dentro la reventarian. Si la factura falla despues, aqui queda un
 * blob huerfano sin referencia: sobra espacio, pero no corrompe nada. Al reves
 * —una factura apuntando a un archivo que no se escribio— si seria un dato roto.
 */
export async function storeDocument(
  archivo: ArchivoEntrante,
  meta: {
    purpose: StoredDocumentDoc['purpose']
    supplierCode?: string | null
    uploadedBy: string
  },
  session?: ClientSession,
): Promise<string> {
  if (archivo.bytes.byteLength > MAX_DOCUMENT_BYTES) {
    throw new DocumentTooLargeError(archivo.filename, archivo.bytes.byteLength)
  }

  const key = randomUUID()
  const coleccion = await storedDocuments()
  await coleccion.insertOne(
    {
      _id: key,
      filename: archivo.filename,
      contentType: archivo.contentType || 'application/octet-stream',
      size: archivo.bytes.byteLength,
      bytes: new Binary(archivo.bytes),
      purpose: meta.purpose,
      supplierCode: meta.supplierCode ?? null,
      uploadedBy: meta.uploadedBy,
      createdAt: new Date(),
    },
    { session },
  )
  return key
}

export async function readDocument(key: string): Promise<StoredDocumentDoc | null> {
  return (await storedDocuments()).findOne({ _id: key })
}
