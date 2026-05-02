export type WhatsAppActionButton = {
  id: string;
  title: string;
};

export type FreightActionButtonContext = {
  id: string;
  status: string;
  originCompanyId?: string | null;
  destCompanyId?: string | null;
  transporterFinishedConfirmedAt?: string | Date | null;
  plantFinishedConfirmedAt?: string | Date | null;
  producerLoadedConfirmedAt?: string | Date | null;
  assignmentTransportCompanyId?: string | null;
  assignmentDriverId?: string | null;
};

export function buildFreightActionButtons(
  freight: FreightActionButtonContext,
  user: any,
  activeCompanyId?: string | null,
): WhatsAppActionButton[] {
  const companyId = activeCompanyId || user?.activeCompanyId || user?.companyId || null;
  const isOrigin = !!companyId && companyId === freight.originCompanyId;
  const isDest = !!companyId && companyId === freight.destCompanyId;
  const isTransporter = !!companyId && companyId === freight.assignmentTransportCompanyId;
  const isDriver = !!user?.id && user.id === freight.assignmentDriverId;
  const isOwnFleet = !!freight.assignmentTransportCompanyId
    && freight.assignmentTransportCompanyId === freight.originCompanyId;
  const isTransporterRole = isTransporter || isDriver || (isOrigin && isOwnFleet);
  const buttons: WhatsAppActionButton[] = [];

  switch (freight.status) {
    case 'assigned':
      if (isTransporterRole) {
        buttons.push({ id: `accept:${freight.id}`, title: 'ACEPTAR' });
        buttons.push({ id: `reject:${freight.id}`, title: 'RECHAZAR' });
      }
      break;
    case 'accepted':
      if (isTransporterRole) {
        buttons.push({ id: `start:${freight.id}`, title: 'INICIAR VIAJE' });
      }
      break;
    case 'in_progress':
      if (isTransporterRole) {
        buttons.push({ id: `confirm_loaded:${freight.id}`, title: 'CONFIRMAR CARGA' });
      }
      break;
    case 'loaded':
      if (isTransporterRole && !freight.transporterFinishedConfirmedAt) {
        buttons.push({ id: `confirm_finished:${freight.id}`, title: 'CONFIRMAR ENTREGA' });
      }
      if (isDest && !freight.plantFinishedConfirmedAt) {
        buttons.push({ id: `confirm_finished:${freight.id}`, title: 'CONFIRMAR RECEPCION' });
      }
      if (isOrigin && !isOwnFleet && !freight.producerLoadedConfirmedAt) {
        buttons.push({ id: `confirm_loaded:${freight.id}`, title: 'CONFIRMAR CARGA' });
      }
      break;
  }

  return buttons.slice(0, 3);
}
