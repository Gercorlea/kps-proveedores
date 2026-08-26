import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// Pruebas de dominio puro en Node: parser CFDI, cotejo, reglas, maquinas de
// estado. No cargan el runtime de Next ni necesitan base de datos.
export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      reportsDirectory: 'coverage',
      include: ['src/lib/**/*.ts'],
      exclude: ['src/lib/**/__tests__/**', 'src/lib/**/__fixtures__/**', 'src/lib/**/types.ts'],
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
