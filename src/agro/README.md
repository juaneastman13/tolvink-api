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

## Endpoints (Fase 1)

Todos bajo `/agro/*` y protegidos por `JwtAuthGuard + ModuleAccessGuard('agro')`.
El header `x-agro-empresa-id` es requerido cuando la Company tiene más de una
`AgroEmpresa` activa.

| Método | Ruta | Rol mínimo | Descripción |
|---|---|---|---|
| GET | `/agro/empresas` | agro_* | Lista empresas de la Company |
| POST | `/agro/empresas` | agro_admin | Crea empresa + aplica seeds base |
| PATCH | `/agro/empresas/:id` | agro_admin | Actualiza empresa |
| GET | `/agro/config` | agro_* | Config de la empresa activa (crea default si no existe) |
| PUT | `/agro/config` | agro_admin | Upsert config |
| GET | `/agro/maestros/centros` | agro_* | Lista centros |
| POST | `/agro/maestros/centros` | agro_admin | Upsert centro |
| GET | `/agro/maestros/categorias` | agro_* | Lista categorías animales |
| POST | `/agro/maestros/categorias` | agro_admin | Upsert categoría |
| GET | `/agro/maestros/cuentas` | agro_* | Lista plan de cuentas |
| POST | `/agro/maestros/cuentas` | agro_admin | Upsert cuenta |
| GET | `/agro/maestros/terceros?tipo=` | agro_* | Lista terceros |
| POST | `/agro/maestros/terceros` | agro_admin, agro_carga | Crea tercero |
| PATCH | `/agro/maestros/terceros/:id` | agro_admin | Actualiza tercero |
| GET | `/agro/maestros/productos` | agro_* | Lista productos |
| POST | `/agro/maestros/productos` | agro_admin | Upsert producto |
| GET | `/agro/tipo-cambio` | agro_* | Serie UYU/USD |
| POST | `/agro/tipo-cambio` | agro_admin, agro_carga | Set TC de una fecha |

Además, el selector de módulo existente acepta ahora `'agro'`:

- `PATCH /users/preferred-module` con `{ preferredModule: "agro" }`

## Fases pendientes

- **Fase 2 — Captura**: movimientos de hacienda, granos, gastos, labores, lluvias; importación TSV/Excel.
- **Fase 3 — Núcleo de cálculo**: reglas §5, golden tests contra el Excel de referencia.
- **Fase 4 — Reportes**: tablero, resultados por actividad, tandas, KPIs, informe socios PDF.
- **Fase 5 — Presupuesto y caja**: presupuesto físico/precio/económico, escenarios, caja 12 meses, integración BCU para TC.
- **Fase 6 — WhatsApp**: dominio `agro` en `AgentOrchestratorService`, staging en `agro_captura_pendiente`, idempotencia.
- **Fase 7 — Modelos de decisión**: momento óptimo de venta, comprar vs contratar, VAN/TIR pasturas, etc.
