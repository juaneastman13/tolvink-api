"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
async function main() {
    const prisma = new client_1.PrismaClient();
    try {
        console.log('Connecting to database...');
        await prisma.$connect();
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
        await prisma.$transaction([
            prisma.whatsAppSession.deleteMany({}),
            prisma.whatsAppMessageLog.deleteMany({}),
            prisma.notification.deleteMany({}),
            prisma.analyticsEvent.deleteMany({}),
            prisma.freight.deleteMany({}),
        ]);
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
    }
    catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
    finally {
        await prisma.$disconnect();
    }
}
main();
//# sourceMappingURL=clean-freights.js.map