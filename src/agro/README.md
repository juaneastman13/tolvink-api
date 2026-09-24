# Módulo Agro — Tolvink (Cruz Del Sur)

Sistema de gestión y contabilidad de gestión agropecuaria. **Aislado** del
módulo de logística: reutiliza infraestructura (auth, Prisma, agente WhatsApp)
pero no comparte modelo de negocio ni tablas.

Spec completa: [`docs/agro/CRUZ_DEL_SUR_MODULO_TOLVINK.md`](../../docs/agro/CRUZ_DEL_SUR_MODULO_TOLVINK.md).

## Convenciones

- **Tablas** con prefijo `agro_`, modelos Prisma `AgroXxx`.
- **Multi-tenant**: cada `AgroEmpresa` pertenece a un `Company` (Tolvink) por
  `companyId`. Un Company puede tener varias empresas agro (multi-empresa).
- **Multi-empresa**: el frontend envía la empresa agro elegida en el header
  `x-agro-empresa-id` (o query `?empresaId=`). `AgroScopeService.resolveEmpresa`
  la valida y devuelve el `empresaId` scope-ado.
- **Roles** dentro de `UserCompany.role`:
  - `agro_admin` — agrónomo/ingeniero, escritura total.
  - `agro_carga` — solo carga de datos.
  - `agro_socio` — solo lectura.
- **Guards**: `ModuleAccessGuard('agro')` valida que la Company tenga `'agro'`
  en `enabledModules` y que el usuario tenga un rol `agro_*`. `AgroRolesGuard`
  + `@AgroRoles(...)` restringe por endpoint.
- **Money**: siempre `{ monto, moneda, tipoCambio, montoUsd }`. El campo
  `montoUsd` se persiste; nunca se recalcula al leer.
- **Append-only**: los movimientos no se borran, se anulan con
  `anuladoAt`/`anuladoPor`/`motivoAnulacion`.

## Estructura

```
src/agro/
├── agro.module.ts
├── common/
│   ├── module-access.guard.ts   # guard fábrica: ModuleAccessGuard('agro')
│   ├── agro-roles.guard.ts      # + @AgroRoles(...) decorator
│   └── agro-scope.service.ts    # resuelve empresaId activa
├── empresa/
│   ├── agro-empresa.controller.ts  # CRUD multi-empresa
│   └── agro-seed.service.ts        # centros/categorías/cuentas base
├── config/agro-config.controller.ts    # AgroConfig (mesInicioEjercicio, etc.)
├── maestros/agro-maestros.controller.ts # centros, categorías, cuentas, terceros, productos
├── tipo-cambio/agro-tipo-cambio.controller.ts # UYU/USD, resolver por fecha
└── dominio/                     # CAPA PURA: sin Nest/Prisma imports
    ├── ejercicio.ts             # §5.1 ejercicio fiscal configurable
    ├── moneda.ts                # conversión UYU→USD canónica
    └── *.spec.ts                # golden tests contra el Excel (Fase 3)
```

## Endpoints

Todos bajo `/agro/*` y protegidos por `JwtAuthGuard + ModuleAccessGuard('agro')`.
El header `x-agro-empresa-id` es requerido cuando la Company tiene más de una
`AgroEmpresa` activa.

### Setup (Fase 1)
| Método | Ruta | Rol mínimo | Descripción |
|---|---|---|---|
| GET/POST/PATCH | `/agro/empresas[/:id]` | admin | CRUD multi-empresa (POST aplica seeds base) |
| GET/PUT | `/agro/config` | admin | Config por empresa |
| GET/POST | `/agro/maestros/centros` | admin | Centros |
| GET/POST | `/agro/maestros/categorias` | admin | Categorías animales con UG |
| GET/POST | `/agro/maestros/cuentas` | admin | Plan de cuentas |
| GET/POST/PATCH | `/agro/maestros/terceros[/:id]` | admin, carga | Terceros |
| GET/POST | `/agro/maestros/productos` | admin | Insumos y granos |
| GET/POST | `/agro/tipo-cambio` | admin, carga | Serie UYU/USD (fuente MANUAL/BCU) |

### Maestros operativos (Fase 2)
| Método | Ruta | Rol mínimo | Descripción |
|---|---|---|---|
| GET/POST/PATCH/DELETE | `/agro/campos[/:id]` | admin | Campos |
| POST/PATCH/DELETE | `/agro/campos/potreros[/:id]` | admin | Potreros |
| GET/POST/PATCH | `/agro/lotes-campania[/:id]?campania=` | admin, carga | Lotes × campaña (orden de producción) |
| GET/POST/PATCH | `/agro/tandas[/:id]` | admin, carga | Tandas de feedlot |
| GET/POST/PATCH | `/agro/prestamos[/:id]` | admin | Préstamos |

### Movimientos (Fase 2 — append-only)
| Método | Ruta | Rol mínimo | Descripción |
|---|---|---|---|
| GET | `/agro/hacienda?desde&hasta&centro&categoriaCod&tandaId&tipo` | agro_* | Lista movs |
| GET | `/agro/hacienda/stock?hasta=` | agro_* | Snapshot de stock a una fecha |
| POST | `/agro/hacienda` | admin, carga | Crea mov con validación de stock |
| POST | `/agro/hacienda/:id/anular` | admin | Anula (append-only) |
| GET/POST | `/agro/granos` | admin, carga | Movs de granos; `tipo=FEEDLOT` aplica §5.2 |
| POST | `/agro/granos/:id/anular` | admin | Anula |
| GET/POST | `/agro/gastos` | admin, carga | Gastos con normalización money |
| POST | `/agro/gastos/:id/anular` | admin | Anula |
| GET/POST | `/agro/labores` | admin, carga | Labores agrícolas |
| POST | `/agro/labores/:id/anular` | admin | Anula |
| GET/POST | `/agro/lluvias` | admin, carga | Registro pluvial |
| POST | `/agro/import/tsv` | admin, carga | Importa TSV/CSV pegado (con dryRun) |

### Validaciones aplicadas en `POST`
- **Hacienda** (`dominio/stock-hacienda.ts`, 12 tests): stock por `(centro, categoriaCod)` nunca negativo; `TRANSF` requiere destino distinto; `RECATEG` requiere categoría destino; `PESADA/DICOSE/TACTO` no mueven stock; `INVENTARIO` setea saldo absoluto.
- **Granos**: `FEEDLOT` requiere `tandaId` + `precioNetoUsdT` o (`precioReferenciaUsdT` [+`fleteUsdT`+`comisionUsdT`]) — se auto-calcula el neto en campo (`dominio/transferencia-grano.ts`).
- **Gastos**: `moneda + monto + tipoCambio → montoUsd` persistido. Si no se envía `tipoCambio`, se resuelve automáticamente del `AgroTipoCambio` del día (o el más reciente hacia atrás).

### Importador TSV — formato de columnas

Headers en minúsculas, decimales con coma, fechas `dd/mm/yyyy` o ISO. Se acepta `\t` o `;` como separador.

**hacienda:** `fecha, tipo, centro, categoria, centro_destino, categoria_destino, tanda_id, cabezas, kg_cab, kg_total, usd_kg, prenadas, tercero_id, guia, obs, fecha_cobro_pago`

**granos:** `fecha, tipo, lote_campania_id, producto_id, toneladas, precio_neto_usd_t, precio_referencia_usd_t, flete_usd_t, comision_usd_t, fecha_cobro, tanda_id, obs`

**gastos:** `fecha, tercero_id, cuenta_id, centro, lote_campania_id, tanda_id, prestamo_id, detalle, moneda, monto, tipo_cambio, comprobante, fecha_pago, cantidad, unidad`

**labores:** `fecha, lote_campania_id, tipo_labor, hectareas, propia, tarifa_usd_ha, obs`

**lluvias:** `fecha, mm, pluviometro`

Además, el selector de módulo existente acepta ahora `'agro'`:

- `PATCH /users/preferred-module` con `{ preferredModule: "agro" }`

## Fases pendientes

- **Fase 3 — Núcleo de cálculo**: reglas §5, golden tests contra el Excel de referencia.
- **Fase 4 — Reportes**: tablero, resultados por actividad, tandas, KPIs, informe socios PDF.
- **Fase 5 — Presupuesto y caja**: presupuesto físico/precio/económico, escenarios, caja 12 meses, integración BCU para TC.
- **Fase 6 — WhatsApp**: dominio `agro` en `AgentOrchestratorService`, staging en `agro_captura_pendiente`, idempotencia.
- **Fase 7 — Modelos de decisión**: momento óptimo de venta, comprar vs contratar, VAN/TIR pasturas, etc.
