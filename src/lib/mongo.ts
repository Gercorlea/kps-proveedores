import {
  MongoClient,
  Decimal128,
  type Binary,
  type Collection,
  type Db,
  type Filter,
} from 'mongodb'
import { Decimal, money } from './money'
import type {
  CreditNoteStatus,
  InvoiceStatus,
  InvoiceType,
  MatchOutcome,
  NotificationType,
  OnboardingDecision,
  PoStatus,
  Severity,
  SupplierStatus,
  SupplierType,
  TonoEstatus,
  UserRole,
} from './domain/enums'

/**
 * Acceso a MongoDB.
 *
 * Sobre por que el driver oficial y no un ORM: los importes fiscales necesitan
 * Decimal128, y el conector de MongoDB de Prisma no soporta el tipo Decimal
 * —comprobado: "The current connector does not support the Decimal type"—. Con
 * String se pierde $sum y el orden; con enteros de centavos no caben los seis
 * decimales del ValorUnitario del CFDI. Decimal128 es el unico tipo correcto
 * para dinero aqui, y solo se llega a el por el driver.
 *
 * Las transacciones exigen replica set. Un mongod suelto no las soporta, y §11
 * obliga a que el evento de bitacora se escriba en la misma transaccion que el
 * cambio de estatus.
 */

// ---------------------------------------------------------------------------
// Conversion de importes
// ---------------------------------------------------------------------------

/**
 * Decimal.js -> Decimal128. Se redondea antes de convertir: Decimal128 admite
 * 34 digitos significativos, pero un importe fiscal con mas decimales de los
 * que corresponden es un error de calculo, no un dato que haya que preservar.
 */
export function toDecimal128(value: Decimal, dp = 2): Decimal128 {
  return Decimal128.fromString(value.toDecimalPlaces(dp, Decimal.ROUND_HALF_UP).toFixed(dp))
}

/** Decimal128 -> Decimal.js. Acepta null para los campos opcionales. */
export function fromDecimal128(value: Decimal128 | null | undefined): Decimal | null {
  if (value === null || value === undefined) return null
  return money(value.toString())
}

/** Igual que `fromDecimal128` pero exige el valor: para campos ya poblados. */
export function requireDecimal128(value: Decimal128 | null | undefined, campo: string): Decimal {
  const d = fromDecimal128(value)
  if (d === null) throw new Error(`El campo ${campo} no tiene importe y se esperaba uno.`)
  return d
}

// ---------------------------------------------------------------------------
// Documentos
// ---------------------------------------------------------------------------

export interface UserDoc {
  _id?: string
  email: string
  name: string
  /** Proveedores externos: credenciales propias del portal. */
  passwordHash?: string | null
  /** Internos KPS: sujeto OIDC del IdP corporativo. */
  oidcSubject?: string | null
  roles: UserRole[]
  /** CardCode del proveedor al que pertenece. Nulo en internos de KPS. */
  supplierCode?: string | null
  active: boolean
  lastLoginAt?: Date | null
  /** §02 — override de segregacion de funciones, registrado. */
  sodOverrideBy?: string | null
  sodOverrideAt?: Date | null
  sodOverrideReason?: string | null
  createdAt: Date
  updatedAt: Date
}

export interface SupplierDoc {
  _id?: string
  /** CardCode de B1. Nulo hasta vincular; sin el la cuenta no se activa (§05). */
  supplierCode?: string | null
  type: SupplierType
  status: SupplierStatus
  taxId: string
  /**
   * El RFC, pero SOLO cuando identifica a una empresa concreta.
   *
   * Existe porque `taxId` no puede llevar indice unico a secas: `XAXX010101000`
   * —publico en general— y `XEXX010101000` —residentes en el extranjero— los
   * comparten legitimamente varios proveedores, y el indice impedia registrar al
   * segundo que apareciera. Un indice parcial tampoco sirve: MongoDB no admite
   * `$nin` en `partialFilterExpression`.
   *
   * Asi que el descarte se hace al escribir: en un RFC generico este campo queda
   * ausente y el indice unico —parcial por tipo— no lo ve. Se calcula con
   * `taxIdUnico()`; no se escribe a mano.
   */
  taxIdUnique?: string | null
  legalName: string
  fiscalAddress: Record<string, unknown>
  contact: Record<string, unknown>
  paymentTerms: string
  /** Moneda pactada en B1. */
  currency?: string | null
  /** GroupCode de B1. Se guarda crudo: el catalogo de grupos vive en SAP. */
  groupCode?: number | null
  /**
   * Instantanea de B1 al momento de registrar. NO incluye el saldo: cambia con
   * cada pago y una copia aqui envejeceria mal; el saldo se lee siempre en vivo.
   */
  sapValid?: boolean | null
  taxCertificateKey?: string | null
  taxCertificateDate?: Date | null
  /** §08 P1 — retenido por recibo de pago pendiente. */
  blocked: boolean
  blockReason?: string | null
  blockedAt?: Date | null
  services: Array<{
    id: string
    title: string
    description: string
    documentKey: string
    active: boolean
  }>
  onboarding?: {
    submittedAt: Date
    reviewedBy?: string | null
    reviewedAt?: Date | null
    decision?: OnboardingDecision | null
    reason?: string | null
    sapLinkedCode?: string | null
  } | null
  syncedAt?: Date | null
  createdAt: Date
  updatedAt: Date
}

/**
 * Aviso para un proveedor: lo que sale en la campana de la topbar.
 *
 * ES DE LA EMPRESA, NO DE UNA PERSONA. Un proveedor puede tener varios usuarios
 * y el aviso le interesa a todos, asi que se guarda UNA fila por aviso y el
 * "visto" se lleva en `readBy`. La alternativa —una fila por usuario, como en el
 * dashboard de planta— multiplica el mismo hecho por cuantas cuentas tenga el
 * proveedor y obliga a rehacer el reparto cada vez que KPS le da de alta otra.
 *
 * `sourceEventId` es el `_id` del evento de bitacora que lo genero. Es lo que
 * permite materializar los avisos a partir de §11 sin duplicarlos: el indice
 * unico convierte "insertarlo otra vez" en un no-op, asi que la operacion se
 * puede repetir tantas veces como haga falta.
 */
export interface NotificationDoc {
  _id?: string
  /** Folio propio, AVI-<ano>-<consecutivo>. */
  notificationId: string
  supplierCode: string
  type: NotificationType
  title: string
  message: string
  tone: TonoEstatus
  /** A donde lleva el aviso al pulsarlo. */
  link?: string | null
  invoiceFolio?: string | null
  poNumber?: string | null
  sourceEventId?: string | null
  /** userId de cada persona del proveedor que ya lo vio. */
  readBy: string[]
  /** Quien lo escribio, cuando lo escribe una persona y no la bitacora. */
  createdBy?: string | null
  createdAt: Date
}

export interface PoLineDoc {
  lineNum: number
  itemCode?: string | null
  description: string
  quantityOrdered: Decimal128
  remainingOpen: Decimal128
  unit: string
  unitPrice: Decimal128
  lineTotal: Decimal128
  taxAmount: Decimal128
  accountCode?: string | null
  costingCode?: string | null
}

export interface PurchaseOrderDoc {
  _id?: string
  sapDocEntry: number
  poNumber: string
  supplierCode: string
  companyDb: string
  documentDate: Date
  currency: string
  totalAmount: Decimal128
  status: PoStatus
  /** DocumentStatus crudo de B1. El cierre lo hace B1 solo (§00.03). */
  sapDocStatus?: string | null
  items: PoLineDoc[]
  syncedAt: Date
}

export interface ReceiptLineDoc {
  lineNum: number
  /** BaseLine hacia la OC. */
  poLineNum: number
  itemCode?: string | null
  description: string
  quantityReceived: Decimal128
  remainingOpen: Decimal128
  unit: string
  price: Decimal128
  lineTotal: Decimal128
  taxAmount: Decimal128
}

/** PurchaseDeliveryNote (GRPO). Unidad de facturacion del flujo de mercancia. */
export interface GoodsReceiptDoc {
  _id?: string
  sapDocEntry: number
  documentNumber: string
  poNumber: string
  supplierCode: string
  postingDate: Date
  currency: string
  documentStatus: string
  /** False cuando la entrada se anula en SAP (regla OC4). */
  invoiceable: boolean
  cancelledInSap: boolean
  items: ReceiptLineDoc[]
  syncedAt: Date
}

export interface InvoiceLineDoc {
  lineNumber: number
  claveProdServ: string
  claveUnidad: string
  noIdentidad?: string | null
  description: string
  quantity: Decimal128
  unitValue: Decimal128
  amount: Decimal128
  discount: Decimal128
  taxTransferred: Decimal128
  taxWithheld: Decimal128
}

export interface InvoiceDoc {
  _id?: string
  folio: string
  type: InvoiceType
  supplierCode: string
  status: InvoiceStatus

  // Fiscales — extraidos del XML, nunca capturados. Ausentes en BORRADOR.
  uuid?: string | null
  serie?: string | null
  issueDate?: Date | null
  issuerTaxId?: string | null
  receiverTaxId?: string | null
  subtotal?: Decimal128 | null
  taxTransferred?: Decimal128 | null
  taxWithheld?: Decimal128 | null
  /**
   * Desglose de las retenciones, impuesto por impuesto.
   *
   * `taxWithheld` dice CUANTO se retuvo; esto dice DE QUE. Business One necesita
   * las dos cosas para registrarla: cada `WithholdingTaxDataCollection` lleva su
   * `WTCode`, y ese codigo se elige segun el impuesto (001 ISR, 002 IVA) y la
   * tasa. Sin el desglose, una factura con retenciones solo se puede registrar
   * por su importe bruto, y eso le paga al proveedor lo que ya se le retuvo.
   *
   * Cadenas y no numeros: son importes fiscales, y pasar por coma flotante les
   * quita centavos.
   */
  taxWithholdings?: Array<{
    /** c_Impuesto: 001 ISR, 002 IVA, 003 IEPS. */
    impuesto: string
    tipoFactor: string
    tasaOCuota: string | null
    base: string
    importe: string
  }> | null
  /** Total CON IVA — base del cotejo (M7). */
  total?: Decimal128 | null
  currency?: string | null
  exchangeRate?: Decimal128 | null
  paymentMethod?: string | null
  paymentForm?: string | null
  cfdiUse?: string | null
  lines: InvoiceLineDoc[]

  /**
   * En que deja la orden esta factura, calculado al cargarla.
   *
   * Se guarda en vez de recalcularse en cada listado: la lista de ordenes no
   * tiene las lineas de B1 —el $select de la lista no las trae— y pedirlas
   * seria una llamada a SAP por fila.
   */
  poCoverage?: {
    estado: 'SIN_FACTURAR' | 'PARCIAL' | 'COMPLETA' | 'EXCEDE'
    lineasPendientes: number
    calculadoEn: Date
  } | null

  // Mercancia — la factura se copia desde la entrada (BaseType=20).
  //
  // Son cuatro campos y no dos porque B1 distingue lo que ve la gente de lo que
  // acepta la API: `DocNum` es el numero visible —"la OC 1119"— y `DocEntry` es
  // la clave real de la tabla. El payload solo admite `DocEntry`; mandar el
  // `DocNum` apunta a otro documento que casi siempre existe, y el error no se
  // nota hasta que alguien revisa la contabilidad.
  /** `DocNum` de la orden. El numero que ve el proveedor. */
  poNumber?: string | null
  /** `DocEntry` de la orden. Con el se relee la orden en B1. */
  poDocEntry?: number | null
  /**
   * `DocNum` de la entrada de mercancia. Lleva indice unico parcial: es lo que
   * impone la regla M3 —una factura por entrada—.
   */
  goodsReceiptNumber?: string | null
  /**
   * `DocEntry` de la entrada de mercancia: el `BaseEntry` del payload de
   * `PurchaseInvoices`. Sin el no se puede armar `DocumentLines` y la factura no
   * se puede registrar en B1.
   */
  baseEntry?: number | null

  // Servicio
  serviceId?: string | null
  serviceDescription?: string | null
  requesterName?: string | null

  // Documentos. La evidencia lleva titulo y descripcion, no solo el archivo.
  xmlFileKey?: string | null
  pdfFileKey?: string | null
  evidence: Array<{ title: string; description: string; fileKey: string; uploadedAt: Date }>

  // Cotejo (§06)
  matchOutcome?: MatchOutcome | null
  matchResult?: Record<string, unknown> | null
  amountToPay?: Decimal128 | null

  // SAP Business One
  sapDocEntry?: number | null
  sapDocNum?: number | null
  sapAccountCode?: string | null
  sapCostingCode?: string | null
  sapAttachmentEntry?: number | null
  sapPostedAt?: Date | null
  sapError?: string | null

  // Pago (§08)
  paymentApprovedBy?: string | null
  paymentApprovedAt?: Date | null
  paidMarkedBy?: string | null
  paidMarkedAt?: Date | null
  paidAt?: Date | null
  paymentReference?: string | null
  paymentReceipt?: {
    fileKey: string
    uuid?: string | null
    uploadedAt: Date
    registeredBy?: string | null
    registeredAt?: Date | null
  } | null

  // Flujo
  submittedAt?: Date | null
  reviewedBy?: string | null
  reviewedAt?: Date | null
  rejectionReason?: string | null

  createdAt: Date
  updatedAt: Date
}

export interface CreditNoteDoc {
  _id?: string
  invoiceFolio: string
  uuid: string
  sapDocEntry?: number | null
  amount: Decimal128
  currency: string
  issueDate?: Date | null
  xmlFileKey: string
  pdfFileKey: string
  status: CreditNoteStatus
  reviewedBy?: string | null
  reviewedAt?: Date | null
  reason?: string | null
  sapAdjustedAt?: Date | null
  createdAt: Date
}

export interface ValidationResultDoc {
  _id?: string
  invoiceFolio: string
  rule: string
  severity: Severity
  passed: boolean
  detail: string
  automated: boolean
  ranAt: Date
}

/**
 * Bitacora append-only. Nunca se actualiza ni se borra: cada cambio de estatus
 * escribe un evento en la misma transaccion (§11).
 */
export interface InvoiceEventDoc {
  _id?: string
  invoiceFolio: string
  fromStatus?: InvoiceStatus | null
  toStatus: InvoiceStatus
  actorId: string
  actorRole: string
  comment?: string | null
  payload?: Record<string, unknown> | null
  createdAt: Date
}

export interface AuditLogDoc {
  _id?: string
  entityType: string
  entityId: string
  action: string
  actorId: string
  actorRole: string
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
  comment?: string | null
  createdAt: Date
}

/** §13 — Idempotency-Key en toda mutacion. */
export interface IdempotencyKeyDoc {
  _id?: string
  key: string
  userId: string
  endpoint: string
  requestHash: string
  responseCode?: number | null
  responseBody?: Record<string, unknown> | null
  completedAt?: Date | null
  createdAt: Date
}

/**
 * Archivo subido por un proveedor: el XML, el PDF y la evidencia de cada
 * peticion.
 *
 * §04 pide un object store privado con URLs firmadas, y la config ya trae las
 * variables de S3, pero no hay bucket montado. Guardar los bytes aqui es el
 * almacen interino: sin el, "enviar a revision" no puede guardar nada y quien
 * revisa no tiene nada que abrir. El limite de BSON son 16 MB por documento, de
 * ahi el tope de `MAX_DOCUMENT_BYTES` en src/lib/storage/documents.ts.
 *
 * Cuando exista el bucket, esta coleccion se sustituye por la clave de S3 y los
 * `fileKey` que ya guarda la factura no cambian de forma.
 */
export interface StoredDocumentDoc {
  /** La clave que guarda la factura en `xmlFileKey`, `pdfFileKey`, etc. */
  _id: string
  filename: string
  contentType: string
  size: number
  bytes: Binary
  purpose: 'XML' | 'PDF' | 'EVIDENCIA' | 'RECIBO' | 'COMPLEMENTO'
  /** Proveedor dueno del archivo. Decide quien puede descargarlo. */
  supplierCode?: string | null
  uploadedBy: string
  createdAt: Date
}

export interface SapSyncStateDoc {
  _id?: string
  entity: string
  companyDb: string
  lastSyncedAt?: Date | null
  lastDocEntry?: number | null
  lastError?: string | null
  running: boolean
  updatedAt: Date
}

export interface DocumentCounterDoc {
  _id?: string
  scope: string
  year: number
  value: number
}

// ---------------------------------------------------------------------------
// Conexion
// ---------------------------------------------------------------------------

let client: MongoClient | null = null
let connecting: Promise<MongoClient> | null = null

function uri(): string {
  const value = process.env.MONGODB_URI
  if (!value) {
    throw new Error('MONGODB_URI no esta definida. La necesitan el portal, el seed y los workers.')
  }
  return value
}

/**
 * Nombre de base escrito en el propio URI de conexion, si lo trae.
 *
 * Un URI de Atlas normalmente lo lleva —.../KPS-Proveedores?retryWrites=true—
 * y esperar ademas un MONGODB_DB aparte es una trampa: sin el, el portal se
 * conectaria a Atlas correctamente pero leeria de otra base, vacia, y el
 * sintoma seria "no hay usuarios" en vez de un error de conexion.
 *
 * No se usa `new URL()` porque la contrasena puede traer caracteres que rompen
 * el parseo. Se corta a mano: primero el query, luego el ultimo `@` (el userinfo
 * puede contener arrobas), y lo que quede tras la primera barra es la base.
 */
function dbFromUri(value: string): string | null {
  const sinEsquema = value.replace(/^mongodb(\+srv)?:\/\//i, '')
  const sinQuery = sinEsquema.split('?')[0]
  const trasArroba = sinQuery.slice(sinQuery.lastIndexOf('@') + 1)
  const barra = trasArroba.indexOf('/')
  if (barra === -1) return null
  const nombre = trasArroba.slice(barra + 1)
  return nombre.length > 0 ? decodeURIComponent(nombre) : null
}

function dbName(): string {
  return process.env.MONGODB_DB ?? dbFromUri(uri()) ?? 'kps_proveedores'
}

export async function getMongo(): Promise<MongoClient> {
  if (client) return client
  // Deduplica: en el arranque de Next varias peticiones concurrentes pedirian
  // conexion a la vez y abririan varios pools.
  connecting ??= new MongoClient(uri()).connect()
  client = await connecting
  return client
}

export async function getDb(): Promise<Db> {
  return (await getMongo()).db(dbName())
}

export async function closeMongo(): Promise<void> {
  await client?.close()
  client = null
  connecting = null
}

// ---------------------------------------------------------------------------
// Colecciones
// ---------------------------------------------------------------------------

export const COLLECTIONS = {
  users: 'users',
  suppliers: 'suppliers',
  purchaseOrders: 'purchaseOrders',
  goodsReceipts: 'goodsReceipts',
  invoices: 'invoices',
  creditNotes: 'creditNotes',
  validationResults: 'validationResults',
  invoiceEvents: 'invoiceEvents',
  auditLog: 'auditLog',
  idempotencyKeys: 'idempotencyKeys',
  sapSyncState: 'sapSyncState',
  documentCounters: 'documentCounters',
  documents: 'documents',
  notifications: 'notifications',
} as const

export async function users(): Promise<Collection<UserDoc>> {
  return (await getDb()).collection<UserDoc>(COLLECTIONS.users)
}
export async function suppliers(): Promise<Collection<SupplierDoc>> {
  return (await getDb()).collection<SupplierDoc>(COLLECTIONS.suppliers)
}
export async function purchaseOrders(): Promise<Collection<PurchaseOrderDoc>> {
  return (await getDb()).collection<PurchaseOrderDoc>(COLLECTIONS.purchaseOrders)
}
export async function goodsReceipts(): Promise<Collection<GoodsReceiptDoc>> {
  return (await getDb()).collection<GoodsReceiptDoc>(COLLECTIONS.goodsReceipts)
}
export async function invoices(): Promise<Collection<InvoiceDoc>> {
  return (await getDb()).collection<InvoiceDoc>(COLLECTIONS.invoices)
}
export async function creditNotes(): Promise<Collection<CreditNoteDoc>> {
  return (await getDb()).collection<CreditNoteDoc>(COLLECTIONS.creditNotes)
}
export async function validationResults(): Promise<Collection<ValidationResultDoc>> {
  return (await getDb()).collection<ValidationResultDoc>(COLLECTIONS.validationResults)
}
export async function invoiceEvents(): Promise<Collection<InvoiceEventDoc>> {
  return (await getDb()).collection<InvoiceEventDoc>(COLLECTIONS.invoiceEvents)
}
export async function auditLog(): Promise<Collection<AuditLogDoc>> {
  return (await getDb()).collection<AuditLogDoc>(COLLECTIONS.auditLog)
}
export async function idempotencyKeys(): Promise<Collection<IdempotencyKeyDoc>> {
  return (await getDb()).collection<IdempotencyKeyDoc>(COLLECTIONS.idempotencyKeys)
}
export async function sapSyncState(): Promise<Collection<SapSyncStateDoc>> {
  return (await getDb()).collection<SapSyncStateDoc>(COLLECTIONS.sapSyncState)
}
export async function documentCounters(): Promise<Collection<DocumentCounterDoc>> {
  return (await getDb()).collection<DocumentCounterDoc>(COLLECTIONS.documentCounters)
}
export async function storedDocuments(): Promise<Collection<StoredDocumentDoc>> {
  return (await getDb()).collection<StoredDocumentDoc>(COLLECTIONS.documents)
}
export async function notifications(): Promise<Collection<NotificationDoc>> {
  return (await getDb()).collection<NotificationDoc>(COLLECTIONS.notifications)
}

// ---------------------------------------------------------------------------
// Aislamiento por proveedor
// ---------------------------------------------------------------------------

/**
 * Filtro de aislamiento por proveedor.
 *
 * ADVERTENCIA DE DISENO. §02 exige que el aislamiento se aplique "con row-level
 * security en base de datos, NO con condiciones en la capa de aplicacion".
 * MongoDB no tiene RLS, asi que esa regla no se puede cumplir tal como esta
 * escrita: al elegir Mongo, el aislamiento pasa forzosamente a la aplicacion.
 *
 * Para que el riesgo no quede repartido por todo el codigo, TODA consulta sobre
 * datos de proveedor debe construir su filtro con esta funcion. Una consulta
 * que no la use es un fallo de seguridad, no un descuido de estilo.
 *
 * Si KPS necesita la garantia a nivel de motor, la via es Atlas con reglas de
 * App Services o una vista por proveedor; ninguna de las dos esta montada.
 */
export function supplierScope<T extends { supplierCode?: string | null }>(
  filter: Filter<T>,
  ctx: { supplierCode?: string | null; internal: boolean },
): Filter<T> {
  if (ctx.internal) return filter
  if (!ctx.supplierCode) {
    // Sin proveedor y sin ser interno no se ve nada. Un filtro imposible es mas
    // seguro que devolver todo por omision.
    return { ...filter, supplierCode: '__sin_acceso__' } as Filter<T>
  }
  return { ...filter, supplierCode: ctx.supplierCode } as Filter<T>
}

// ---------------------------------------------------------------------------
// Indices
// ---------------------------------------------------------------------------

/**
 * Crea los indices. Es idempotente: `createIndex` no hace nada si ya existe.
 * Los unique sustituyen a las restricciones que en Postgres daba el esquema —
 * en particular el de `invoices.uuid`, que es lo que impide cargar dos veces el
 * mismo CFDI, y el de `goodsReceiptNumber`, que impone la regla M3.
 */
/**
 * RFC que el SAT reserva y que varios proveedores comparten legitimamente.
 * Quedan fuera del indice unico de `taxId`.
 */
export const RFC_GENERICOS: readonly string[] = ['XAXX010101000', 'XEXX010101000']

/**
 * El valor que va en `taxIdUnique`: el RFC, o null si es uno de los genericos.
 *
 * Devuelve null y no la cadena vacia a proposito: el indice es parcial por
 * `$type: 'string'`, asi que null y ausente quedan los dos fuera, pero una
 * cadena vacia SI entraria —y entonces dos genericos chocarian entre si por
 * compartir el vacio, que es justo lo que se quiere evitar.
 */
export function taxIdUnico(taxId: string | null | undefined): string | null {
  const rfc = (taxId ?? '').trim().toUpperCase()
  if (rfc === '' || RFC_GENERICOS.includes(rfc)) return null
  return rfc
}

/**
 * Recrea un indice cuyas opciones cambiaron.
 *
 * `createIndex` es idempotente mientras las opciones coincidan, pero si difieren
 * Mongo responde `IndexOptionsConflict` (85) y NO lo actualiza: el indice viejo
 * se queda como estaba. Sin esto, cambiar un indice en el codigo no cambiaria
 * nada en una base ya creada, y el sintoma seria "arregle el bug y sigue
 * fallando".
 */
async function crearIndices(
  db: Db,
  coleccion: string,
  indices: Parameters<Collection['createIndexes']>[0],
): Promise<void> {
  try {
    await db.collection(coleccion).createIndexes(indices)
  } catch (error) {
    const code = (error as { code?: number }).code
    if (code !== 85) throw error
    // Se tiran solo los que chocan y se vuelven a crear. Se hace uno por uno
    // para no tirar los que si coincidian.
    for (const indice of indices) {
      try {
        await db.collection(coleccion).createIndexes([indice])
      } catch (e) {
        if ((e as { code?: number }).code !== 85) throw e
        if (indice.name) await db.collection(coleccion).dropIndex(indice.name)
        await db.collection(coleccion).createIndexes([indice])
      }
    }
  }
}

/**
 * Rellena `taxIdUnique` en los proveedores que ya existian y retira el indice
 * unico viejo de `taxId`.
 *
 * Va DENTRO de `ensureIndexes` y antes de crear el nuevo por un orden que
 * importa: si el unico viejo sigue puesto, un proveedor con RFC generico no se
 * puede registrar aunque el indice nuevo ya exista. Y si el campo no esta
 * poblado, el unico nuevo no protege nada.
 *
 * Es idempotente: el `$exists: false` deja fuera lo ya migrado, y el `dropIndex`
 * se traga el "no existe".
 */
async function migrarRfc(db: Db): Promise<void> {
  const col = db.collection<SupplierDoc>(COLLECTIONS.suppliers)

  try {
    await col.dropIndex('uq_rfc')
  } catch {
    // Ya estaba retirado, o la coleccion es nueva.
  }

  const pendientes = await col
    .find({ taxIdUnique: { $exists: false } }, { projection: { _id: 1, taxId: 1 } })
    .toArray()

  for (const p of pendientes) {
    await col.updateOne({ _id: p._id }, { $set: { taxIdUnique: taxIdUnico(p.taxId) } })
  }
}

export async function ensureIndexes(): Promise<void> {
  const db = await getDb()
  await migrarRfc(db)

  // Sobre `partialFilterExpression` en vez de `sparse`: un indice sparse solo
  // excluye los documentos donde el campo NO EXISTE. Si el campo esta presente
  // con valor null —que es lo normal al escribir `oidcSubject: null`— el
  // documento SI entra al indice, y el segundo null choca con el primero por
  // clave duplicada. El filtro parcial por tipo excluye tanto el ausente como
  // el null, que es lo que se busca.
  await db.collection(COLLECTIONS.users).createIndexes([
    { key: { email: 1 }, unique: true, name: 'uq_email' },
    {
      key: { oidcSubject: 1 },
      unique: true,
      partialFilterExpression: { oidcSubject: { $type: 'string' } },
      name: 'uq_oidc',
    },
    { key: { supplierCode: 1, active: 1 }, name: 'ix_supplier_active' },
  ])

  // Sobre el indice de RFC y por que NO es unico a secas.
  //
  // Hay RFC que se repiten por diseno: `XAXX010101000` es el de publico en
  // general y `XEXX010101000` el de residentes en el extranjero. Los comparten
  // tantos proveedores como haga falta, y tratarlos como identidad unica impide
  // registrar al segundo que aparezca —con un error de clave duplicada que no
  // dice nada—. El resto de RFC si identifican a una empresa y siguen siendo
  // unicos: registrar dos veces la misma bajo dos CardCode distintos es el error
  // que este indice existe para evitar.
  await crearIndices(db, COLLECTIONS.suppliers, [
    // El unico va sobre `taxIdUnique`, que solo esta poblado cuando el RFC
    // identifica a una empresa. Los genericos lo tienen en null y el filtro por
    // tipo los deja fuera, asi que pueden repetirse.
    {
      key: { taxIdUnique: 1 },
      unique: true,
      partialFilterExpression: { taxIdUnique: { $type: 'string' } },
      name: 'uq_rfc_unico',
    },
    // `taxId` conserva indice para buscar por RFC, pero SIN unique.
    { key: { taxId: 1 }, name: 'ix_rfc' },
    {
      key: { supplierCode: 1 },
      unique: true,
      partialFilterExpression: { supplierCode: { $type: 'string' } },
      name: 'uq_cardcode',
    },
    { key: { status: 1, type: 1 }, name: 'ix_status_type' },
  ])

  await db.collection(COLLECTIONS.purchaseOrders).createIndexes([
    { key: { sapDocEntry: 1 }, unique: true, name: 'uq_docentry' },
    { key: { poNumber: 1 }, unique: true, name: 'uq_ponumber' },
    { key: { supplierCode: 1, status: 1 }, name: 'ix_supplier_status' },
  ])

  await db.collection(COLLECTIONS.goodsReceipts).createIndexes([
    { key: { sapDocEntry: 1 }, unique: true, name: 'uq_docentry' },
    { key: { documentNumber: 1 }, unique: true, name: 'uq_docnum' },
    { key: { poNumber: 1, invoiceable: 1 }, name: 'ix_po_invoiceable' },
    { key: { supplierCode: 1 }, name: 'ix_supplier' },
  ])

  await db.collection(COLLECTIONS.invoices).createIndexes([
    { key: { folio: 1 }, unique: true, name: 'uq_folio' },
    // Impide cargar dos veces el mismo CFDI (regla DUPLICADO_PORTAL). El filtro
    // por tipo deja fuera las facturas en BORRADOR, que aun no tienen UUID.
    {
      key: { uuid: 1 },
      unique: true,
      partialFilterExpression: { uuid: { $type: 'string' } },
      name: 'uq_uuid',
    },
    // Regla M3: una factura por entrada de mercancia.
    {
      key: { goodsReceiptNumber: 1 },
      unique: true,
      partialFilterExpression: { goodsReceiptNumber: { $type: 'string' } },
      name: 'uq_entrada',
    },
    {
      key: { sapDocEntry: 1 },
      unique: true,
      partialFilterExpression: { sapDocEntry: { $type: 'number' } },
      name: 'uq_sap_docentry',
    },
    { key: { supplierCode: 1, status: 1, type: 1 }, name: 'ix_supplier_status_type' },
    { key: { status: 1, submittedAt: -1 }, name: 'ix_status_submitted' },
  ])

  await db.collection(COLLECTIONS.creditNotes).createIndexes([
    { key: { uuid: 1 }, unique: true, name: 'uq_uuid' },
    { key: { invoiceFolio: 1, status: 1 }, name: 'ix_invoice_status' },
  ])

  await db
    .collection(COLLECTIONS.validationResults)
    .createIndexes([{ key: { invoiceFolio: 1, ranAt: -1 }, name: 'ix_invoice_ran' }])

  await db
    .collection(COLLECTIONS.invoiceEvents)
    .createIndexes([{ key: { invoiceFolio: 1, createdAt: 1 }, name: 'ix_invoice_created' }])

  await db.collection(COLLECTIONS.auditLog).createIndexes([
    { key: { entityType: 1, entityId: 1, createdAt: -1 }, name: 'ix_entity' },
    { key: { actorId: 1, createdAt: -1 }, name: 'ix_actor' },
  ])

  await db.collection(COLLECTIONS.idempotencyKeys).createIndexes([
    { key: { key: 1, endpoint: 1 }, unique: true, name: 'uq_key_endpoint' },
    // Las claves caducan solas a las 24 h; no hace falta purgarlas a mano.
    { key: { createdAt: 1 }, expireAfterSeconds: 86_400, name: 'ttl_created' },
  ])

  await db
    .collection(COLLECTIONS.sapSyncState)
    .createIndexes([{ key: { entity: 1 }, unique: true, name: 'uq_entity' }])

  await db
    .collection(COLLECTIONS.documentCounters)
    .createIndexes([{ key: { scope: 1, year: 1 }, unique: true, name: 'uq_scope_year' }])

  await db
    .collection(COLLECTIONS.documents)
    .createIndexes([{ key: { supplierCode: 1, createdAt: -1 }, name: 'ix_supplier_created' }])

  await db.collection(COLLECTIONS.notifications).createIndexes([
    { key: { notificationId: 1 }, unique: true, name: 'uq_folio' },
    // El unico que hace el trabajo de verdad: impide que el mismo evento de
    // bitacora genere dos avisos, y con eso la materializacion puede correr en
    // cada visita sin llevar cuenta de por donde iba. Filtro parcial por tipo
    // para que los avisos escritos a mano —sin evento detras— no choquen entre
    // si por compartir el null.
    {
      key: { sourceEventId: 1 },
      unique: true,
      partialFilterExpression: { sourceEventId: { $type: 'string' } },
      name: 'uq_evento',
    },
    { key: { supplierCode: 1, createdAt: -1 }, name: 'ix_supplier_created' },
  ])
}
