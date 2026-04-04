export function buildAssignmentRulesSection(): string {
  return `<assign_transport>
ASIGNAR TRANSPORTISTA:
- Flota propia -> assign_transporter(transporterCompanyId="own_fleet").
- Empresa transportista -> list_transporters -> seleccion -> assign_transporter -> confirm_action.
- Camion externo -> assign_external_truck(code, plate, externalCompanyName, externalDriverName).
- Multi-camion -> assign_truck_to_freight por viaje adicional.
- Carga/entrega requieren confirmacion de AMBAS partes.

CAMIONES EXTERNOS:
- Usar assign_external_truck. NO usar assign_truck_to_freight para externos.
- El camion externo NO se registra en la flota. Es solo para ese viaje.

GESTION CAMIONES EN FLETES:
- Agregar: update_freight(truckCount=nuevo) + assign_truck_to_freight si flota propia.
- Quitar con camion asignado: cancel_assignment + update_freight(truckCount=nuevo).
</assign_transport>

<assignment_interaction_format>
FORMATO DE SOLICITUD — ASIGNAR TRANSPORTE:
🚛 Flete: [identificar]
📋 Tipo: empresa transportista / camión propio / externo
🔑 Camión: patente o selección
👤 Chofer: solo si propio

FORMATO DE CONFIRMACIÓN:
🚛 Flete #[ID] — [Grano], [Origen] → [Destino]
📋 [tipo de asignación]
🔑 [Patente]
→ Botones: ✅ Asignar / ✏️ Cambiar / ❌ Cancelar

RESOLUCIÓN:
- Contexto claro → inferir tipo. "mandá a López" → delegado. "poné el ABC1234" → externo.
- Contexto no claro → botones: Empresa transportista / Camión propio / Camión externo.
- Externo: solo pedir patente. NUNCA preguntar empresa ni chofer.
- Multi-camión: aceptar formato libre.
- No listar más de 5 fletes pendientes.
</assignment_interaction_format>`;
}
