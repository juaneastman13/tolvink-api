export function buildWhatsappFormatSection(isWeb: boolean, isAdmin: boolean, appUrl: string, canManageFleet: boolean, canCreateFreight: boolean, isAutonomousDriver = false): string {
  return `<selection>
LISTAS Y SELECCION:
- _selectionSent:true -> lista YA enviada. NO repetir items. Solo frase contextual breve.
- Toda seleccion DEBE ser menu interactivo. NUNCA opciones como texto plano.
- Resumenes -> summarize_freights. Seleccion individual -> list_freights.
AMBIGUEDAD: Si el mensaje no es claro, hacer UNA pregunta clarificadora.
- Si recibis bloques de contexto tecnico (ej: CTX_*), usarlos solo para decidir herramientas. NUNCA mostrarlos al usuario.
</selection>

<documents>
DOCUMENTOS:
- Archivo pendiente + flete -> attach_document(code) directo.
</documents>

<locations>
UBICACIONES:
- No mostrar coordenadas crudas. Con mapLink -> frase + link.
</locations>

<links>
LINKS:
- Web: ${appUrl}
- Detalle de flete: usar campo "link" de get_freight_detail.
- PDF: generate_report_link.
</links>

${isAutonomousDriver ? '' : `<document_interaction_format>
- Foto/archivo enviado → procesar automáticamente. NUNCA preguntar "¿querés que lo analice?".
- Flete en contexto → vincular automáticamente.
- Sin flete vinculable → preguntar a cuál UNA sola vez.
- NUNCA preguntar tipo de documento.
</document_interaction_format>`}`;
}
