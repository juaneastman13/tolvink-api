const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  const variants = ['59898247552', '+59898247552', '098247552', '98247552'];
  const user = await p.user.findFirst({
    where: { OR: variants.map(ph => ({ phone: ph })) },
    include: {
      company: { select: { id: true, name: true, type: true, types: true, hasInternalFleet: true } },
      memberships: { where: { active: true }, include: { company: { select: { id: true, name: true, type: true, types: true, hasInternalFleet: true } } } },
    },
  });

  if (!user) { console.log('USER NOT FOUND'); return; }

  console.log('=== USER ===');
  console.log('id:', user.id);
  console.log('name:', user.name);
  console.log('phone:', user.phone);
  console.log('companyId:', user.companyId);
  console.log('activeCompanyId:', user.activeCompanyId);
  console.log('userTypes:', JSON.stringify(user.userTypes));
  console.log('companyByType:', JSON.stringify(user.companyByType));
  console.log('company:', JSON.stringify(user.company));
  console.log('memberships:');
  for (const m of user.memberships) {
    console.log('  -', m.companyId, m.company.name, 'type:', m.company.type, 'types:', JSON.stringify(m.company.types));
  }

  // Resolve producer company ID (same logic as flow service)
  let producerCompanyId = null;
  if (user.memberships.length > 0) {
    const pm = user.memberships.find(m =>
      m.company.type === 'producer' ||
      (Array.isArray(m.company.types) && m.company.types.includes('producer'))
    );
    if (pm) producerCompanyId = pm.companyId;
  }
  if (!producerCompanyId) {
    const ut = Array.isArray(user.userTypes) ? user.userTypes : [];
    const cbt = user.companyByType || {};
    if (ut.includes('producer') && cbt.producer) producerCompanyId = cbt.producer;
  }
  if (!producerCompanyId && user.company && user.company.type === 'producer') {
    producerCompanyId = user.companyId;
  }
  if (!producerCompanyId) {
    producerCompanyId = user.activeCompanyId || user.companyId;
  }
  console.log('\n=== RESOLVED ===');
  console.log('producerCompanyId:', producerCompanyId);

  // Check PlantProducerAccess
  const access = await p.plantProducerAccess.findMany({
    where: { producerCompanyId: producerCompanyId, active: true },
    select: { id: true, plantCompanyId: true, producerCompanyId: true, allowedPlantIds: true, active: true },
  });
  console.log('\n=== PLANT ACCESS for', producerCompanyId, '===');
  console.log('Records:', access.length);
  for (const a of access) {
    console.log('  plantCompanyId:', a.plantCompanyId, 'allowedPlantIds:', JSON.stringify(a.allowedPlantIds));
  }

  // All PlantProducerAccess
  const allAccess = await p.plantProducerAccess.findMany({
    select: { plantCompanyId: true, producerCompanyId: true, active: true },
  });
  console.log('\n=== ALL PLANT ACCESS ===');
  for (const a of allAccess) {
    console.log('  plant:', a.plantCompanyId, 'producer:', a.producerCompanyId, 'active:', a.active);
  }

  // All plants
  const plants = await p.plant.findMany({
    where: { active: true },
    select: { id: true, name: true, companyId: true },
  });
  console.log('\n=== ALL PLANTS ===');
  for (const pl of plants) {
    console.log('  id:', pl.id, 'name:', pl.name, 'companyId:', pl.companyId);
  }
}

main().catch(console.error).finally(() => p.$disconnect());
