import { AgentActionName } from '../schemas/action.schema';

export type ActionCatalogEntry = {
  action: AgentActionName;
  mutates: boolean;
  sensitive: boolean;
  audit: boolean;
};

export const ACTION_CATALOG: Record<AgentActionName, ActionCatalogEntry> = {
  create_freight: { action: 'create_freight', mutates: true, sensitive: true, audit: true },
  update_freight: { action: 'update_freight', mutates: true, sensitive: true, audit: true },
  cancel_freight: { action: 'cancel_freight', mutates: true, sensitive: true, audit: true },
  assign_transport_company: { action: 'assign_transport_company', mutates: true, sensitive: true, audit: true },
  assign_driver_and_truck: { action: 'assign_driver_and_truck', mutates: true, sensitive: true, audit: true },
  confirm_loaded: { action: 'confirm_loaded', mutates: true, sensitive: true, audit: true },
  confirm_arrival: { action: 'confirm_arrival', mutates: true, sensitive: false, audit: true },
  finish_freight: { action: 'finish_freight', mutates: true, sensitive: true, audit: true },
  generate_map_link: { action: 'generate_map_link', mutates: false, sensitive: false, audit: true },
  attach_document: { action: 'attach_document', mutates: true, sensitive: false, audit: true },
};

