import { AgentIntent } from '../schemas/intent.schema';

export type IntentCatalogEntry = {
  intent: AgentIntent;
  description: string;
  examples: string[];
};

export const INTENT_CATALOG: IntentCatalogEntry[] = [
  { intent: 'greet', description: 'Saludo o apertura de menu.', examples: ['hola', 'menu', 'buenas'] },
  { intent: 'help', description: 'Pedido de ayuda.', examples: ['ayuda', 'que puedo hacer'] },
  { intent: 'query_freights', description: 'Consulta de fletes existentes.', examples: ['mis fletes', 'ver fletes activos'] },
  { intent: 'create_freight', description: 'Crear o solicitar un nuevo flete.', examples: ['necesito 2 camiones manana para soja', 'crear flete'] },
  { intent: 'assign_transport_company', description: 'Asignar empresa transportista.', examples: ['asignar transportista'] },
  { intent: 'assign_driver_and_truck', description: 'Asignar chofer y camion.', examples: ['asignar camion y chofer'] },
  { intent: 'confirm_loaded', description: 'Confirmar carga.', examples: ['ya cargue', 'cargado'] },
  { intent: 'confirm_arrival', description: 'Confirmar llegada.', examples: ['llegue a planta'] },
  { intent: 'finish_freight', description: 'Finalizar flete o viaje.', examples: ['termine', 'descargue'] },
  { intent: 'cancel_freight', description: 'Cancelar flete.', examples: ['cancelar flete'] },
  { intent: 'share_map', description: 'Compartir o cargar ubicacion/mapa.', examples: ['pasame el mapa', 'marcar ubicacion'] },
  { intent: 'attach_document', description: 'Adjuntar documento a flete.', examples: ['adjuntar foto al flete'] },
  { intent: 'switch_company', description: 'Cambiar empresa activa.', examples: ['cambiar empresa'] },
];

