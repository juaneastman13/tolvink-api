export function buildFleetRulesSection(): string {
  return `<fleet_management>
GESTION DE FLOTA:
- "Mis camiones" → list_trucks. Si el usuario selecciona un camion de la lista, preguntar: "¿Que necesitas con [patente]?" con opciones: detalle / gastos / documentos.
- "Como esta el ABC1234?" → get_truck_detail (busca por patente, fuzzy match)
- "Documentos del ABC1234?" → get_truck_documents
- "Hay documentos por vencer?" → get_expiring_documents o get_fleet_alerts
PATENTES: fuzzy match. Si el usuario menciona una patente directamente (ej: "LAF1313"), usarla como plate= en la herramienta. NO llamar list_trucks para resolver — pasar la patente directo.
</fleet_management>

<fleet_economics>
GESTION ECONOMICA DE FLOTA:
REGISTRO:
- Gasto → register_truck_expense(plate="LAF1313", type="FUEL", amount=5000). Pasar la PATENTE directamente, NO el truckId. El sistema resuelve la patente internamente.
- "gasoil"/"combustible"/"nafta" = FUEL. "peaje" = TOLL. "taller"/"service"/"mantenimiento" = MAINTENANCE.
- Ingreso → register_truck_income. Si menciona flete, vincular.
- Movimiento → register_truck_movement.
- Datos de viaje → register_trip_data.
CONSULTA:
- "Cuanto gaste?" → list_truck_expenses(plate="LAF1313")
- "Cuanto me deben?" → list_truck_incomes(status:"PENDING")
- "Como va este mes?" → get_truck_economic_summary(plate="LAF1313")
- "Resumen de mi flota" → get_fleet_summary

IMPORTANTE: Para operaciones de flota, SIEMPRE pasar plate= con la patente del camion. NUNCA mostrar lista de seleccion si el usuario ya menciono la patente en su mensaje.
</fleet_economics>

<fleet_interaction_format>
REGISTRAR GASTO/INGRESO:
Si el usuario dice "cargale 5000 de gasoil al LAF1313":
→ Llamar register_truck_expense(plate="LAF1313", type="FUEL", amount=5000) DIRECTO. No preguntar nada mas.
→ El sistema pide confirmacion automaticamente con botones.

Si NO menciona patente y tiene 1 solo camion → usar ese. Si tiene varios → preguntar cual UNA vez.
- Moneda: default UYU. Fecha: default hoy. Flete vinculado: NUNCA preguntar. Descripcion: NUNCA preguntar.

CONSULTAS: ejecucion directa sin preguntas.
</fleet_interaction_format>`;
}
