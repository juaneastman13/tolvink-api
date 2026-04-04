export function buildFreightRulesSection(isWeb: boolean): string {
  return `<create_freight>
CREAR FLETE — ONE-SHOT:
Cuando el usuario da multiples datos en un mensaje, extraer TODOS sin preguntar lo que ya dijo.
Ej: "manda 30 de soja de cerros negros a sofoval miguelete manana" -> extraer grano, tons, campo, lote, planta, sucursal, fecha.

Datos necesarios:
1. ORIGEN: campo + lote. Si tiene 1 campo -> usarlo sin preguntar. Si tiene 1 lote -> auto-seleccionar.
2. DESTINO: planta + sucursal, O destino personalizado.
   - search_plants retorna branches[] para cada planta. Revisar SIEMPRE ese campo.
   - Si branches tiene 1 entrada -> auto-seleccionar.
   - Si branches tiene 2+ entradas -> mostrar lista interactiva.
   - NUNCA llamar a prepare_freight sin branchId si la planta tiene sucursales.
3. GRANO y TONELADAS.
4. FECHA y HORA (YYYY-MM-DD, HH:mm). "manana"/"el lunes" -> resolver a fecha exacta.
5. CAMIONES: calcular auto 1 cada 30t. 13t=1, 45t=2, 90t=3.
6. TRANSPORTE POR CAMION (OBLIGATORIO):
   a) FLOTA PROPIA: "con mi flota" / "propio"
   b) EXTERNO: "externo" / "de afuera"
   c) DELEGA A PLANTA: "que asigne la planta" / "delegado"
7. CONFIRMACION: prepare_freight -> resumen -> confirm_create_freight.

FORMATO AL PEDIR DATOS:
REGLA ABSOLUTA: Preguntar TODOS los datos faltantes en UN SOLO MENSAJE con formato de LISTA con emojis. NUNCA fragmentar en multiples mensajes.
Necesito estos datos:
🌾 Grano y toneladas
📍 Campo/lote de origen
🏢 Planta de destino
📅 Fecha y hora de carga
🚛 Transporte: propio, externo, o delega a planta?

REGLAS CRITICAS:
- NUNCA re-preguntar un dato ya proporcionado.
- Auto-resolver nombres con fuzzy search.
- Duplicar flete: "repeti el ultimo" -> buscar ultimo con list_freights, duplicar. Solo pedir fecha.
- NUNCA asumir tipo de transporte. Siempre preguntar si no queda claro.

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
→ Botones: ✅ Crear flete / ✏️ Cambiar algo / ❌ Cancelar

ACCIONES SOBRE FLETES:
- Iniciar viaje: si 1 solo flete aceptado, auto-resolver sin preguntar.
- Confirmar carga: no preguntar toneladas ni foto.
- Confirmar entrega: informar quién falta (cross-confirmación).
- Cancelar: pedir motivo UNA vez + botones (✅ Cancelar flete / ❌ No cancelar).
- Aceptar/Rechazar: resumen + botones (✅ Aceptar / ❌ Rechazar).
</freight_interaction_format>

<field_interaction_format>
CREAR CAMPO:
📍 Nombre del campo
🗺️ Ubicación: compartir por WhatsApp o escribir dirección
→ Botones: ✅ Crear campo / ❌ Cancelar
- Hectáreas: NUNCA preguntar.

CREAR LOTE:
📍 Campo y nombre del lote
→ Botones: ✅ Crear lote / ❌ Cancelar
- Hectáreas y coordenadas: NUNCA preguntar.
</field_interaction_format>`;
}
