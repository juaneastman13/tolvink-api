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

### Reportes (Fase 4)

| Método | Ruta | Rol mínimo | Descripción |
|---|---|---|---|
| GET | `/agro/reportes/ejercicio-actual` | agro_* | Ejercicio y rango derivado de `mesInicioEjercicio` |
| GET | `/agro/reportes/stock?hasta=` | agro_* | Snapshot de stock por (centro, categoría) |
| GET | `/agro/reportes/resultados?ejercicio=` | agro_* | Vista negocios + vista empresa (§5.7) con MAQ TARIFA (§5.4), tenencia (§5.3) y dif de cambio |
| GET | `/agro/reportes/tandas` | agro_* | Feedlot por tanda (§5.9) |
| GET | `/agro/reportes/equivalencias?ejercicio=` | agro_* | kg carne / t soja equivalentes (§5.8) |
| GET | `/agro/reportes/desvios?ejercicio=&escenario=` | agro_* | Presupuesto vs real por (centro, concepto), Δprecio y Δcantidad, alerta según umbrales |

### Presupuesto y caja (Fase 5)

| Método | Ruta | Rol mínimo | Descripción |
|---|---|---|---|
| GET/POST/DELETE | `/agro/presupuesto/fisico[/:id]?ejercicio=` | admin, carga | Cantidades planificadas por mes/centro/concepto |
| GET/POST | `/agro/presupuesto/precio?ejercicio=&escenario=` | admin, carga | Precios por mes, producto/categoría y escenario |
| GET | `/agro/presupuesto/economico?ejercicio=&escenario=` | agro_* | Físico × precio calculado, totales por centro |
| GET | `/agro/caja?anclaje=&saldoInicial=&escenario=` | agro_* | Flujo 12m rolling: real hasta anclaje + presupuesto en adelante; alertas ROJO/AMARILLO |
| POST | `/agro/bcu/sync` | admin | Sincroniza TC del día contra API BCU (idempotente) |

### Exportaciones e informes

| Método | Ruta | Rol mínimo | Descripción |
|---|---|---|---|
| GET | `/agro/export/:dominio.csv?desde&hasta` | agro_* | CSV UTF-8+BOM formato UY (hacienda/granos/gastos/labores/lluvias) |
| GET | `/agro/export/excel.xlsx?desde&hasta` | agro_* | Libro Excel con una hoja por dominio |
| GET | `/agro/informe/socios.json?ejercicio=` | agro_* | Informe para socios (JSON) |
| GET | `/agro/informe/socios.html?ejercicio=` | agro_* | Informe HTML print-friendly ("Guardar como PDF" desde el navegador) |

### Decisiones (Fase 7)

Cada endpoint acepta parámetros por body y devuelve un `DecisionResultado`
con la misma forma: `resultado { valorPrincipal, unidad, interpretacion }` +
`curva` (línea) + `matriz` (heatmap) + `escenarios` (comparativa
PESIMISTA/BASE/OPTIMISTA/**SECA**) + `alertas[]` + `recomendacion`.
El frontend puede tener un componente único que renderice cualquiera.

| Método | Ruta | Rol mínimo | Modelo |
|---|---|---|---|
| POST | `/agro/decisiones/momento-venta` | agro_* | Curva de valor por día con escalones de precio, óptimo por CO |
| POST | `/agro/decisiones/precio-max-reposicion` | agro_* | Techo de compra por kg vivo dado plan de venta; heatmap (precio × kg) |
| POST | `/agro/decisiones/fertilizacion` | agro_* | Mitscherlich; dosis óptima económica; alerta por relación precio grano/fert |
| POST | `/agro/decisiones/van-pasturas` | agro_* | VAN + TIR + recupero descontado + heatmap (kg incrementales × precio) |
| POST | `/agro/decisiones/maquinaria` | agro_* | Comprar vs contratar; ha de indiferencia; VAN; curva costo/ha vs ha/año |
| POST | `/agro/decisiones/comercializacion-granos` | agro_* | Vender ya vs esperar N meses; incluye CO + almacenaje |
| POST | `/agro/decisiones/compra-insumos` | agro_* | Anticipar vs esperar; precio de indiferencia; ROI de anticipar |
| POST | `/agro/decisiones/renta-max` | agro_* | Renta máxima que preserva margen objetivo; heatmap (rinde × precio) |
| POST | `/agro/decisiones/recomposicion` | agro_* | Mix óptimo de actividades por MB/ha ajustado por capital |
| GET | `/agro/decisiones/:tipo.html?data=<b64>` | agro_* | Vista HTML print-friendly con SVG inline (curva + heatmap + escenarios) |

**Escenarios integrados** (multiplicativos sobre inputs relevantes):
- PESIMISTA: −15% precio, −15% rinde, +10% costos
- BASE: sin cambio
- OPTIMISTA: +15% precio, +15% rinde, −5% costos
- **SECA**: −40% rinde, −30% GMD pastoreo, +15% costos, +40% suplementación (spec del brief)

Cada modelo devuelve el resultado bajo los 4 escenarios en `escenarios{}`
para comparar de una.

## Capa de dominio (funciones puras — `src/agro/dominio/*`)

Todas sin dependencia de Nest/Prisma. Trabajan con `Decimal` para
correctitud numérica. Actualmente **64 tests unitarios en verde**.

| Archivo | Regla del brief | Qué hace |
|---|---|---|
| `ejercicio.ts` | §5.1 | Rango de un ejercicio, corte intermedio, "ejercicio de X fecha" |
| `moneda.ts` | §4.3 | Normalización `{monto,moneda,tipoCambio,montoUsd}` (banker rounding) |
| `stock-hacienda.ts` | §4.3 | `aplicar`, `validar`, `proyectarStock` sobre movs de hacienda |
| `transferencia-grano.ts` | §5.2 | Valor neto en campo + asiento gemelo AGR/FEED |
| `valuacion.ts` | §5.3 | Descompone Δ valor de inventario en efecto físico y efecto precio |
| `costos-compartidos.ts` | §5.4 | Reparto por % explícito, reparto por UG, MAQ modo TARIFA (sobre/subrecupero) |
| `campania.ts` | §5.5 | Clasifica campaña: reconoce resultado en ejercicio de cosecha o activa "cultivos en pie" |
| `costo-oportunidad.ts` | §5.6 | CO = capital × tasa × fracción-año (sólo vista de decisión) |
| `resultado-empresa.ts` | §5.7 | Vista negocios y vista empresa con reversión de renta ficta |
| `equivalencias.ts` | §5.8 | kg carne / t soja equivalente con precios base fijos |
| `feedlot.ts` | §5.9 | GMD, conversión, costo/kg ganado, margen por cabeza y día, breakeven |
| `presupuesto.ts` | §4.4 | Físico × precio, matching por producto/categoría/mes |
| `desvio.ts` | §6 | Δtotal, Δprecio, Δcantidad + umbral USD/% para alerta |
| `caja.ts` | §6 | Rolling 12m, saldo mes a mes, alerta ROJO/AMARILLO, monto a financiar |

## Escenario dorado

`src/agro/__integration__/escenario-cruz-del-sur.spec.ts` implementa un
ejercicio completo (600 ha agri + 400 ha ganadería + 1 tanda de 100
novillos) con todos los flujos de §5 y §6 encadenados. Reemplaza al Excel
de referencia del brief: los "resultados esperados" son numéricos e
inline, verificables a mano; si un cálculo se ajusta, se cambia el
escenario, no la implementación.

## Fases pendientes

- **Fase 6 — WhatsApp** (postergada por decisión del usuario): dominio `agro` en `AgentOrchestratorService`, staging en `agro_captura_pendiente`, idempotencia. La tabla `agro_captura_pendiente` ya existe en el schema.
- **Amortizaciones**: requiere modelar `agro_bien` con vida útil. Mientras tanto se cargan como gastos ESTRUCTURA / centro EST.
