// =====================================================================
// TOLVINK — Database Seed
// Run: npx prisma db seed
// =====================================================================

import { PrismaClient, CompanyType, UserRole, FreightStatus, GrainType } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  const hash = await bcrypt.hash('1234', 10);

  // ======================== COMPANIES ================================

  const producer = await prisma.company.create({
    data: { name: 'Est. Las Acacias', type: CompanyType.producer, address: 'Ruta 50 km 12, Colonia', phone: '099 333 111' },
  });

  const plant = await prisma.company.create({
    data: { name: 'SOFOVAL', type: CompanyType.plant, address: 'Ruta 1 km 123, Colonia', phone: '099 111 111' },
  });

  const transport1 = await prisma.company.create({
    data: { name: 'Transportes del Sur', type: CompanyType.transporter, address: 'Av. Italia 2345, Montevideo', phone: '099 222 111' },
  });

  const transport2 = await prisma.company.create({
    data: { name: 'Logística Norte', type: CompanyType.transporter, address: 'Ruta 5 km 60, Durazno', phone: '099 222 112' },
  });

  // ======================== USERS ====================================

  const platformAdmin = await prisma.user.create({
    data: { email: 'admin@tolvink.com', passwordHash: hash, name: 'Admin Tolvink', role: UserRole.platform_admin, phone: '099 000 001' },
  });

  const producerAdmin = await prisma.user.create({
    data: { email: 'juan@campo.com', passwordHash: hash, name: 'Juan Pérez', role: UserRole.admin, companyId: producer.id, phone: '099 300 001' },
  });

  const plantAdmin = await prisma.user.create({
    data: { email: 'carolina@planta.com', passwordHash: hash, name: 'Carolina Méndez', role: UserRole.admin, companyId: plant.id, phone: '099 100 001' },
  });

  const plantOperator = await prisma.user.create({
    data: { email: 'maria@planta.com', passwordHash: hash, name: 'María López', role: UserRole.operator, companyId: plant.id, phone: '099 100 002' },
  });

  const transportAdmin1 = await prisma.user.create({
    data: { email: 'ricardo@transp.com', passwordHash: hash, name: 'Ricardo Vega', role: UserRole.admin, companyId: transport1.id, phone: '099 200 001' },
  });

  const transportOperator1 = await prisma.user.create({
    data: { email: 'miguel@transp.com', passwordHash: hash, name: 'Miguel Torres', role: UserRole.operator, companyId: transport1.id, phone: '099 200 002' },
  });

  const transportAdmin2 = await prisma.user.create({
    data: { email: 'diego@logistica.com', passwordHash: hash, name: 'Diego Romero', role: UserRole.admin, companyId: transport2.id, phone: '099 200 003' },
  });

  // ======================== PLANTS ===================================

  const sofoval = await prisma.plant.create({
    data: { name: 'SOFOVAL', companyId: plant.id, address: 'Ruta 1 km 123', lat: -34.35, lng: -56.51 },
  });

  await prisma.plant.createMany({
    data: [
      { name: 'FADISOL', companyId: plant.id, address: 'Ruta 3 km 45', lat: -34.33, lng: -56.52 },
      { name: 'CRADECO', companyId: plant.id, address: 'Ruta 1 km 130', lat: -34.36, lng: -56.50 },
      { name: 'AGROTERRA', companyId: plant.id, address: 'Ruta 1 km 140', lat: -34.34, lng: -56.49 },
      { name: 'MGAP PALMIRA', companyId: plant.id, address: 'Palmira, Colonia', lat: -34.38, lng: -57.22 },
    ],
  });

  // ======================== LOTS =====================================

  const loteNorte = await prisma.lot.create({
    data: { name: 'Lote Norte — 42ha', companyId: producer.id, hectares: 42, lat: -33.89, lng: -60.57 },
  });

  await prisma.lot.createMany({
    data: [
      { name: 'Lote Sur — 28ha', companyId: producer.id, hectares: 28, lat: -33.92, lng: -60.55 },
      { name: 'Lote Este — 35ha', companyId: producer.id, hectares: 35, lat: -33.88, lng: -60.52 },
    ],
  });

  // ======================== SAMPLE FREIGHT ============================

  const freight1 = await prisma.freight.create({
    data: {
      code: 'FLT-0001',
      status: FreightStatus.pending_assignment,
      originCompanyId: producer.id,
      originLotId: loteNorte.id,
      originName: 'Lote Norte — 42ha',
      originLat: -33.89,
      originLng: -60.57,
      destCompanyId: plant.id,
      destPlantId: sofoval.id,
      destName: 'SOFOVAL',
      destLat: -34.35,
      destLng: -56.51,
      loadDate: new Date('2026-02-20'),
      loadTime: '08:00',
      requestedById: producerAdmin.id,
      notes: 'Acceso por portón norte',
      items: {
        create: [
          { grain: GrainType.Soja, tons: 30 },
        ],
      },
      conversation: {
        create: {},
      },
    },
  });

  // Audit log for creation
  await prisma.auditLog.create({
    data: {
      entityType: 'freight',
      entityId: freight1.id,
      action: 'created',
      toValue: 'pending_assignment',
      userId: producerAdmin.id,
    },
  });

  console.log('Seed completed.');
  console.log('');
  console.log('Demo accounts (password: 1234):');
  console.log('  admin@tolvink.com     — Platform Admin');
  console.log('  juan@campo.com        — Productor (admin)');
  console.log('  carolina@planta.com   — Planta (admin)');
  console.log('  maria@planta.com      — Planta (operator)');
  console.log('  ricardo@transp.com    — Transportista 1 (admin)');
  console.log('  miguel@transp.com     — Transportista 1 (operator)');
  console.log('  diego@logistica.com   — Transportista 2 (admin)');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
