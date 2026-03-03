// Quick diagnostic: check freight FLT-0018 data
// Run: npx ts-node scripts/debug-freight.ts
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const code = process.argv[2] || 'FLT-0018';

  const freight = await prisma.freight.findFirst({
    where: { code },
    include: {
      originCompany: { select: { id: true, name: true, type: true, types: true } },
      destCompany: { select: { id: true, name: true, type: true, types: true } },
      destPlant: { select: { id: true, name: true, companyId: true } },
      requestedBy: { select: { id: true, name: true, email: true, companyId: true } },
      assignments: { select: { id: true, transportCompanyId: true, status: true } },
      conversation: { select: { id: true, participants: { select: { companyId: true } } } },
    },
  });

  if (!freight) {
    console.log(`Freight ${code} not found`);
    return;
  }

  console.log('\n=== FREIGHT ===');
  console.log('code:', freight.code);
  console.log('status:', freight.status);
  console.log('originCompanyId:', freight.originCompanyId);
  console.log('destCompanyId:', freight.destCompanyId, freight.destCompanyId ? '✅' : '❌ NULL — DEST COMPANY NOT LINKED!');
  console.log('destPlantId:', freight.destPlantId);
  console.log('destName:', freight.destName);
  console.log('originName:', freight.originName);
  console.log('isOwnFleet:', (freight as any).isOwnFleet);

  console.log('\n=== ORIGIN COMPANY ===');
  console.log(freight.originCompany);

  console.log('\n=== DEST COMPANY ===');
  console.log(freight.destCompany || '❌ NULL — No dest company linked!');

  console.log('\n=== DEST PLANT ===');
  console.log(freight.destPlant || '(no plant record)');

  console.log('\n=== REQUESTED BY ===');
  console.log(freight.requestedBy);

  console.log('\n=== CONVERSATION PARTICIPANTS ===');
  console.log(freight.conversation?.participants || '(no conversation)');

  // Check if dest company exists by name
  if (!freight.destCompanyId && freight.destName) {
    const byName = await prisma.company.findMany({
      where: { name: { contains: freight.destName, mode: 'insensitive' }, active: true },
      select: { id: true, name: true, type: true, types: true },
    });
    console.log(`\n=== COMPANIES MATCHING "${freight.destName}" ===`);
    console.log(byName.length ? byName : 'NONE FOUND');
  }

  // Check PlantProducerAccess
  if (freight.originCompanyId) {
    const access = await prisma.plantProducerAccess.findMany({
      where: { producerCompanyId: freight.originCompanyId, active: true },
      include: { plantCompany: { select: { id: true, name: true, type: true } } },
    });
    console.log('\n=== PLANT-PRODUCER ACCESS (from origin company) ===');
    console.log(access.length ? access.map(a => `${a.plantCompanyId} — ${a.plantCompany?.name} (${a.plantCompany?.type})`) : 'NONE — no access records!');
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
