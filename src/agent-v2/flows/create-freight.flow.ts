export const CREATE_FREIGHT_FLOW = {
  name: 'create_freight',
  steps: ['extract_slots', 'validate_slots', 'ask_missing_slot', 'check_policy', 'prepare_confirmation', 'execute_action'],
};

