/**
 * Clean all freight-related data from the database.
 * Keeps: users, companies, fields, lots, plants, trucks, branches,
 *        plant-producer access, user-company memberships, push subscriptions,
 *        refresh tokens.
 * Deletes: freights (+ cascading: items, assignments, documents, tracking,
 *          conversations, messages, participants, audit logs),
 *          notifications, whatsapp sessions, whatsapp message logs.
 *
 * Usage: npx ts-node scripts/clean-freights.ts
 */

import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();

  try {
    console.log('Connecting to database...');
    await prisma.$connect();

    // Count before
    const freightCount = await prisma.freight.count();
    const notifCount = await prisma.notification.count();
    const waSessionCount = await prisma.whatsAppSession.count();
    const waLogCount = await prisma.whatsAppMessageLog.count();

    console.log(`\nCurrent data:`);
    console.log(`  Freights: ${freightCount}`);
    console.log(`  Notifications: ${notifCount}`);
    console.log(`  WhatsApp sessions: ${waSessionCount}`);
    console.log(`  WhatsApp message logs: ${waLogCount}`);

    if (freightCount === 0 && notifCount === 0) {
      console.log('\nDatabase already clean. Nothing to delete.');
      return;
    }

    console.log('\nDeleting freight-related data...');

    // Use transaction for atomicity
    await prisma.$transaction([
      // 1. WhatsApp sessions (may reference freight flows)
      prisma.whatsAppSession.deleteMany({}),

      // 2. WhatsApp message logs
      prisma.whatsAppMessageLog.deleteMany({}),

      // 3. Notifications (entityId references freights but no FK cascade)
      prisma.notification.deleteMany({}),

      // 4. Analytics events (clean slate for testing)
      prisma.analyticsEvent.deleteMany({}),

      // 5. Delete all freights — cascades to:
      //    freight_items, freight_assignments, freight_documents,
      //    freight_tracking, conversations (→ messages, participants),
      //    audit_logs
      prisma.freight.deleteMany({}),
    ]);

    // Verify
    const remaining = await prisma.freight.count();
    const usersKept = await prisma.user.count();
    const companiesKept = await prisma.company.count();
    const fieldsKept = await prisma.field.count();
    const trucksKept = await prisma.truck.count();

    console.log('\nDone! Deleted all freight-related data.');
    console.log(`\nKept:`);
    console.log(`  Users: ${usersKept}`);
    console.log(`  Companies: ${companiesKept}`);
    console.log(`  Fields: ${fieldsKept}`);
    console.log(`  Trucks: ${trucksKept}`);
    console.log(`  Freights remaining: ${remaining}`);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
