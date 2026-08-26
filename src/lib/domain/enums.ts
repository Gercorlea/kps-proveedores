/**
 * Enumeraciones del dominio.
 *
 * Antes venian del cliente generado por Prisma. Al pasar a MongoDB con el
 * driver oficial ya no hay generador, asi que viven aqui y son la unica fuente
 * de verdad: los documentos guardan estas cadenas tal cual.
 *
 * Se declaran como objetos `as const` y no como `enum` de TypeScript porque los
 * enum de TS generan codigo en runtime y no son asignables desde una cadena
 * leida de la base sin castear.
 */

export const SupplierType = {
  MERCANCIA: 'MERCANCIA',
  SERVICIO: 'SERVICIO',
} as const
export type SupplierType = (typeof SupplierType)[keyof typeof SupplierType]

/** §10.1 — maquina de estados del proveedor. */
export const SupplierStatus = {
  ALTA_PENDIENTE: 'ALTA_PENDIENTE',
  ALTA_CORRECCION: 'ALTA_CORRECCION',
  ALTA_RECHAZADA: 'ALTA_RECHAZADA',
  ACTIVO: 'ACTIVO',
  BLOQUEADO: 'BLOQUEADO',
  INACTIVO: 'INACTIVO',
} as const
export type SupplierStatus = (typeof SupplierStatus)[keyof typeof SupplierStatus]

export const OnboardingDecision = {
  AUTORIZADO: 'AUTORIZADO',
  RECHAZADO: 'RECHAZADO',
  CORRECCION: 'CORRECCION',
} as const
export type OnboardingDecision = (typeof OnboardingDecision)[keyof typeof OnboardingDecision]

/** §10.3 — maquina de estados de la orden de compra. */
export const PoStatus = {
  ABIERTA: 'ABIERTA',
  PARCIALMENTE_FACTURADA: 'PARCIALMENTE_FACTURADA',
  FACTURADA_COMPLETA: 'FACTURADA_COMPLETA',
  CERRADA_PAGADA: 'CERRADA_PAGADA',
} as const
export type PoStatus = (typeof PoStatus)[keyof typeof PoStatus]

export const InvoiceType = {
  MERCANCIA: 'MERCANCIA',
  SERVICIO: 'SERVICIO',
} as const
export type InvoiceType = (typeof InvoiceType)[keyof typeof InvoiceType]

/** §10.2 — maquina de estados de la factura. */
export const InvoiceStatus = {
  BORRADOR: 'BORRADOR',
  EN_VALIDACION: 'EN_VALIDACION',
  EN_COTEJO: 'EN_COTEJO',
  NC_SOLICITADA: 'NC_SOLICITADA',
  NC_EN_REVISION: 'NC_EN_REVISION',
  EN_REVISION: 'EN_REVISION',
  EN_CORRECCION: 'EN_CORRECCION',
  APROBADA_PAGO: 'APROBADA_PAGO',
  REGISTRADA_SAP: 'REGISTRADA_SAP',
  CUENTAS_POR_PAGAR: 'CUENTAS_POR_PAGAR',
  PAGADA: 'PAGADA',
  CERRADA: 'CERRADA',
  RECHAZADA: 'RECHAZADA',
  DUPLICADA: 'DUPLICADA',
  ERROR_SAP: 'ERROR_SAP',
} as const
export type InvoiceStatus = (typeof InvoiceStatus)[keyof typeof InvoiceStatus]

export const CreditNoteStatus = {
  PENDIENTE: 'PENDIENTE',
  APROBADA: 'APROBADA',
  RECHAZADA: 'RECHAZADA',
} as const
export type CreditNoteStatus = (typeof CreditNoteStatus)[keyof typeof CreditNoteStatus]

export const Severity = {
  BLOQUEANTE: 'BLOQUEANTE',
  ADVERTENCIA: 'ADVERTENCIA',
  INFO: 'INFO',
} as const
export type Severity = (typeof Severity)[keyof typeof Severity]

/** §02 — actores y roles. */
export const UserRole = {
  PROVEEDOR_MERCANCIA: 'PROVEEDOR_MERCANCIA',
  PROVEEDOR_SERVICIO: 'PROVEEDOR_SERVICIO',
  KPS_ALTAS: 'KPS_ALTAS',
  KPS_REVISION: 'KPS_REVISION',
  KPS_PAGOS: 'KPS_PAGOS',
  KPS_COMPRAS: 'KPS_COMPRAS',
  ADMIN_SISTEMA: 'ADMIN_SISTEMA',
} as const
export type UserRole = (typeof UserRole)[keyof typeof UserRole]

export const ROLES_INTERNOS: readonly UserRole[] = [
  UserRole.KPS_ALTAS,
  UserRole.KPS_REVISION,
  UserRole.KPS_PAGOS,
  UserRole.KPS_COMPRAS,
  UserRole.ADMIN_SISTEMA,
]

export function esRolInterno(roles: readonly string[]): boolean {
  return roles.some((r) => (ROLES_INTERNOS as readonly string[]).includes(r))
}

// ---------------------------------------------------------------------------
// Avisos
// ---------------------------------------------------------------------------

/**
 * Clases de aviso que puede recibir un proveedor.
 *
 * Casi todas nacen de un cambio de estatus de una factura, pero el tipo se
 * declara aparte y no se reutiliza `InvoiceStatus`: hay avisos que no son de
 * ninguna factura —la cuenta retenida, un recado de KPS— y meterlos en la
 * maquina de estados de la factura la ensuciaria para siempre.
 */
export const NotificationType = {
  FACTURA_APROBADA: 'FACTURA_APROBADA',
  FACTURA_DEVUELTA: 'FACTURA_DEVUELTA',
  FACTURA_RECHAZADA: 'FACTURA_RECHAZADA',
  FACTURA_DUPLICADA: 'FACTURA_DUPLICADA',
  FACTURA_REGISTRADA: 'FACTURA_REGISTRADA',
  FACTURA_EN_PAGO: 'FACTURA_EN_PAGO',
  FACTURA_PAGADA: 'FACTURA_PAGADA',
  NOTA_CREDITO: 'NOTA_CREDITO',
  CUENTA_RETENIDA: 'CUENTA_RETENIDA',
  AVISO_GENERAL: 'AVISO_GENERAL',
} as const
export type NotificationType = (typeof NotificationType)[keyof typeof NotificationType]

/** Titulo corto del aviso. Es lo que se lee primero en la campana. */
export const ETIQUETA_AVISO: Record<NotificationType, string> = {
  FACTURA_APROBADA: 'Factura aprobada para pago',
  FACTURA_DEVUELTA: 'Factura devuelta para correccion',
  FACTURA_RECHAZADA: 'Factura rechazada',
  FACTURA_DUPLICADA: 'Factura duplicada',
  FACTURA_REGISTRADA: 'Factura registrada en Business One',
  FACTURA_EN_PAGO: 'Factura en cuentas por pagar',
  FACTURA_PAGADA: 'Factura pagada · falta tu recibo',
  NOTA_CREDITO: 'Se te pide una nota de credito',
  CUENTA_RETENIDA: 'Tu cuenta esta retenida',
  AVISO_GENERAL: 'Aviso de KPS',
}

export const TONO_AVISO: Record<NotificationType, TonoEstatus> = {
  FACTURA_APROBADA: 'ok',
  FACTURA_DEVUELTA: 'danger',
  FACTURA_RECHAZADA: 'danger',
  FACTURA_DUPLICADA: 'danger',
  FACTURA_REGISTRADA: 'ok',
  FACTURA_EN_PAGO: null,
  FACTURA_PAGADA: 'warn',
  NOTA_CREDITO: 'warn',
  CUENTA_RETENIDA: 'danger',
  AVISO_GENERAL: null,
}

/**
 * Que cambio de estatus genera aviso y de que clase.
 *
 * Estan SOLO los que decide KPS. Los que provoca el propio proveedor —guardar
 * un borrador, enviarlo a revision— no avisan a nadie: contarle a alguien algo
 * que acaba de hacer convierte la campana en ruido y esconde lo unico que si
 * tiene que ver. Un estatus que no aparezca aqui no genera aviso.
 */
export const AVISO_POR_ESTATUS: Partial<Record<InvoiceStatus, NotificationType>> = {
  APROBADA_PAGO: NotificationType.FACTURA_APROBADA,
  EN_CORRECCION: NotificationType.FACTURA_DEVUELTA,
  RECHAZADA: NotificationType.FACTURA_RECHAZADA,
  DUPLICADA: NotificationType.FACTURA_DUPLICADA,
  REGISTRADA_SAP: NotificationType.FACTURA_REGISTRADA,
  CUENTAS_POR_PAGAR: NotificationType.FACTURA_EN_PAGO,
  PAGADA: NotificationType.FACTURA_PAGADA,
  NC_SOLICITADA: NotificationType.NOTA_CREDITO,
}

/** Resultado del motor de cotejo (§06). */
export const MatchOutcome = {
  COINCIDE: 'COINCIDE',
  FACTURA_MAYOR: 'FACTURA_MAYOR',
  FACTURA_MENOR: 'FACTURA_MENOR',
  DIFERENCIA_PRECIO: 'DIFERENCIA_PRECIO',
  MONEDA_DISTINTA: 'MONEDA_DISTINTA',
  SIN_DATOS: 'SIN_DATOS',
} as const
export type MatchOutcome = (typeof MatchOutcome)[keyof typeof MatchOutcome]

/** Lectura para el proveedor de cada estatus (§06 del documento de diseno). */
export const ETIQUETA_PROVEEDOR: Record<InvoiceStatus, string> = {
  BORRADOR: 'Borrador',
  EN_VALIDACION: 'Validando',
  EN_COTEJO: 'Cotejando',
  NC_SOLICITADA: 'Requiere nota de credito',
  NC_EN_REVISION: 'Nota de credito en revision',
  EN_REVISION: 'En revision',
  EN_CORRECCION: 'Requiere correccion',
  APROBADA_PAGO: 'Aprobada para pago',
  REGISTRADA_SAP: 'Registrada',
  CUENTAS_POR_PAGAR: 'En cuentas por pagar',
  PAGADA: 'Pagada · falta tu recibo',
  CERRADA: 'Cerrada',
  RECHAZADA: 'Rechazada',
  DUPLICADA: 'Duplicada',
  // El fallo es de KPS, no del proveedor, y no hay nada que pueda hacer: se le
  // muestra como "Registrando" y el error completo se guarda para KPS.
  ERROR_SAP: 'Registrando',
}

/** Color del indicador de estatus. `null` = neutro, sin tono. */
export type TonoEstatus = 'ok' | 'warn' | 'danger' | 'ai' | null

export const TONO_ESTATUS: Record<InvoiceStatus, TonoEstatus> = {
  BORRADOR: null,
  EN_VALIDACION: 'ai',
  EN_COTEJO: 'ai',
  NC_SOLICITADA: 'danger',
  NC_EN_REVISION: 'warn',
  EN_REVISION: 'warn',
  EN_CORRECCION: 'danger',
  APROBADA_PAGO: 'ok',
  REGISTRADA_SAP: 'ok',
  CUENTAS_POR_PAGAR: null,
  PAGADA: 'warn',
  CERRADA: 'ok',
  RECHAZADA: 'danger',
  DUPLICADA: 'danger',
  ERROR_SAP: 'danger',
}

/** Lectura para el personal de KPS. */
export const ETIQUETA_KPS: Record<InvoiceStatus, string> = {
  BORRADOR: 'Borrador',
  EN_VALIDACION: 'Validando',
  EN_COTEJO: 'Cotejando',
  NC_SOLICITADA: 'Nota de credito solicitada',
  NC_EN_REVISION: 'NC por revisar',
  EN_REVISION: 'Por revisar',
  EN_CORRECCION: 'Devuelta al proveedor',
  APROBADA_PAGO: 'Aprobada para pago',
  REGISTRADA_SAP: 'Registrada en Business One',
  CUENTAS_POR_PAGAR: 'En cuentas por pagar',
  PAGADA: 'Pagada · recibo pendiente',
  CERRADA: 'Cerrada',
  RECHAZADA: 'Rechazada',
  DUPLICADA: 'Duplicada',
  ERROR_SAP: 'Error de Business One',
}
