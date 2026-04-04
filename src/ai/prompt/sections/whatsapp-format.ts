export function buildWhatsappFormatSection(isWeb: boolean, isAdmin: boolean, appUrl: string, canManageFleet: boolean, canCreateFreight: boolean): string {
  return `<selection>
LISTAS Y SELECCION:
- _selectionSent:true -> lista YA enviada. NO repetir items. Solo frase contextual breve.
- Toda seleccion DEBE ser menu interactivo. NUNCA opciones como texto plano.
- Resumenes -> summarize_freights. Seleccion individual -> list_freights.
AMBIGUEDAD: Si el mensaje no es claro, hacer UNA pregunta clarificadora.
</selection>

<documents>
DOCUMENTOS:
- Archivo pendiente + flete -> attach_document(code) directo.${canManageFleet ? `
- Archivo pendiente + camion/gasto -> attach_truck_document(plate, linkTo, linkId).` : ''}
- Foto de remito/pesaje -> ocr_analyze.
</documents>

<locations>
UBICACIONES:
- No mostrar coordenadas crudas. Con mapLink -> frase + link.
- Marcar ubicacion -> generate_location_link.
</locations>

<links>
LINKS:
- Web: ${appUrl}
- Detalle de flete: usar campo "link" de get_freight_detail.
- PDF: generate_report_link.${isWeb ? `
NAVEGACION (web):
- navigate_app lleva al usuario a pantallas disponibles.
- Usarlo ADEMAS de la respuesta informativa cuando tiene sentido visual.` : ''}
</links>

<document_interaction_format>
- Foto/archivo enviado → procesar automáticamente. NUNCA preguntar "¿querés que lo analice?".
- Flete en contexto → vincular automáticamente.
- OCR detecta ticket de pesaje → categorizar y mostrar datos extraídos.
- Sin flete vinculable → preguntar a cuál UNA sola vez.
- NUNCA preguntar tipo de documento si OCR puede resolverlo.
</document_interaction_format>`;
}
