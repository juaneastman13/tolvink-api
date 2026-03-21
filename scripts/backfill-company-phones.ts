/**
 * Backfill: assign fictitious phone numbers to companies without one.
 * Run: npx ts-node scripts/backfill-company-phones.ts
 * Or:  node -e "require('./dist/scripts/backfill-company-phones')"
 *
 * Uses sequential numbers: 099000001, 099000002, etc.
 */
import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  try {
    const noPhone = await prisma.company.findMany({
      where: { OR: [{ phone: null }, { phone: '' }] },
      select: { id: true, name: true, type: true },
      orderBy: { createdAt: 'asc' },
    });

    console.log(`Empresas sin teléfono: ${noPhone.length}`);
    if (noPhone.length === 0) { console.log('Nada que hacer.'); return; }

    for (let i = 0; i < noPhone.length; i++) {
      const phone = '09' + String(9000001 + i).padStart(7, '0');
      await prisma.company.update({ where: { id: noPhone[i].id }, data: { phone } });
      console.log(`  [${i + 1}/${noPhone.length}] ${noPhone[i].name} (${noPhone[i].type}) → ${phone}`);
    }

    console.log('Done.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
