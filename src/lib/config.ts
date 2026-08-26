import { z } from 'zod'
import { Decimal } from 'decimal.js'

/**
 * Configuracion del portal, validada al arrancar.
 *
 * Cada decision que el spec dejo abierta en §20 vive aqui como bandera con su
 * numero de pendiente en el comentario, para que sea greppable el dia que KPS
 * conteste: `grep -rn "pendiente 20\." src/lib/config.ts`.
 */

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'si', 'sí'].includes(v.toLowerCase()),
  )

const decimalString = z
  .string()
  .refine((v) => {
    try {
      return new Decimal(v).isFinite()
    } catch {
      return false
    }
  }, 'debe ser un numero decimal valido')
  .transform((v) => new Decimal(v))

/** RFC mexicano: 12 posiciones para persona moral, 13 para fisica. */
export const RFC_PATTERN = /^([A-ZÑ&]{3,4})\d{6}([A-Z\d]{3})$/

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Estas son opcionales a proposito. Leer ordenes de compra de SAP no deberia
  // exigir una base de datos ni el RFC de KPS: si se declaran obligatorias, un
  // .env con solo credenciales de B1 tumba todo el portal. La exigencia se
  // aplica en el punto de uso, con requireMongoUri() y requireKps(), que fallan
  // diciendo exactamente que variable falta.
  MONGODB_URI: z.string().min(1).optional(),
  MONGODB_DB: z.string().min(1).default('kps_proveedores'),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

  // --- KPS como receptor de los CFDI (§12.2 regla RFC_RECEPTOR) ---
  KPS_RFC: z.string().regex(RFC_PATTERN, 'KPS_RFC no tiene formato de RFC valido').optional(),
  KPS_RAZON_SOCIAL: z.string().min(1).optional(),

  // --- SAP Business One Service Layer (§04, §16) ---
  // El portal lee de B1 en vivo las ordenes de compra del proveedor que entro.
  // Los nombres son los MISMOS que usa kps-dashboard, para que un solo .env
  // sirva a los dos proyectos y no haya dos juegos de credenciales de B1.
  SAP_DRIVER: z.enum(['mock', 'service-layer']).default('service-layer'),
  SAP_SL_URL: z.string().default('https://localhost:50000/b1s/v2'),
  SAP_SL_COMPANY_DB: z.string().default('SBO_KPS'),
  SAP_SL_USERNAME: z.string().default(''),
  SAP_SL_PASSWORD: z.string().default(''),
  /** El Service Layer limita sesiones concurrentes; el pool nunca las excede. */
  SAP_SL_MAX_SESSIONS: z.coerce.number().int().positive().default(4),
  /** Las sesiones expiran a los ~30 min. Se renuevan antes, con margen. */
  SAP_SL_SESSION_TTL_MS: z.coerce.number().int().positive().default(25 * 60 * 1000),
  SAP_SL_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  /**
   * Tamano de pagina que se pide con la cabecera `Prefer: odata.maxpagesize=N`.
   * Sin ella el Service Layer devuelve 20 filas por respuesta (el PageSize de
   * b1s.conf) aunque el $top pida mas, y la lectura se queda corta en silencio.
   */
  SAP_SL_PAGE_SIZE: z.coerce.number().int().positive().max(100).default(100),
  SAP_SL_MAX_RETRIES: z.coerce.number().int().min(0).default(3),
  /** B1 suele exponerse con certificado autofirmado en instalaciones on-premise. */
  SAP_SL_REJECT_UNAUTHORIZED: bool.default(true),

  // --- UUID del CFDI en B1 (§00 consecuencia 06 — BLOQUEANTE) ---
  // B1 no tiene campo estandar para el UUID. Hasta que KPS confirme cual usa su
  // instalacion, la estrategia es configurable y el adaptador la respeta.
  CFDI_UUID_STRATEGY: z.enum(['NumAtCard', 'UserField', 'AddOn']).default('NumAtCard'),
  CFDI_UUID_USER_FIELD: z.string().default('U_CFDI_UUID'),

  // --- Alta de proveedor (§05, pendiente 20.1) ---
  // `link`  = escenario B: KPS elige un CardCode que ya existe en B1.
  // `create`= escenario A: el portal hace POST /BusinessPartners al autorizar.
  // El default es `link` porque crear el socio exige conocer serie, grupo,
  // ControlAccount y PayTermsGrpCode obligatorios de la instancia de KPS.
  SUPPLIER_LINK_MODE: z.enum(['link', 'create']).default('link'),
  SUPPLIER_DEFAULT_GROUP_CODE: z.coerce.number().int().optional(),
  SUPPLIER_DEFAULT_SERIES: z.coerce.number().int().optional(),
  SUPPLIER_DEFAULT_CONTROL_ACCOUNT: z.string().optional(),
  /** Vigencia maxima de la constancia de situacion fiscal (regla AL3, {{3 meses}}). */
  TAX_CERT_MAX_AGE_MONTHS: z.coerce.number().int().positive().default(3),

  // --- Cotejo (§06, pendientes 20.5 y 20.6) ---
  /** Tolerancia absoluta en el cotejo (regla M11). Default: exacto al centavo. */
  MATCH_TOLERANCE_ABS: decimalString.default(new Decimal(0)),
  /** Tolerancia relativa como fraccion: 0.005 = 0.5%. */
  MATCH_TOLERANCE_PCT: decimalString.default(new Decimal(0)),
  /**
   * Que hacer cuando la factura es MENOR que lo recibido (pendiente 20.6).
   * `saldo`   = se acepta y la entrada conserva saldo por facturar. B1 lo permite
   *             de forma natural via RemainingOpenQuantity.
   * `rechazo` = se devuelve al proveedor.
   */
  MATCH_UNDER_INVOICE_POLICY: z.enum(['saldo', 'rechazo']).default('saldo'),

  // --- Orden de compra (§09, pendiente 20.2) ---
  /** Si KPS captura la OC desde el portal (POST /PurchaseOrders) o solo la lee. */
  FEATURE_PO_FROM_PORTAL: bool.default(false),
  /**
   * Deja que un proveedor capture entradas de mercancia de SUS ordenes.
   *
   * SOLO PARA PRUEBAS, y por eso el default es `false`. En la operacion real la
   * entrada la registra almacen cuando el camion descarga: es la constancia de
   * KPS de que el material llego. Si la captura el proveedor, esta declarando el
   * la mercancia que luego va a cobrar, y el cotejo deja de comparar dos fuentes
   * —lo que KPS recibio contra lo que el proveedor factura— para comparar al
   * proveedor consigo mismo.
   *
   * Con la bandera encendida sigue acotado a sus propias ordenes: nunca ve ni
   * puede capturar contra la orden de otro proveedor.
   */
  FEATURE_ENTRADAS_PROVEEDOR: bool.default(false),
  /** Regla OC2: la OC llega al portal en menos de N minutos. */
  PO_SYNC_INTERVAL_MINUTES: z.coerce.number().int().positive().default(15),

  // --- Pagos (§08, pendiente 20.10) ---
  /** Dias para subir el recibo antes de bloquear al proveedor (regla P5). */
  PAYMENT_RECEIPT_DEADLINE_DAYS: z.coerce.number().int().positive().default(10),
  /** Recordatorios al proveedor antes del bloqueo (regla P7), en dias previos. */
  PAYMENT_RECEIPT_REMINDER_DAYS: z
    .string()
    .default('3,1')
    .transform((v) =>
      v
        .split(',')
        .map((n) => Number.parseInt(n.trim(), 10))
        .filter((n) => Number.isInteger(n) && n > 0),
    ),

  // --- Validacion ante el SAT (§12.2 regla SAT_VIGENTE) ---
  SAT_VALIDATION_ENABLED: bool.default(true),
  SAT_CONSULTA_URL: z
    .string()
    .default('https://consultaqr.facturaelectronica.sat.gob.mx/ConsultaCFDIService.svc'),
  SAT_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  /**
   * Cuanto vale una respuesta del SAT antes de volver a preguntar.
   *
   * El estado de un CFDI cambia: una factura vigente hoy puede estar cancelada
   * manana. Pero preguntar en cada pantallazo saturaria un servicio publico que
   * ya es lento. Un dia es el compromiso: al cargar la factura se pregunta en
   * fresco, y las relecturas posteriores se sirven de cache.
   */
  SAT_CACHE_TTL_HOURS: z.coerce.number().int().positive().default(24),

  // --- Lista 69-B: empresas que facturan operaciones simuladas (EFOS) ---
  // Articulo 69-B del CFF. Una factura de un RFC "definitivo" en esa lista NO
  // es deducible ni acreditable, y el SAT puede exigir la devolucion del IVA
  // acreditado anos despues. Es la comprobacion mas barata que evita mas dinero.
  LISTA_69B_ENABLED: bool.default(true),
  LISTA_69B_URL: z
    .string()
    .default('http://omawww.sat.gob.mx/cifras_sat/Documents/Listado_Completo_69-B.csv'),
  /** Cada cuanto se rebaja el CSV del SAT. El SAT lo publica quincenalmente. */
  LISTA_69B_MAX_AGE_HOURS: z.coerce.number().int().positive().default(24 * 7),
  LISTA_69B_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),

  // --- Validaciones tecnicas del XML (§12.2) ---
  /**
   * Comprueba el certificado del emisor: que sea un X.509 de verdad, que su
   * numero de serie sea el que declara `NoCertificado`, que el RFC del sujeto
   * sea el del emisor y que estuviera vigente el dia del timbrado.
   *
   * Se puede apagar para probar con XML inventados. En produccion NO se apaga:
   * es lo unico que distingue un CFDI de un archivo de texto bien formado.
   */
  CFDI_VERIFICAR_CERTIFICADO: bool.default(true),
  /**
   * Comprueba las reglas del Anexo 20 que un XSD haria cumplir: catalogos del
   * SAT (Moneda, FormaPago, MetodoPago, UsoCFDI, RegimenFiscal), patrones
   * (RFC, LugarExpedicion, UUID) y las reglas cruzadas de CFDI 4.0.
   *
   * SE HACE EN CODIGO Y NO CON EL XSD. Validar contra el esquema exige los .xsd
   * del SAT en disco y una libreria nativa; y aun asi el XSD no cubre las
   * reglas cruzadas —"si la moneda no es MXN, TipoCambio es obligatorio"— que
   * son las que de verdad hacen que un PAC rechace un comprobante.
   */
  CFDI_VERIFICAR_ESTRUCTURA: bool.default(true),

  // --- Retenciones (§12.2 regla RETENCIONES) ---
  /**
   * Traduccion de impuesto retenido del CFDI al `WTCode` de Business One.
   *
   * Formato: `002:IVA_RET_4,001:ISR_RET_10`. La clave es el codigo del SAT
   * (001=ISR, 002=IVA, 003=IEPS); el valor, el codigo de retencion de B1.
   *
   * VACIO POR DEFECTO A PROPOSITO. Los `WTCode` son de la instalacion de KPS y
   * nadie fuera de KPS los conoce. Mientras este vacio, una factura CON
   * retenciones se marca en rojo en vez de registrarse en B1 sin ellas: una
   * factura registrada por su importe bruto le paga al proveedor lo que ya se
   * le retuvo, y ese dinero no vuelve.
   */
  RETENCIONES_WT_CODES: z
    .string()
    .default('')
    .transform((v) => {
      const mapa = new Map<string, string>()
      for (const par of v.split(',')) {
        const [clave, codigo] = par.split(':').map((s) => s.trim())
        if (clave && codigo) mapa.set(clave, codigo)
      }
      return mapa
    }),

  // --- Object store (§04): privado, URLs firmadas de 5 minutos ---
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('kps-proveedores'),
  S3_ACCESS_KEY_ID: z.string().default(''),
  S3_SECRET_ACCESS_KEY: z.string().default(''),
  S3_FORCE_PATH_STYLE: bool.default(true),
  S3_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().default(300),

  // --- Autenticacion ---
  // Opcional por el mismo motivo que DATABASE_URL: se exige al autenticar, no
  // al arrancar. Minimo 32 caracteres: openssl rand -base64 48
  JWT_SECRET: z.string().min(32, 'JWT_SECRET debe tener al menos 32 caracteres').optional(),
  JWT_TTL_SECONDS: z.coerce.number().int().positive().default(8 * 60 * 60),
  OIDC_ISSUER: z.string().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),

  // --- Correo (§07 regla S8) ---
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),
  MAIL_FROM: z.string().default('portal-proveedores@kps.example'),
  /** Buzon interno que recibe el aviso al completarse una carga de servicio. */
  MAIL_KPS_REVISION: z.string().default('cuentasporpagar@kps.example'),

  // --- Limites (§13) ---
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(100),
  UPLOAD_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(20 * 1024 * 1024),
})

export type RawEnv = z.infer<typeof envSchema>

export interface AppConfig {
  readonly nodeEnv: RawEnv['NODE_ENV']
  readonly logLevel: RawEnv['LOG_LEVEL']
  /** Ausente si el .env solo trae credenciales de SAP. Ver requireMongoUri(). */
  readonly mongoUri?: string
  readonly mongoDb: string
  readonly redisUrl: string
  readonly kps: {
    readonly taxId?: string
    readonly legalName?: string
  }
  readonly sap: {
    readonly driver: 'mock' | 'service-layer'
    readonly baseUrl: string
    readonly companyDb: string
    readonly username: string
    readonly password: string
    readonly maxSessions: number
    readonly sessionTtlMs: number
    readonly requestTimeoutMs: number
    readonly pageSize: number
    readonly maxRetries: number
    readonly rejectUnauthorized: boolean
    readonly cfdiUuid: {
      readonly strategy: 'NumAtCard' | 'UserField' | 'AddOn'
      readonly userField: string
    }
  }
  readonly onboarding: {
    readonly linkMode: 'link' | 'create'
    readonly defaultGroupCode?: number
    readonly defaultSeries?: number
    readonly defaultControlAccount?: string
    readonly taxCertMaxAgeMonths: number
  }
  readonly matching: {
    readonly toleranceAbsolute: Decimal
    readonly tolerancePercentage: Decimal
    readonly underInvoicePolicy: 'saldo' | 'rechazo'
  }
  readonly purchaseOrders: {
    readonly createFromPortal: boolean
    readonly syncIntervalMinutes: number
  }
  readonly goodsReceipts: {
    /** SOLO PRUEBAS: el proveedor puede capturar entradas de sus ordenes. */
    readonly supplierCanCapture: boolean
  }
  readonly payments: {
    readonly receiptDeadlineDays: number
    readonly receiptReminderDays: readonly number[]
  }
  readonly sat: {
    readonly enabled: boolean
    readonly consultaUrl: string
    readonly requestTimeoutMs: number
    readonly cacheTtlHours: number
  }
  readonly lista69b: {
    readonly enabled: boolean
    readonly url: string
    readonly maxAgeHours: number
    readonly timeoutMs: number
  }
  readonly cfdi: {
    readonly verificarCertificado: boolean
    readonly verificarEstructura: boolean
    /** Codigo de impuesto del SAT -> `WTCode` de B1. Vacio hasta que KPS lo diga. */
    readonly retencionesWtCodes: ReadonlyMap<string, string>
  }
  readonly storage: {
    readonly endpoint?: string
    readonly region: string
    readonly bucket: string
    readonly accessKeyId: string
    readonly secretAccessKey: string
    readonly forcePathStyle: boolean
    readonly signedUrlTtlSeconds: number
    readonly maxUploadBytes: number
  }
  readonly auth: {
    readonly jwtSecret?: string
    readonly jwtTtlSeconds: number
    readonly oidcIssuer?: string
    readonly oidcClientId?: string
    readonly oidcClientSecret?: string
  }
  readonly mail: {
    readonly host: string
    readonly port: number
    readonly user: string
    readonly password: string
    readonly from: string
    readonly kpsRevisionInbox: string
  }
  readonly limits: {
    readonly perMinute: number
    readonly uploadsPerMinute: number
  }
}

export class ConfigError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Configuracion invalida:\n  - ${issues.join('\n  - ')}`)
    this.name = 'ConfigError'
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env)
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`),
    )
  }
  const e = parsed.data

  return {
    nodeEnv: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    mongoUri: e.MONGODB_URI,
    mongoDb: e.MONGODB_DB,
    redisUrl: e.REDIS_URL,
    kps: { taxId: e.KPS_RFC?.toUpperCase(), legalName: e.KPS_RAZON_SOCIAL },
    sap: {
      driver: e.SAP_DRIVER,
      baseUrl: e.SAP_SL_URL.replace(/\/+$/, ''),
      companyDb: e.SAP_SL_COMPANY_DB,
      username: e.SAP_SL_USERNAME,
      password: e.SAP_SL_PASSWORD,
      maxSessions: e.SAP_SL_MAX_SESSIONS,
      sessionTtlMs: e.SAP_SL_SESSION_TTL_MS,
      requestTimeoutMs: e.SAP_SL_REQUEST_TIMEOUT_MS,
      pageSize: e.SAP_SL_PAGE_SIZE,
      maxRetries: e.SAP_SL_MAX_RETRIES,
      rejectUnauthorized: e.SAP_SL_REJECT_UNAUTHORIZED,
      cfdiUuid: { strategy: e.CFDI_UUID_STRATEGY, userField: e.CFDI_UUID_USER_FIELD },
    },
    onboarding: {
      linkMode: e.SUPPLIER_LINK_MODE,
      defaultGroupCode: e.SUPPLIER_DEFAULT_GROUP_CODE,
      defaultSeries: e.SUPPLIER_DEFAULT_SERIES,
      defaultControlAccount: e.SUPPLIER_DEFAULT_CONTROL_ACCOUNT,
      taxCertMaxAgeMonths: e.TAX_CERT_MAX_AGE_MONTHS,
    },
    matching: {
      toleranceAbsolute: e.MATCH_TOLERANCE_ABS,
      tolerancePercentage: e.MATCH_TOLERANCE_PCT,
      underInvoicePolicy: e.MATCH_UNDER_INVOICE_POLICY,
    },
    purchaseOrders: {
      createFromPortal: e.FEATURE_PO_FROM_PORTAL,
      syncIntervalMinutes: e.PO_SYNC_INTERVAL_MINUTES,
    },
    goodsReceipts: { supplierCanCapture: e.FEATURE_ENTRADAS_PROVEEDOR },
    payments: {
      receiptDeadlineDays: e.PAYMENT_RECEIPT_DEADLINE_DAYS,
      receiptReminderDays: e.PAYMENT_RECEIPT_REMINDER_DAYS,
    },
    sat: {
      enabled: e.SAT_VALIDATION_ENABLED,
      consultaUrl: e.SAT_CONSULTA_URL,
      requestTimeoutMs: e.SAT_REQUEST_TIMEOUT_MS,
      cacheTtlHours: e.SAT_CACHE_TTL_HOURS,
    },
    lista69b: {
      enabled: e.LISTA_69B_ENABLED,
      url: e.LISTA_69B_URL,
      maxAgeHours: e.LISTA_69B_MAX_AGE_HOURS,
      timeoutMs: e.LISTA_69B_TIMEOUT_MS,
    },
    cfdi: {
      verificarCertificado: e.CFDI_VERIFICAR_CERTIFICADO,
      verificarEstructura: e.CFDI_VERIFICAR_ESTRUCTURA,
      retencionesWtCodes: e.RETENCIONES_WT_CODES,
    },
    storage: {
      endpoint: e.S3_ENDPOINT,
      region: e.S3_REGION,
      bucket: e.S3_BUCKET,
      accessKeyId: e.S3_ACCESS_KEY_ID,
      secretAccessKey: e.S3_SECRET_ACCESS_KEY,
      forcePathStyle: e.S3_FORCE_PATH_STYLE,
      signedUrlTtlSeconds: e.S3_SIGNED_URL_TTL_SECONDS,
      maxUploadBytes: e.MAX_UPLOAD_BYTES,
    },
    auth: {
      jwtSecret: e.JWT_SECRET,
      jwtTtlSeconds: e.JWT_TTL_SECONDS,
      oidcIssuer: e.OIDC_ISSUER,
      oidcClientId: e.OIDC_CLIENT_ID,
      oidcClientSecret: e.OIDC_CLIENT_SECRET,
    },
    mail: {
      host: e.SMTP_HOST,
      port: e.SMTP_PORT,
      user: e.SMTP_USER,
      password: e.SMTP_PASSWORD,
      from: e.MAIL_FROM,
      kpsRevisionInbox: e.MAIL_KPS_REVISION,
    },
    limits: {
      perMinute: e.RATE_LIMIT_PER_MINUTE,
      uploadsPerMinute: e.UPLOAD_RATE_LIMIT_PER_MINUTE,
    },
  }
}

let cached: AppConfig | null = null

/** Config del proceso. Se valida una sola vez y se memoiza. */
export function getConfig(): AppConfig {
  cached ??= loadConfig()
  return cached
}

/** Solo para pruebas: descarta la config memoizada. */
export function resetConfigCache(): void {
  cached = null
}

/**
 * Accesores para los valores que solo hacen falta en ciertos flujos.
 *
 * Estan separados de `getConfig()` a proposito: exigirlos al arrancar hacia que
 * un .env con solo credenciales de B1 —que es lo que hay hoy— tumbara tambien
 * las pantallas que unicamente leen de SAP. Cada uno falla con el nombre exacto
 * de la variable que falta, no con "configuracion invalida".
 */

export function requireMongoUri(): string {
  const url = getConfig().mongoUri
  if (!url) {
    throw new ConfigError([
      'MONGODB_URI no esta definida. La necesita todo lo que persiste en el portal.',
    ])
  }
  return url
}

export function requireKps(): { taxId: string; legalName: string } {
  const { taxId, legalName } = getConfig().kps
  if (!taxId || !legalName) {
    throw new ConfigError([
      'KPS_RFC y KPS_RAZON_SOCIAL no estan definidas. Sin el RFC de KPS no se puede validar la regla RFC_RECEPTOR de un CFDI.',
    ])
  }
  return { taxId, legalName }
}

export function requireJwtSecret(): string {
  const secret = getConfig().auth.jwtSecret
  if (!secret) {
    throw new ConfigError([
      'JWT_SECRET no esta definida o tiene menos de 32 caracteres. Genera una con: openssl rand -base64 48',
    ])
  }
  return secret
}
