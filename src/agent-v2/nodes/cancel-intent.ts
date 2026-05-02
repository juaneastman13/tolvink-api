export function isGlobalCancelMessage(message: string): boolean {
  const text = normalize(message);
  return /^(cancelar|cancela|salir|cancel|abortar|anular|dejar|dejalo|deja eso)$/.test(text);
}

function normalize(value: string): string {
  return (value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

