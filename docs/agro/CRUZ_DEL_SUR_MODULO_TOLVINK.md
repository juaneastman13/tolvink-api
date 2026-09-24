# Cruz Del Sur — Módulo de gestión agropecuaria dentro de Tolvink

> Documento de especificación para Claude Code.
> Idioma del producto y de los datos: **español (Uruguay)**. Código, nombres de tablas y variables: a criterio del repo existente (ver §2).

---

## 0. Cómo trabajar con este documento

1. **No escribas código todavía.** Primero explorá el repo de Tolvink (estructura, auth, multi-tenancy, Prisma schema, módulo del agente de WhatsApp, convenciones de NestJS/React, CI) y devolveme un **plan de implementación** con las decisiones que necesiten mi confirmación.
2. Todo lo marcado **[VERIFICAR]** es algo que no pude confirmar sin ver el código. Todo lo marcado **[DECIDIR]** es una decisión abierta mía.
3. Trabajá por **fases** (§10). Al terminar cada fase: tests en verde, migraciones reversibles y un resumen corto de lo hecho y lo pendiente.
4. Si un requisito de este documento choca con la arquitectura existente, señalalo antes de resolverlo por tu cuenta.

---

## 1. Objetivo y contexto

Construir un **sistema de gestión y contabilidad de gestión** para una empresa agropecuaria uruguaya con cuatro negocios:

- **Agricultura:** rotación trigo–soja (soja de 1ª y de 2ª).
- **Cría** vacuna.
- **Recría** vacuna.
- **Feedlot** (encierre a corral por tandas), que puede consumir **grano propio**.

Características de la operación:

- Lo opera un **ingeniero agrónomo** (carga de datos y análisis).
- Los **socios/familia** consumen reportes (solo lectura).
- La moneda de gestión es **USD**. Hay gastos y cobros en **UYU** que deben convertirse.
- La captura de datos en el campo se hace por **WhatsApp**, procesada por Claude.

Este sistema ya fue diseñado y validado en Excel (ver §11, artefactos de referencia). **La lógica de cálculo del Excel es la fuente de verdad**; el módulo debe reproducirla.

### 1.1 Decisión de arquitectura ya tomada

Es un **módulo separado del de logística**, que reutiliza la **infraestructura** de Tolvink (autenticación, base Postgres, stack NestJS/React, agente de WhatsApp con Anthropic SDK). **No** se integra con el producto de logística ni comparte modelo de datos de negocio con él. El usuario elige el módulo al iniciar sesión.

### 1.2 Fuera de alcance (por ahora)

- Integración con logística de granos (transportes, plantas, cartas de porte).
- Integración con SNIG/DICOSE por API (solo se registran las declaraciones como eventos y se concilia manualmente).
- Contabilidad legal/impositiva (esto es contabilidad de **gestión**).
- App móvil nativa.

---

## 2. Stack e infraestructura (a confirmar contra el repo)

Según lo que sé de Tolvink **[VERIFICAR contra el código]**:

- Frontend: React 18.
- Backend: NestJS.
- Base de datos: PostgreSQL (Supabase) con Prisma.
- Deploy: Vercel (front) / Railway (back).
- Agente de WhatsApp con Anthropic SDK: enrutamiento multi-modelo (Haiku/Sonnet), "Layer 0 interceptor", enrutamiento de tools por dominio, prompt caching.

Preguntas que el plan debe responder:

- ¿Cómo está resuelto el multi-tenant hoy (columna `tenant_id`, schemas, RLS de Supabase)? Proponé el mismo mecanismo para el módulo agro.
- ¿Cómo se modelan hoy los roles/permisos? Necesito al menos: `AGRO_ADMIN` (agrónomo, escritura total), `AGRO_SOCIO` (solo lectura de reportes), `AGRO_CARGA` (solo carga de datos, opcional).
- ¿Dónde vive el selector de módulo al login y cómo se protege una ruta/endpoint por módulo?

---

## 3. Aislamiento respecto de logística

- Prefijo **`agro_`** en todas las tablas nuevas (o schema `agro`, lo que sea coherente con el repo).
- Módulo NestJS propio (`AgroModule`) sin imports de módulos de logística. Solo puede depender de módulos de infraestructura compartida (auth, config, prisma, whatsapp/agent core).
- Rutas front bajo `/agro/*`, guard que exige acceso al módulo agro.
- Un usuario puede tener acceso a logística, a agro o a ambos; nunca se mezclan datos.
- El agente de WhatsApp debe tener un **dominio de tools `agro`** separado, activado solo para usuarios/números con acceso al módulo (ver §8).

---

## 4. Modelo de datos

Principios:

- **Movimientos append-only.** Nada se borra: se anula (`anulado_at`, `anulado_por`, `motivo`) y se reemplaza con un movimiento nuevo. Auditoría (`created_by`, `created_at`, `origen`: `WEB | WHATSAPP | IMPORT`).
- **Todos los eventos de hacienda van en una sola tabla** diferenciados por `tipo`.
- Todos los importes se guardan en **moneda original + tipo de cambio + USD**.
- Todo dato lleva `empresa_id` (una instalación puede tener varias razones sociales a futuro) además del tenant.

### 4.1 Configuración (`agro_config`, por empresa)

| Parámetro | Notas |
|---|---|
| `mes_inicio_ejercicio` (1–12) | **Configurable por el usuario, nunca hardcodeado a enero.** Todo el sistema deriva fechas de ejercicio de este único parámetro. |
| `tasa_costo_oportunidad` | Supuesto por defecto 5% anual USD. Solo se usa en la vista de decisión. |
| `modo_maquinaria` | `PORCENTAJE` \| `TARIFA` |
| `escenario_activo` | `PESIMISTA` \| `BASE` \| `OPTIMISTA` |
| `p_base_carne`, `p_base_soja`, `p_base_trigo` | Precios base **fijos** para equivalencias (promedio de 5 años). |
| `desvio_usd`, `desvio_pct` | Umbrales para alertas del informe de desvíos. |
| `saldo_minimo_operativo` | Para alertas de caja (ej. 15.000 USD). |
| `porcentajes_asignacion` | Reparto explícito de personal y maquinaria compartidos por centro (ver §5.4). |

### 4.2 Maestros

- `agro_centro`: `CRI` (cría), `REC` (recría), `FEED` (feedlot), `AGR` (agricultura), `MAQ` (maquinaria), `PAS` (pasturas compartidas, si aplica), `EST` (estructura/no asignado). **[DECIDIR: confirmar lista final]**
- `agro_categoria_animal`: código, nombre, **equivalencia UG**, centro habitual.
- `agro_campo` / `agro_potrero`: hectáreas, tipo (propio/arrendado), renta ficta o real, aptitud.
- `agro_lote_campania`: lote agrícola × campaña (soja 1ª, soja 2ª, trigo), ha, fechas de siembra y cosecha. Actúa como **orden de producción** que acumula costos.
- `agro_tanda`: tanda de feedlot (código, fecha de ingreso, corral, categoría).
- `agro_cuenta`: plan de cuentas de gestión (ingresos, costos directos, indirectos, estructura, financieros), con tipo y centro por defecto.
- `agro_tercero`: proveedores, clientes, frigoríficos, contratistas.
- `agro_producto`: insumos y granos (unidad, tipo: semilla, fertilizante, agroquímico, ración, grano comercial).
- `agro_prestamo`: capital, tasa, moneda, cuotas, garantía.
- `agro_tipo_cambio`: serie diaria UYU/USD **[DECIDIR: fuente, ej. BCU; carga manual como respaldo]**.

### 4.3 Movimientos

**`agro_mov_hacienda`**

`fecha`, `tipo`, `centro`, `categoria`, `centro_destino`, `categoria_destino`, `lote` (para feedlot = tanda), `cabezas`, `kg_cab`, `kg_total`, `usd_kg`, `prenadas`, `tercero_id`, `guia`, `obs`, `fecha_cobro_pago`.

`tipo` ∈ `NACIMIENTO, COMPRA, VENTA, MUERTE, TRANSF, RECATEG, PESADA, INVENTARIO, DICOSE, TACTO`.

Reglas:

- `TRANSF` y `RECATEG` llevan centro y categoría de **origen y destino**. Las demás, solo centro y categoría.
- En pesadas, compras y ventas de feedlot, el `lote` es la tanda.
- Validaciones: stock por centro+categoría nunca negativo; toda salida por transferencia tiene su entrada equivalente.

**`agro_mov_granos`**

`fecha`, `tipo` ∈ `COSECHA | VENTA | FEEDLOT`, `lote_campania_id`, `producto`, `toneladas`, `precio_neto_usd_t`, `fecha_cobro`, `tanda_id`, `obs`.

`FEEDLOT` = **transferencia interna** de grano propio al feedlot (ver §5.2).

**`agro_gasto`**

`fecha`, `tercero_id`, `cuenta_id`, `centro`, `referencia` (lote / tanda / préstamo), `detalle`, `moneda`, `monto`, `tipo_cambio`, `monto_usd`, `comprobante`, `fecha_pago`, `cantidad`, `unidad`.

`cantidad` y `unidad` alimentan dosis por ha y desvíos precio vs cantidad.

**Otros:**

- `agro_labor`: labores agrícolas (fecha, lote, tipo de labor, ha, propia/contratista, tarifa).
- `agro_lluvia`: fecha, mm, pluviómetro.
- `agro_precio`: serie de precios por producto/categoría/fecha (hacienda, granos, insumos), para valuación.
- `agro_banco_extracto`: para conciliación bancaria (pegar extracto, marcar movimientos sin registro).

### 4.4 Presupuesto

- `agro_pres_fisico`: stock mensual por categoría (nacimientos, destetes, compras, ventas, transferencias planificadas, pesos esperados); ha por lote-campaña, paquete de insumos/ha, rinde esperado, fecha de cosecha; toneladas de grano al feedlot por mes.
- `agro_pres_precio`: precio presupuestado por producto/categoría/insumo/mes, **por escenario**.
- `agro_pres_economico`: se **calcula** (físico × precio) con la **misma estructura de cuentas y centros que el real**.

---

## 5. Reglas de negocio (críticas)

> Estas reglas son las decisiones de diseño ya validadas. Implementalas como **funciones puras en una capa de dominio**, sin dependencia de Nest/Prisma, con tests unitarios.

### 5.1 Ejercicio fiscal configurable

Un único parámetro `mes_inicio_ejercicio` define el ejercicio. Toda consulta "del ejercicio" y todo "cierre" derivan de él.

**[DECIDIR]** Con ejercicio calendario hay dos cortes de stock: 30/06 (declaración **DICOSE**) y 31/12 (cierre). Propuesta pendiente: mantener el ejercicio configurable y agregar un **cierre intermedio al 30/06** que concilie contra DICOSE. Alternativa: ejercicio julio–junio.

### 5.2 Transferencia interna de grano al feedlot

- El grano propio consumido por el feedlot se trata como **transferencia interna al valor neto en campo**: precio de referencia (pizarra) **menos** flete y gastos de comercialización.
- El ingreso se acredita a Agricultura y el costo se debita al Feedlot, por el mismo importe.
- Sin esto, Agricultura pierde ingreso y el feedlot muestra un costo artificialmente bajo.

### 5.3 Valuación de inventarios

- **"Valor de mercado" = valor neto en campo** (precio de referencia − flete − comisión/gastos de venta). Nunca precio bruto.
- Toda variación de valor de inventario se **separa en dos efectos**:
  - **Efecto físico / productivo:** kg producidos, mérito productivo (va al resultado operativo).
  - **Efecto precio / tenencia:** variación de mercado (se muestra **aparte**).
- Cultivos en pie al cierre: activo "Cultivos en crecimiento" **a costo incurrido**.
- Grano cosechado en stock al cierre: valuado a precio neto en campo a la fecha de cierre. Si se vende después, la diferencia entre precio de venta y valor al cierre va a **tenencia del ejercicio siguiente**.

### 5.4 Asignación de costos compartidos

- **Personal y maquinaria compartidos** se reparten con **porcentajes explícitos** por centro (parámetros en config), no por criterios implícitos.
- Personal asignado a pasto se reparte entre cría y recría **por UG promedio**.
- **Maquinaria:** dos modos.
  - `PORCENTAJE`: reparto porcentual del costo.
  - `TARIFA`: cada labor se carga al lote a tarifa de contratista. El centro `MAQ` acumula la diferencia: **sobrerrecupero** (ahorro de tener equipo propio) o **subrecupero**. Un subrecupero sostenido alimenta la decisión comprar-vs-contratar.
- Sin asignación de personal, el feedlot parecería más rentable de lo que es. Debe existir un reporte que lo evidencie.

### 5.5 Reconocimiento de campaña vs ejercicio

Cada lote-campaña es una orden de producción que acumula costos desde el barbecho hasta la venta.

- El resultado de una campaña se reconoce **en el ejercicio en que se cosecha**.
- Costos de siembras cuya cosecha cae en el ejercicio siguiente quedan como activo al cierre.
- Debe haber un reporte **por zafra** y un reporte **por ejercicio** que **concilien** sin ajustes manuales.

### 5.6 Costo de oportunidad del capital

- Tasa configurable sobre el **capital hacienda promedio** y el **capital circulante** (insumos, cultivos en pie) de cada actividad, proporcional al tiempo.
- **No** se aplica sobre la tierra (ya remunerada con la renta) ni sobre la maquinaria (ya está en la tarifa).
- Solo en la **vista de decisión** ("margen económico"), **nunca** en el resultado contable.

### 5.7 Resultado de empresa: dos vistas

- **Vista negocios (para comparar):** margen bruto después de tierra, con renta ficta, por actividad.
- **Vista empresa (resultado real):** Σ MB después de tierra + reversión de renta ficta ± resultado del centro MAQ − estructura no asignada − amortizaciones no asignadas = **Resultado operativo (ingreso de capital)**; − intereses ± diferencia de cambio = **Resultado neto**; resultado por tenencia **aparte**.
- La renta ficta **no es un costo de la empresa**: se revierte al consolidar.

### 5.8 Equivalencias carne–grano

- **kg de carne equivalente** y **toneladas de soja equivalente**, calculados con **precios base fijos** de config (promedio de 5 años), no con precios corrientes. Son medidas de productividad física, no de rentabilidad.

### 5.9 Feedlot

- Se mide **por cabeza, por día y por tanda/corral**. **No** entra en carga (UG/ha) ni en kg/ha de cría o recría.
- Resultado por tanda: días de encierre, GMD, conversión real (kg MS/kg), costo por kg ganado, margen por cabeza y por día, precio de equilibrio.
- La tanda se identifica con el mismo código en hacienda, gastos y granos.

---

## 6. Reportes y análisis

| Reporte | Contenido |
|---|---|
| **Tablero** | Síntesis del ejercicio, semáforo vs presupuesto, alertas. |
| **Resultados por actividad** | MB por centro, vista negocios y vista empresa (§5.7). |
| **Tandas de feedlot** | Ver §5.9. |
| **Agricultura por lote-campaña** | Rinde, costo/ha y por t, MB después de tierra/ha, **rinde de indiferencia**, dosis de insumos por ha. |
| **Indicadores (KPIs)** | Por negocio, con referencia UY, decisión que dispara y dos ejercicios previos (ver §6.1). |
| **Balance** | A valores de mercado, con cuentas a cobrar/pagar y ratios (liquidez, endeudamiento, cobertura de servicio de deuda). |
| **Presupuesto vs real** | Desvío total, **desvío por precio** y **desvío por cantidad**, con alerta por umbral. |
| **Flujo de caja 12 meses** | Rolling; mes cerrado reemplazado por real; alertas rojo/amarillo vs mínimo operativo; mes de saldo mínimo y monto a financiar. |
| **Informe para socios** | Una página, textos generados automáticamente, exportable a **PDF**. |
| **Conciliación bancaria** | Marca movimientos del extracto sin registro. |

### 6.1 KPIs (los que disparan una decisión)

Las referencias de Uruguay son **orientativas: [VERIFICAR]** contra DIEA-MGAP, INIA, Plan Agropecuario y FUCREA antes de fijarlas como metas.

- **Cría:** % preñez, % destete, kg destetados por vaca entorada, peso al destete, kg carne/ha, carga (UG/ha), mortandad, tasa de reposición, costo por ternero destetado.
- **Recría:** GMD, kg/ha, carga, mortandad, costo por kg producido, margen económico.
- **Feedlot:** GMD promedio, conversión, costo por kg ganado, margen por cabeza, días de encierre, mortandad.
- **Agrícola:** rinde, costo por ha (con renta), costo por t, MB después de tierra por ha, rinde de indiferencia, relación kg de trigo por kg de urea.
- **Empresa:** resultado operativo anualizado, ROA (con y sin tierra), ROE, resultado por ha, kg de carne equivalente por ha, t de soja equivalente, participación de cada negocio en el margen, liquidez, endeudamiento.

### 6.2 Modelos de decisión (fase posterior)

Momento óptimo de venta · precio máximo de reposición · recomposición de negocios · optimización de fertilización · inversión en pasturas (VAN/TIR) · comprar vs contratar maquinaria · estrategia de compra de insumos · renta máxima · comercialización de granos.

Deben incluir **escenarios** (pesimista/base/optimista; "seca" = rinde −40%, GMD en pastoreo −30%, suplementación extra y ventas anticipadas) y **tablas de doble entrada** (MB/ha por precio × rinde; margen por cabeza por precio de compra × venta; VAN de pasturas por kg incrementales × precio).

---

## 7. Aplicación web (UX)

- Pantallas de **carga** tipo planilla (grilla editable con validación inline y pegado desde Excel/TSV) para Hacienda, Gastos, Granos, Lluvias, Labores.
- **Importación masiva** desde el Excel de referencia y desde tablas TSV pegadas.
- Todas las vistas filtrables por **ejercicio** (según `mes_inicio_ejercicio`), zafra, centro, tanda, lote.
- Modo **solo lectura** para socios con acceso a Tablero e informe.
- Idioma español; formato de fecha `dd/mm/aaaa`; decimales con coma; USD como moneda de presentación.
- Responsive: el agrónomo va a cargar desde el celular.

---

## 8. Captura por WhatsApp

Extender el agente existente con un **dominio de tools `agro`**, aislado del de logística **[VERIFICAR cómo está hecho el routing por dominio]**.

### 8.1 Flujo

1. El usuario manda mensajes de texto (y opcionalmente audios/fotos de comprobantes) por WhatsApp.
2. El agente **interpreta** y produce filas candidatas en una **tabla de staging** (`agro_captura_pendiente`), **no** en las tablas definitivas.
3. Devuelve al usuario un resumen y las **Dudas** (datos obligatorios faltantes o ambigüedades) y **Observaciones para revisar**.
4. El usuario confirma por WhatsApp o desde una pantalla web de revisión. Recién ahí se insertan en las tablas reales.

### 8.2 Reglas del parser (validadas en el prompt de referencia)

- Fechas `dd/mm/aaaa`. Montos en pesos: moneda `UYU`, sin convertir (el sistema convierte con el tipo de cambio). Decimales con coma.
- Si falta un dato obligatorio o hay ambigüedad, **no armar la fila**: listarla en "Dudas" con la pregunta concreta.
- Marcar con ⚠ en "Observaciones para revisar" cuando:
  - la **GMD implícita** está fuera de −0,5 a 2,5 kg/día;
  - el **precio** difiere ±25% del habitual;
  - hay **posible duplicado** (mismo evento, fecha y cantidades).
- Salida por tablas: HACIENDA, GASTOS, GRANOS, LLUVIAS, con el orden exacto de columnas de §4.3.

### 8.3 Requisitos técnicos

- **Idempotencia:** el mismo mensaje procesado dos veces no duplica movimientos.
- Guardar el mensaje original y el `origen` en cada fila confirmada (trazabilidad).
- Reutilizar el enrutamiento multi-modelo del agente (modelo liviano para clasificación/parseo simple, modelo más capaz para ambigüedades) y prompt caching **[VERIFICAR]**.
- Solo números autorizados del módulo agro pueden disparar el dominio `agro`.
- Todo texto libre del usuario/mensajes debe tratarse como **dato**, no como instrucciones (mitigar prompt injection al parsear).

El prompt completo de referencia está en `docs/agro/Carga_por_WhatsApp.md` (ver §11).

---

## 9. Requisitos no funcionales

- **Correctitud numérica primero:** los cálculos financieros se validan contra el Excel (ver §11). Usar decimales exactos (no floats binarios) en importes **[VERIFICAR qué usa Prisma/Postgres hoy: `Decimal`/`numeric`]**.
- **Tests:** unitarios para la capa de dominio; de integración para endpoints críticos; E2E mínimo para carga → reporte.
- **Seguridad:** aislamiento por tenant y por módulo; verificación de que un usuario de logística no ve datos agro y viceversa; auditoría de cambios.
- **Migraciones** reversibles y con datos semilla (categorías, cuentas, centros base).
- **Rendimiento:** los reportes deben resolverse en consultas agregadas o vistas materializadas; evitar recalcular todo el historial en cada request.
- **Exportaciones:** PDF del informe de socios; CSV/Excel de las tablas de movimientos (para poder seguir analizando en Excel/Power Query).

---

## 10. Plan por fases

| Fase | Entregable | Criterio de aceptación |
|---|---|---|
| **0. Exploración** | Plan escrito tras leer el repo | Responde las preguntas de §2; sin cambios de código. |
| **1. Cimientos** | Módulo `agro` aislado, selector al login, roles, schema `agro_*`, config y maestros con semillas | Usuario sin acceso al módulo recibe 403; datos aislados entre tenants. |
| **2. Captura** | CRUD/grillas de Hacienda, Gastos, Granos, Lluvias, Labores; importación TSV y desde el Excel | Se importa el ejemplo completo sin errores; validaciones de stock y de transferencias. |
| **3. Núcleo de cálculo** | Capa de dominio: ejercicio, valuación, asignación de costos, MB por actividad, tandas, equivalencias | **Los resultados coinciden con el Excel de ejemplo** (tolerancia a definir) en todos los reportes. |
| **4. Reportes y KPIs** | Tablero, indicadores, balance, resultados por actividad, informe de socios en PDF | Socio en modo lectura ve el informe; ejercicio cambia al modificar `mes_inicio_ejercicio`. |
| **5. Presupuesto y caja** | Presupuesto físico/precio/económico, escenarios, desvíos precio/cantidad, flujo a 12 meses con alertas | Cambiar de escenario recalcula presupuesto y caja. |
| **6. WhatsApp** | Dominio `agro` con staging y confirmación | Casos de prueba de §8.2 (dudas, ⚠, duplicados) pasan; idempotencia verificada. |
| **7. Decisiones** | Modelos de §6.2 con escenarios y tablas de doble entrada | Cada modelo con ejemplo numérico verificado. |

---

## 11. Artefactos de referencia (colocar en `docs/agro/` del repo)

Estos archivos los tengo generados; **los voy a copiar al repo** antes de la Fase 2:

- `Gestion_Agro_completo_plantilla.xlsx` — estructura vacía, 10 hojas: Inicio, Tablero, Config, Precios, Hacienda, Agricultura, Gastos, Presupuesto, Resultados, Decisiones.
- `Gestion_Agro_completo_ejemplo.xlsx` — mismo libro con datos de ejemplo. **Usarlo como oráculo de tests** (golden tests) para la Fase 3.
- `Carga_por_WhatsApp.md` — formatos de mensaje y prompt del parser.

Si algún cálculo del Excel resulta ambiguo, preguntame en vez de asumir.

---

## 12. Decisiones abiertas

- [ ] **[DECIDIR]** Ejercicio calendario + cierre intermedio 30/06 (DICOSE) vs ejercicio julio–junio (§5.1).
- [ ] **[DECIDIR]** Lista final de centros de costo, en particular `PAS` (§4.2).
- [ ] **[DECIDIR]** Fuente del tipo de cambio (§4.2).
- [ ] **[VERIFICAR]** Tasa de costo de oportunidad (5% es supuesto) y referencias UY de KPIs (§6.1).
- [ ] **[VERIFICAR]** Mecanismo multi-tenant y de módulos en el repo actual (§2).
- [ ] ¿El módulo se ofrecerá a terceros más adelante? Si sí, el diseño multi-empresa de §4 pasa a ser prioritario.

---

## 13. Referencia de mercado (contexto, no requisito)

Software comerciales analizados como comparación funcional: **Albor Campo** (bimonetario, contabilidad de gestión integrada, márgenes por actividad, normas CREA), **VISUAL Gestión Agro**, **Gecos Administración Ganadera** (integración con SNIG), **AGRI**. Útiles para contrastar el alcance de reportes; ninguno resuelve de forma documentada las reglas específicas de §5.2 y §5.8, por eso se construye este módulo.
