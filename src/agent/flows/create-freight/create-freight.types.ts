export interface CreateFreightSlots {
  grain?: string;
  tons?: number;
  loadDate?: string; // YYYY-MM-DD
  loadTime?: string; // HH:MM
  originFieldId?: string;
  originLat?: number;
  originLng?: number;
  originName?: string;
  destName?: string;
  tolvinkPlantId?: string;
}

export type CreateFreightStep = 'opening' | 'collecting' | 'origin' | 'confirming';

export interface CreateFreightState {
  step: CreateFreightStep;
  slots: CreateFreightSlots;
  meta?: Record<string, any>; // tracks state like originPromptShown, confirmPromptShown
  missingSlots?: string[]; // tracks what's missing to ask next
}

export interface TolvinkPlantOption {
  id: string;
  name: string;
}

export interface FieldOption {
  id: string;
  name: string;
  lat?: number;
  lng?: number;
}
