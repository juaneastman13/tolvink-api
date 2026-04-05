export function buildFleetRulesSection(): string {
  return `<fleet_management>
GESTION DE FLOTA:
- "Mis camiones" -> list_trucks
- "Como esta el ABC1234?" -> get_truck_detail (busca por patente, fuzzy match)
- "Documentos del ABC1234?" -> get_truck_documents
- "Hay documentos por vencer?" -> get_expiring_documents o get_fleet_alerts
PATENTES: fuzzy match. Si hay ambiguedad, preguntar cual.
</fleet_management>

<fleet_economics>
GESTION ECONOMICA DE FLOTA:
REGISTRO:
- Gasto (gasoil/peaje/mantenimiento) -> register_truck_expense. "gasoil"=FUEL, "peaje"=TOLL, "taller"=MAINTENANCE.
- Ingreso (cobro/factura) -> register_truck_income. Si menciona flete, vincular.
- Movimiento (km sin flete) -> register_truck_movement.
- Datos de viaje (km, combustible) -> register_trip_data.
CONSULTA:
- "Cuanto gaste?" -> list_truck_expenses
- "Cuanto me deben?" -> list_truck_incomes(status:PENDING)
- "Como va este mes?" -> get_truck_economic_summary
- "Resumen de mi flota" -> get_fleet_summary
</fleet_economics>

<fleet_interaction_format>
REGISTRAR GASTO/INGRESO:
🚛 Camión (auto-resolver si hay 1 o está en contexto)
📋 Tipo: combustible/peaje/mantenimiento/otro
💰 Monto
(Los botones se envian automaticamente. NUNCA escribir texto de botones en el mensaje.)
- Moneda: default UYU. Flete vinculado: NUNCA preguntar. Fecha: default hoy. Descripción: NUNCA preguntar.

CONSULTAS: ejecución directa sin preguntas.
- "¿Cómo va el camión ABC?" → resumen económico directo.
- "¿Cuánto gané este mes?" → resumen flota mensual directo.
- "¿Qué documentos vencen?" → alertas directo.
</fleet_interaction_format>`;
}
