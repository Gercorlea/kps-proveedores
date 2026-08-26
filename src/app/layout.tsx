import type { Metadata } from 'next'
import './globals.css'

/**
 * Layout raiz. Deliberadamente minimo: solo html, body y la hoja de estilos.
 *
 * El armazon del portal —topbar, sidebar, cabecera de pagina— vive en
 * `(portal)/layout.tsx`. Asi el login y el registro, que estan fuera de ese
 * grupo, se renderizan a pantalla completa sin barra lateral: nadie navega por
 * el portal antes de haber entrado.
 */

export const metadata: Metadata = {
  title: 'Portal de Proveedores KPS',
  description:
    'Alta de proveedores, carga de facturas con evidencia y seguimiento del estatus hasta el pago.',
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  )
}
