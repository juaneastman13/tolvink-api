export type LocationRequestType = 'origin' | 'destination' | 'interest_point';
export type LocationSource = 'whatsapp_location' | 'map_picker' | 'backend_known_location';

export const LOCATION_MAP_FLOW = {
  name: 'location_map',
  supports: [
    'request_origin_location',
    'request_destination_location',
    'receive_whatsapp_location',
    'associate_location_to_active_draft',
  ],
} as const;

