export const FLOW_CATALOG = {
  create_freight: {
    name: 'create_freight',
    requiredSlots: ['product', 'origin', 'destination', 'date', 'time', 'truckCount'],
  },
  query_freights: { name: 'query_freights', requiredSlots: [] },
  confirm_loaded: { name: 'confirm_loaded', requiredSlots: ['freightCode'] },
  finish_freight: { name: 'finish_freight', requiredSlots: ['freightCode'] },
  assign_driver_truck: { name: 'assign_driver_truck', requiredSlots: ['freightCode', 'driver', 'truck'] },
  assign_transport_company: { name: 'assign_transport_company', requiredSlots: ['freightCode', 'transportCompany'] },
  location_map: { name: 'location_map', requiredSlots: ['freightCode'] },
  document_attach: { name: 'document_attach', requiredSlots: ['freightCode'] },
  cancel_freight: { name: 'cancel_freight', requiredSlots: ['freightCode', 'reason'] },
} as const;

