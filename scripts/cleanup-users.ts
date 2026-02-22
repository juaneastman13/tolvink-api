// Script temporal: Borrar todos los usuarios excepto juaneastman@gmail.com y agustin@productor.com
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const keepEmails = ['juaneastman@gmail.com', 'agustin@productor.com'];

  console.log('🔍 Finding users to keep...');
  const usersToKeep = await prisma.user.findMany({
    where: { email: { in: keepEmails } },
    select: { id: true, email: true, name: true },
  });

  console.log('✅ Users to keep:', usersToKeep);

  const keepIds = usersToKeep.map(u => u.id);

  console.log('🗑️  Deleting all Freights first (to remove user references)...');
  try {
    await prisma.$executeRawUnsafe('DELETE FROM "FreightItem"');
    await prisma.$executeRawUnsafe('DELETE FROM "ConversationMessage"');
    await prisma.$executeRawUnsafe('DELETE FROM "Conversation"');
    await prisma.$executeRawUnsafe('DELETE FROM "FreightDocument"');
    await prisma.$executeRawUnsafe('DELETE FROM "Freight"');
    console.log('   Deleted all Freights and related data');
  } catch (e: any) {
    console.log('   Skipping Freight deletion (already deleted or tables missing)');
  }

  console.log('🗑️  Deleting UserCompany relations...');
  const deletedUC = await prisma.userCompany.deleteMany({
    where: { userId: { notIn: keepIds } },
  });
  console.log(`   Deleted ${deletedUC.count} UserCompany relations`);

  console.log('🗑️  Deleting Notifications...');
  const deletedN = await prisma.notification.deleteMany({
    where: { userId: { notIn: keepIds } },
  });
  console.log(`   Deleted ${deletedN.count} Notifications`);

  console.log('🗑️  Deleting Users...');
  const deletedU = await prisma.user.deleteMany({
    where: { email: { notIn: keepEmails } },
  });
  console.log(`   Deleted ${deletedU.count} Users`);

  console.log('✅ Remaining users:');
  const remaining = await prisma.user.findMany({
    select: { id: true, email: true, name: true, role: true },
  });
  console.table(remaining);

  console.log('🎉 Done!');
}

main()
  .catch((e) => {
    console.error('❌ Error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
