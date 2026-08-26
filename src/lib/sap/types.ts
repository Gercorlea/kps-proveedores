/**
 * Contrato del adaptador contra SAP Business One — Service Layer, OData v4.
 *
 * §04 principio 1: adaptador unico con dos implementaciones, `ServiceLayerClient`
 * y `MockB1Client`. Todo el portal se construye y se prueba contra esta interfaz,
 * sin B1 disponible.
 *
 * Convenciones del borde OData que NO se filtran hacia el dominio:
 *   - Los importes llegan como `number`. Se convierten a Decimal en los mappers.
 *   - Las fechas llegan como `'YYYY-MM-DD'` (Edm.DateTimeOffset truncado por B1).
 *   - Los booleanos llegan como `'tYES' | 'tNO'`.
 *   - Los enumerados llegan como cadenas con prefijo (`cSupplier`, `bost_Open`).
 */

// ---------------------------------------------------------------------------
// Escalares de B1
// ---------------------------------------------------------------------------

export type B1YesNo = 'tYES' | 'tNO'

/**
 * El Service Layer devuelve `cSupplier`; la columna subyacente `OCRD.CardType`
 * guarda `S`. Se aceptan ambas formas porque distintas versiones y consultas
 * (`$select` vs. vistas SQL) exponen una u otra.
 */
export type B1CardType = 'cSupplier' | 'cCustomer' | 'cLid' | 'S' | 'C' | 'L'

export type B1DocumentStatus = 'bost_Open' | 'bost_Close' | 'bost_Paid' | 'bost_Delivered'

export type B1DocType = 'dDocument_Items' | 'dDocument_Service'

/** Fecha en el formato que emite y acepta el Service Layer. */
export type B1Date = string

/**
 * ObjectTypes de B1, usados en `BaseType` al copiar un documento de otro.
 * §00 consecuencia 01 y regla OC5.
 */
export const B1_OBJECT_TYPE = {
  /** Ordenes de compra. La entrada de mercancia copia de aqui (OC5). */
  PurchaseOrder: 22,
  /** Entradas de mercancia (GRPO). La factura copia de aqui (§00 consecuencia 01). */
  PurchaseDeliveryNote: 20,
  /** Facturas de compra. La nota de credito copia de aqui. */
  PurchaseInvoice: 18,
} as const

export type B1ObjectType = (typeof B1_OBJECT_TYPE)[keyof typeof B1_OBJECT_TYPE]

// ---------------------------------------------------------------------------
// BusinessPartners
// ---------------------------------------------------------------------------

/**
 * Socio de negocio. Los campos siguen el formato que KPS usa en su instancia.
 */
export interface B1BusinessPartner {
  /** Codigo unico del proveedor — clave primaria en SAP. */
  CardCode: string
  /** Nombre o razon social. */
  CardName: string
  /** Tipo: S = Supplier (proveedor). */
  CardType: B1CardType
  /** Grupo al que pertenece. */
  GroupCode?: number | null
  /** Telefono principal. */
  Phone1?: string | null
  /** Correo electronico. */
  EmailAddress?: string | null
  /** Saldo actual de cuenta. */
  CurrentAccountBalance?: number | null
  /** Moneda pactada. */
  Currency?: string | null
  /** Activo (tYES) o inactivo (tNO). */
  Valid?: B1YesNo | null

  // Campos adicionales que el portal lee o escribe, no siempre presentes segun `$select`.
  /** RFC. En la localizacion mexicana de B1 el RFC vive en `FederalTaxID`. */
  FederalTaxID?: string | null
  PayTermsGrpCode?: number | null
  /** Cuenta de control. Obligatoria al crear el socio (escenario A de §05). */
  ControlAccount?: string | null
  Series?: number | null
  UpdateDate?: B1Date | null
  UpdateTime?: string | null
  /** Campos de usuario `U_*` de la instalacion de KPS. */
  [userField: string]: unknown
}

export interface CreateBusinessPartnerPayload {
  CardCode?: string
  CardName: string
  CardType: 'cSupplier'
  FederalTaxID: string
  GroupCode?: number
  Series?: number
  ControlAccount?: string
  PayTermsGrpCode?: number
  Currency?: string
  Phone1?: string
  EmailAddress?: string
  [userField: string]: unknown
}

/**
 * Condiciones de pago (tabla OCTG). `PayTermsGrpCode` del socio de negocio es
 * una llave foranea a este catalogo: el numero por si solo no significa nada, y
 * mostrarlo crudo obliga al usuario a saberse la tabla de memoria.
 */
/**
 * Articulo del maestro, con lo que decide si se puede recibir desde el portal.
 *
 * Es una lectura de catalogo, no de documentos, y por eso trae solo las tres
 * banderas que condicionan la captura. El maestro de articulos de B1 tiene mas
 * de doscientos campos; pedirlos todos para saber si algo es inventariable seria
 * traer un catalogo entero por pantalla.
 */
export interface B1Item {
  ItemCode: string
  ItemName?: string | null
  /** `tNO` = no mueve inventario. No se puede recibir en una entrada. */
  InventoryItem?: B1YesNo | null
  ManageBatchNumbers?: B1YesNo | null
  ManageSerialNumbers?: B1YesNo | null
}

export interface B1PaymentTermsType {
  GroupNumber: number
  PaymentTermsGroupName: string
  NumberOfAdditionalDays?: number | null
  NumberOfAdditionalMonths?: number | null
  StartFrom?: string | null
}

// ---------------------------------------------------------------------------
// Lineas y documentos de compra
// ---------------------------------------------------------------------------

export interface B1DocumentLine {
  LineNum: number
  ItemCode?: string | null
  ItemDescription?: string | null
  Quantity: number
  /** Cantidad todavia abierta. B1 impide facturar por encima de este valor. */
  RemainingOpenQuantity?: number | null
  UnitPrice?: number | null
  Price?: number | null
  LineTotal: number
  /** Importe de impuestos de la linea. El cotejo compara total CON IVA (M7). */
  TaxTotal?: number | null
  TaxCode?: string | null
  Currency?: string | null
  MeasureUnit?: string | null
  UoMCode?: string | null
  /** Almacen al que entra o del que sale la linea. */
  WarehouseCode?: string | null
  AccountCode?: string | null
  CostingCode?: string | null
  /** Documento origen al copiar: 22 = OC, 20 = entrada, 18 = factura. */
  BaseType?: B1ObjectType | null
  BaseEntry?: number | null
  BaseLine?: number | null
  [userField: string]: unknown
}

interface B1MarketingDocumentBase {
  DocEntry: number
  DocNum: number
  CardCode: string
  CardName?: string | null
  DocDate: B1Date
  DocDueDate?: B1Date | null
  TaxDate?: B1Date | null
  DocCurrency?: string | null
  DocRate?: number | null
  DocTotal: number
  /** Importe de impuestos del documento. */
  VatSum?: number | null
  DocumentStatus: B1DocumentStatus
  Cancelled?: B1YesNo | null
  /** Referencia del proveedor. Candidato para alojar el UUID del CFDI (§00.06). */
  NumAtCard?: string | null
  /**
   * Condiciones de pago DE ESTE DOCUMENTO, no las del proveedor.
   *
   * Se hereda del socio de negocio al crear la orden, pero puede pactarse
   * distinto para una compra concreta —y entonces manda esta—. Comprobado: el
   * proveedor P0309 tiene 60 dias y su OC 1043 se pacto con pago anticipado, asi
   * que su factura vencio el mismo dia.
   *
   * Es una llave al catalogo `PaymentTermsTypes`; el numero solo no dice nada.
   */
  PaymentGroupCode?: number | null
  Comments?: string | null
  UpdateDate?: B1Date | null
  AttachmentEntry?: number | null
  DocumentLines: B1DocumentLine[]
  [userField: string]: unknown
}

export type B1PurchaseOrder = B1MarketingDocumentBase
export type B1PurchaseDeliveryNote = B1MarketingDocumentBase

export interface B1PurchaseInvoice extends B1MarketingDocumentBase {
  DocType?: B1DocType | null
}

export type B1PurchaseCreditNote = B1PurchaseInvoice

// ---------------------------------------------------------------------------
// Payloads de escritura
// ---------------------------------------------------------------------------

export interface CreatePurchaseOrderPayload {
  CardCode: string
  DocDate: B1Date
  DocDueDate: B1Date
  DocCurrency?: string
  Comments?: string
  DocumentLines: Array<{
    ItemCode?: string
    ItemDescription?: string
    Quantity: number
    UnitPrice?: number
    TaxCode?: string
    AccountCode?: string
    CostingCode?: string
    MeasureUnit?: string
  }>
}

/**
 * Un lote dentro de un renglon de entrada.
 *
 * B1 lo exige cuando el articulo tiene `ManageBatchNumbers: tYES`: no basta con
 * la cantidad, hay que decir QUE lote entro. Sin esto responde "Cannot add row
 * without complete selection of batch/serial numbers".
 *
 * Un renglon puede llevar VARIOS —un camion trae dos lotes del mismo producto— y
 * las cantidades tienen que sumar exactamente la del renglon.
 */
export interface B1BatchNumber {
  /** El codigo del lote. Texto libre; KPS usa formatos como `473-260618`. */
  BatchNumber: string
  Quantity: number
  /** `LineNum` del renglon al que pertenece. */
  BaseLineNumber: number
  /** Caducidad, 'YYYY-MM-DD'. Los articulos de KPS la llevan siempre. */
  ExpiryDate?: B1Date
  /**
   * Fecha de admision. El nombre lleva la errata de B1 —dos emes— y hay que
   * escribirlo asi: `AdmissionDate`, bien escrito, no existe y se ignora.
   */
  AddmisionDate?: B1Date
}

/**
 * Reparto de un renglon entre ubicaciones del almacen.
 *
 * B1 lo exige cuando el almacen tiene `EnableBinLocations: tYES`. En KPS solo lo
 * tiene el 1 (CeDis Guadalajara), y es justo donde entra casi todo.
 *
 * Cuando el articulo ademas se maneja por lote hacen falta LAS DOS COSAS, y el
 * mensaje de B1 no lo aclara: responde "Cannot add row without complete
 * selection of batch/serial numbers" aunque los lotes vayan completos y lo que
 * falte sea la ubicacion.
 */
export interface B1BinAllocation {
  /** `AbsEntry` de la ubicacion. */
  BinAbsEntry: number
  Quantity: number
  /** `LineNum` del renglon. */
  BaseLineNumber: number
  /**
   * Indice del lote dentro de `BatchNumbers` de ese renglon, cuando el articulo
   * los usa. Enlaza "cuanto de ESTE lote va a ESTA ubicacion".
   */
  SerialAndBatchNumbersBaseLine?: number
}

/** Almacen, con lo unico que decide si hacen falta ubicaciones. */
export interface B1Warehouse {
  WarehouseCode: string
  WarehouseName?: string | null
  EnableBinLocations?: B1YesNo | null
}

/** Ubicacion de un almacen. */
export interface B1BinLocation {
  AbsEntry: number
  BinCode: string
  Warehouse: string
  /** La ubicacion por defecto que crea B1 al activar ubicaciones. */
  IsSystemBin?: B1YesNo | null
}

/** Entrada de mercancia copiada de la OC: cada linea lleva BaseType 22 (OC5). */
export interface CreatePurchaseDeliveryNotePayload {
  CardCode: string
  DocDate: B1Date
  Comments?: string
  DocumentLines: Array<{
    BaseType: typeof B1_OBJECT_TYPE.PurchaseOrder
    BaseEntry: number
    BaseLine: number
    Quantity: number
    /** Solo en articulos gestionados por lote. */
    BatchNumbers?: B1BatchNumber[]
    /** Solo en almacenes con ubicaciones activas. */
    DocumentLinesBinAllocations?: B1BinAllocation[]
  }>
}

/**
 * Factura de mercancia: se copia desde la entrada, con BaseType 20
 * (§00 consecuencia 01). No se captura la linea a mano.
 */
export interface CreatePurchaseInvoiceFromDeliveryPayload {
  CardCode: string
  DocDate: B1Date
  DocDueDate?: B1Date
  DocCurrency?: string
  /** Donde se escribe el UUID del CFDI cuando la estrategia es `NumAtCard`. */
  NumAtCard?: string
  Comments?: string
  DocumentLines: Array<{
    BaseType: typeof B1_OBJECT_TYPE.PurchaseDeliveryNote
    BaseEntry: number
    BaseLine: number
    Quantity?: number
  }>
  /** Campos de usuario, para la estrategia `UserField` del UUID. */
  userFields?: Record<string, unknown>
}

/**
 * Factura de servicio: `dDocument_Service`, con AccountCode y CostingCode por
 * linea (§00 consecuencia 04). Sin orden de compra ni entrada.
 */
export interface CreateServiceInvoicePayload {
  CardCode: string
  DocDate: B1Date
  DocDueDate?: B1Date
  DocCurrency?: string
  NumAtCard?: string
  Comments?: string
  DocType: 'dDocument_Service'
  DocumentLines: Array<{
    ItemDescription: string
    AccountCode: string
    CostingCode?: string
    LineTotal: number
    TaxCode?: string
  }>
  userFields?: Record<string, unknown>
}

/** Nota de credito de compra, copiada de la factura (BaseType 18). */
export interface CreatePurchaseCreditNotePayload {
  CardCode: string
  DocDate: B1Date
  DocCurrency?: string
  NumAtCard?: string
  Comments?: string
  DocumentLines: Array<{
    BaseType: typeof B1_OBJECT_TYPE.PurchaseInvoice
    BaseEntry: number
    BaseLine: number
    Quantity?: number
    LineTotal?: number
  }>
  userFields?: Record<string, unknown>
}

export interface AttachmentInput {
  fileName: string
  /** Extension sin punto: `xml`, `pdf`. */
  fileExtension: string
  content: Buffer
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

export interface ListOptions {
  /** Filtra por socio de negocio. */
  cardCode?: string
  /** Solo documentos modificados a partir de esta fecha (sync incremental). */
  updatedSince?: Date
  /**
   * Solo documentos con `DocDate` a partir de esta fecha.
   *
   * Distinto de `updatedSince`, que mira `UpdateDate`. Sirve para acotar una
   * busqueda por la fecha del negocio: una entrada de mercancia nunca es
   * anterior a la orden que surte, asi que buscar las entradas de una orden no
   * necesita mirar el historico entero.
   */
  docDateFrom?: Date
  /**
   * Solo estos documentos, por `DocEntry`.
   *
   * Sirve para traer de golpe los renglones de las ordenes que caben en una
   * pantalla: sin esto habria que pedir cada orden por separado, y una tabla de
   * 20 filas serian 20 viajes a B1.
   */
  docEntries?: readonly number[]
  /** Solo documentos con DocEntry mayor a este (cursor). */
  afterDocEntry?: number
  /** Solo documentos abiertos. */
  openOnly?: boolean
  top?: number
  skip?: number
}

export interface Page<T> {
  readonly items: readonly T[]
  /**
   * Filas que cumplen el filtro, ignorando `$top` y `$skip`. Sale del
   * `odata.count` que devuelve B1 cuando se pide `$count`. Es lo que permite
   * paginar sabiendo cuantas paginas hay, en vez de adivinarlo.
   */
  readonly total?: number
  /** Presente cuando quedan filas despues de esta pagina. */
  readonly nextSkip?: number
}

// ---------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------

export type SapErrorKind =
  | 'auth'
  | 'not_found'
  | 'conflict'
  | 'validation'
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'unknown'

/**
 * Error normalizado del Service Layer. B1 devuelve mensajes poco descriptivos
 * (`error.message.value`), asi que se conserva el codigo crudo para la bitacora.
 */
export class SapError extends Error {
  constructor(
    readonly kind: SapErrorKind,
    message: string,
    readonly options: {
      readonly httpStatus?: number
      readonly sapCode?: number | string
      readonly retryable?: boolean
      readonly cause?: unknown
    } = {},
  ) {
    super(message)
    this.name = 'SapError'
  }

  get retryable(): boolean {
    return (
      this.options.retryable ?? ['timeout', 'network', 'rate_limit', 'auth'].includes(this.kind)
    )
  }
}

// ---------------------------------------------------------------------------
// El adaptador
// ---------------------------------------------------------------------------

/**
 * §04 principio 2: ninguna llamada a SAP ocurre dentro de un request HTTP del
 * portal. Todo consumidor de esta interfaz corre dentro de un worker de cola.
 */
export interface SapB1Client {
  /** Verifica credenciales y conectividad. Usado por el healthcheck. */
  ping(): Promise<{ ok: boolean; companyDb: string; version?: string }>

  // Socios de negocio
  getBusinessPartner(cardCode: string): Promise<B1BusinessPartner | null>
  listBusinessPartners(options?: ListOptions): Promise<Page<B1BusinessPartner>>
  /** Escenario A de §05 (pendiente 20.1). Devuelve el CardCode asignado por B1. */
  createBusinessPartner(payload: CreateBusinessPartnerPayload): Promise<B1BusinessPartner>

  /** Catalogo de condiciones de pago, para resolver PayTermsGrpCode a su nombre. */
  listPaymentTermsTypes(): Promise<readonly B1PaymentTermsType[]>

  /**
   * Articulos por codigo. Se usa para saber, ANTES de capturar una entrada, si
   * alguno de ellos B1 no va a admitir: no inventariable, por lote o por serie.
   */
  listItems(itemCodes: readonly string[]): Promise<readonly B1Item[]>

  /**
   * Los articulos que NO se pueden capturar sin datos extra: por lote, por
   * numero de serie, o no inventariables.
   *
   * Devuelve solo esos, no el catalogo entero: es una consulta acotada que sirve
   * para marcar de un vistazo que ordenes se pueden recibir desde el portal.
   */
  listItemsConGestion(): Promise<readonly B1Item[]>

  /**
   * La ubicacion de sistema de cada almacen que use ubicaciones.
   *
   * Devuelve un mapa `WarehouseCode -> AbsEntry`. Los almacenes SIN ubicaciones
   * no aparecen: mandarles un reparto haria que B1 rechazara el documento.
   */
  binsDeSistema(warehouseCodes: readonly string[]): Promise<ReadonlyMap<string, number>>

  // Ordenes de compra
  getPurchaseOrder(docEntry: number): Promise<B1PurchaseOrder | null>
  listPurchaseOrders(options?: ListOptions): Promise<Page<B1PurchaseOrder>>
  /**
   * Igual que `listPurchaseOrders` pero pidiendo tambien `DocumentLines`.
   *
   * Pensada para usarse con `docEntries`: el listado de ordenes trae solo
   * cabeceras, y las cantidades por renglon —lo pedido— viven en las lineas.
   * Traerlas para TODO el historico seria carisimo; para las 20 que se ven en
   * pantalla es una sola consulta.
   */
  listPurchaseOrdersWithLines(options?: ListOptions): Promise<Page<B1PurchaseOrder>>
  /** Solo si KPS captura la OC desde el portal (pendiente 20.2). */
  createPurchaseOrder(payload: CreatePurchaseOrderPayload): Promise<B1PurchaseOrder>

  // Entradas de mercancia
  getPurchaseDeliveryNote(docEntry: number): Promise<B1PurchaseDeliveryNote | null>
  listPurchaseDeliveryNotes(options?: ListOptions): Promise<Page<B1PurchaseDeliveryNote>>
  /**
   * Igual que `listPurchaseDeliveryNotes` pero pidiendo tambien `DocumentLines`.
   *
   * Existe como metodo aparte y no como bandera porque la diferencia de coste es
   * grande —cada documento se trae con todos sus renglones— y conviene que se
   * vea en la llamada. Es la unica forma de saber cuanta mercancia llego contra
   * una orden: el enlace vive en la linea (`BaseEntry` + `BaseLine`) y este
   * Service Layer no admite filtrar por campos de linea, asi que el cruce se
   * hace despues de leer.
   */
  listPurchaseDeliveryNotesWithLines(options?: ListOptions): Promise<Page<B1PurchaseDeliveryNote>>
  createPurchaseDeliveryNote(
    payload: CreatePurchaseDeliveryNotePayload,
  ): Promise<B1PurchaseDeliveryNote>

  // Facturas
  getPurchaseInvoice(docEntry: number): Promise<B1PurchaseInvoice | null>
  /**
   * Busca una factura ya registrada por el UUID del CFDI.
   *
   * Es la pieza que hace idempotente el registro: §04 principio 3 obliga a
   * consultar B1 por el UUID antes de crear, porque el Service Layer no ofrece
   * clave de idempotencia. Donde vive el UUID lo decide `CFDI_UUID_STRATEGY`
   * (§00 consecuencia 06, BLOQUEANTE).
   */
  findPurchaseInvoiceByCfdiUuid(uuid: string): Promise<B1PurchaseInvoice | null>
  createPurchaseInvoiceFromDelivery(
    payload: CreatePurchaseInvoiceFromDeliveryPayload,
  ): Promise<B1PurchaseInvoice>
  createServiceInvoice(payload: CreateServiceInvoicePayload): Promise<B1PurchaseInvoice>

  // Notas de credito
  findPurchaseCreditNoteByCfdiUuid(uuid: string): Promise<B1PurchaseCreditNote | null>
  createPurchaseCreditNote(payload: CreatePurchaseCreditNotePayload): Promise<B1PurchaseCreditNote>

  /** Adjunta XML y PDF al documento. Devuelve el AttachmentEntry de B1. */
  attachToDocument(
    objectType: B1ObjectType,
    docEntry: number,
    files: readonly AttachmentInput[],
  ): Promise<number>
}
