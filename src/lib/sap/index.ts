import { getConfig } from '../config'
import { ServiceLayerClient } from './service-layer'
import type { SapB1Client } from './types'

export * from './types'
export { ServiceLayerClient } from './service-layer'

/**
 * Punto unico de acceso a Business One.
 *
 * El cliente se memoiza a proposito: mantiene la sesion del Service Layer
 * abierta entre peticiones. Crear uno nuevo por request abriria una sesion
 * nueva cada vez y agotaria el cupo de sesiones concurrentes de B1.
 */
let client: SapB1Client | null = null

export function getSapClient(): SapB1Client {
  if (client) return client

  const { driver } = getConfig().sap
  if (driver === 'mock') {
    // MockB1Client todavia no existe. Se avisa de forma explicita en vez de
    // devolver un cliente a medias que falle mas tarde y mas lejos.
    throw new Error(
      'SAP_DRIVER=mock pero MockB1Client aun no esta implementado. Pon SAP_DRIVER=service-layer en tu .env para usar la instancia real.',
    )
  }

  client = new ServiceLayerClient()
  return client
}

export function resetSapClientForTests(instance: SapB1Client | null = null): void {
  client = instance
}
