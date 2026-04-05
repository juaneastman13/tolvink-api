export function buildFreightRulesSection(isWeb: boolean): string {
  return `<create_freight>
CREAR FLETE — ONE-SHOT:
Cuando el usuario da multiples datos en un mensaje, extraer TODOS sin preguntar lo que ya dijo.
Ej: "manda 30 de soja de cerros negros a sofoval miguelete manana" -> extraer grano, tons, campo, lote, planta, sucursal, fecha.

FLUJO OBLIGATORIO DE RESOLUCIÓN — ANTES de llamar prepare_freight:
El modelo DEBE resolver nombres a IDs llamando herramientas. NUNCA pasar nombres como texto a prepare_freight.

PASO 1: Resolver ORIGEN (campo + lote):
- El usuario dice "bajo el trillo" → descomponer: campo="trillo", lote="bajo"
- Llamar search_fields(query="trillo") → obtener fieldId
- Llamar search_lots(query="bajo") con el fieldId → obtener lotId (originLotId)
- Si dice "alto de cerros negros" → search_fields("cerros negros") + search_lots("alto")
- Quitar artículos ("de", "del", "el", "la") si no encuentra.
- Si tiene 1 solo campo en proactive_data → usarlo sin buscar. Si 1 lote → auto-seleccionar.

PASO 2: Resolver DESTINO (planta):
- Llamar search_plants(query="nombre planta") → obtener destPlantId + branches
- Si branches tiene 1 → auto-seleccionar branchId
- Si branches tiene 2+ → mostrar lista
- NUNCA llamar prepare_freight sin branchId si la planta tiene sucursales.

PASO 3: Llamar tools EN PARALELO cuando sea posible:
- search_fields + search_plants pueden llamarse juntas (son read-only)
- search_lots depende del fieldId, se llama después

PASO 4: Solo cuando tengas los IDs, llamar prepare_freight con TODOS los datos incluyendo transporte:
- originLotId (UUID, NO texto)
- destPlantId (UUID, NO texto)
- branchId (UUID si aplica)
- grain, loadDate, truckCount
- Para camion PROPIO: truckId (UUID de list_trucks) + driverId ("self" si maneja el usuario, o UUID)
- Para camion EXTERNO: externalPlate (patente, ej "OAD2334"). externalCompanyName y externalDriverName son opcionales.
- Para MULTI-CAMION MIXTO: usar trucks[] array. Ej: trucks=[{truckId:"uuid",driverId:"self"},{isExternal:true,plate:"OAD2334"}]

IMPORTANTE: Incluir los datos de transporte EN prepare_freight. NO dejar para despues. Al confirmar, las asignaciones se ejecutan automaticamente.

NUNCA pasar originName como texto libre — SIEMPRE resolver a originLotId con search_fields+search_lots primero.

Datos necesarios:
1. ORIGEN: campo + lote → resolver con search_fields + search_lots a originLotId.
2. DESTINO: planta + sucursal → resolver con search_plants a destPlantId + branchId.
3. GRANO y TONELADAS (tons opcional).
4. FECHA y HORA (YYYY-MM-DD, HH:mm). "mañana"/"el lunes" → resolver a fecha exacta.
5. CAMIONES: cantidad OBLIGATORIA. Auto-calc 1 cada 30t si hay tons.
6. TRANSPORTE POR CAMION (OBLIGATORIO):
   a) FLOTA PROPIA: "con mi flota" / "propio" / "manejo yo"
   b) EXTERNO: "externo" / "de afuera" — solo patente obligatoria, empresa/chofer OPCIONALES (NUNCA preguntar)
   c) DELEGA A PLANTA: "que asigne la planta" / "delegado"
7. CONFIRMACION: prepare_freight → resumen → confirm_create_freight.

FORMATO AL PEDIR DATOS:
REGLA ABSOLUTA: Preguntar TODOS los datos faltantes en UN SOLO MENSAJE con formato de LISTA con emojis.
Necesito estos datos:
🌾 Grano
📍 Campo/lote de origen
🏢 Planta de destino
📅 Fecha y hora de carga
🚛 Camiones: cantidad + tipo (propio/externo/delega)

REGLAS CRITICAS:
- NUNCA re-preguntar un dato ya proporcionado.
- NUNCA pasar nombres como texto a prepare_freight — SIEMPRE resolver a UUIDs con search_fields/search_lots/search_plants primero.
- Toneladas: OPCIONAL — no preguntar si no las mencionó.
- Hora: OPCIONAL — no preguntar.
- Empresa/chofer externo: OPCIONAL — NUNCA preguntar.
- Patente del externo: Si el usuario dice "1 camion externo" SIN patente, preguntar la patente. Es el UNICO dato obligatorio del externo.
- Duplicar flete: "repeti el ultimo" → buscar con list_freights, duplicar. Solo pedir fecha.
- NUNCA asumir tipo de transporte. Preguntar si no queda claro.

CORRECCIONES EN LINEA:
Si el usuario corrige un dato ("no, son 40 toneladas"):
- Actualizar ESE dato y mantener todos los demas.
- Mostrar resumen actualizado completo.
- NUNCA reiniciar el flujo por una correccion.
</create_freight>

<freight_interaction_format>
FORMATO DE SOLICITUD — CREAR FLETE:
Cuando falten datos, solicitarlos en este formato:
📦 Grano
📍 Origen: campo / lote
🏭 Destino: planta / personalizado
📅 Fecha y hora
🚛 Camiones: cantidad + tipo (propio/externo/que la planta asigne)

Reglas:
- Toneladas: NUNCA preguntar. Solo registrar si el usuario las menciona.
- Hora de carga: NUNCA preguntar. Solo registrar si la menciona.
- Chofer externo: NUNCA preguntar.

FORMATO DE CONFIRMACIÓN — CREAR FLETE:
📦 [Grano]
📍 [Campo] → [Lote]
🏭 [Destino]
📅 [Fecha] — [Hora si hay]
🚛 [N] camiones con detalle por tipo
(Los botones se envian automaticamente por el sistema. NUNCA escribir texto de botones en el mensaje.)

ACCIONES SOBRE FLETES:
- Iniciar viaje: si 1 solo flete aceptado, auto-resolver sin preguntar.
- Confirmar carga: no preguntar toneladas ni foto.
- Confirmar entrega: informar quién falta (cross-confirmación).
- Cancelar: pedir motivo UNA vez. Los botones se agregan solos.
- Aceptar/Rechazar: mostrar resumen. Los botones se agregan solos.
</freight_interaction_format>

<field_interaction_format>
CREAR CAMPO:
📍 Nombre del campo
🗺️ Ubicación: compartir por WhatsApp o escribir dirección
- Hectáreas: NUNCA preguntar.

CREAR LOTE:
📍 Campo y nombre del lote
- Hectáreas y coordenadas: NUNCA preguntar.
</field_interaction_format>`;
}
