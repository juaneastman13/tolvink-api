"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
async function del(model, label, where) {
    try {
        const r = await model.deleteMany(where ? { where } : undefined);
        console.log(`  ${label.padEnd(28)} ${r.count}`);
        return r.count;
    }
    catch (e) {
        if (e.message?.includes('does not exist')) {
            console.log(`  ${label.padEnd(28)} (table not found — skipped)`);
            return 0;
        }
        throw e;
    }
}
async function main() {
    const adminEmail = process.argv[2];
    const admin = await prisma.user.findFirst({
        where: adminEmail
            ? { email: adminEmail }
            : { isSuperAdmin: true },
        select: { id: true, email: true, name: true },
    });
    if (!admin) {
        console.error('No admin user found.' + (adminEmail ? ` Email "${adminEmail}" not found.` : ' No user with is_super_admin=true.'));
        process.exit(1);
    }
    console.log(`\nPreserving admin: ${admin.name} (${admin.email})\n`);
    console.log('WARNING: This will DELETE all data except this user.');
    console.log('  Press Ctrl+C within 5 seconds to abort...\n');
    await new Promise(r => setTimeout(r, 5000));
    const adminId = admin.id;
    console.log('Deleting data...\n');
    await del(prisma.freightTracking, 'FreightTracking');
    await del(prisma.liveLocation, 'LiveLocation');
    await del(prisma.weighTicket, 'WeighTicket');
    await del(prisma.freightDocument, 'FreightDocument');
    await del(prisma.freightItem, 'FreightItem');
    await del(prisma.freightPendingChange, 'FreightPendingChange');
    await del(prisma.freightAssignment, 'FreightAssignment');
    await del(prisma.message, 'Message');
    await del(prisma.conversationParticipant, 'ConversationParticipant');
    await del(prisma.conversation, 'Conversation');
    await del(prisma.auditLog, 'AuditLog');
    await del(prisma.notification, 'Notification');
    await del(prisma.analyticsEvent, 'AnalyticsEvent');
    await del(prisma.freight, 'Freight');
    await del(prisma.sharedPoi, 'SharedPoi');
    await del(prisma.sharedField, 'SharedField');
    await del(prisma.sharedLot, 'SharedLot');
    await del(prisma.plant, 'Plant');
    await del(prisma.lot, 'Lot');
    await del(prisma.field, 'Field');
    await del(prisma.poi, 'Poi');
    await del(prisma.truck, 'Truck');
    await del(prisma.branch, 'Branch');
    await del(prisma.plantProducerAccess, 'PlantProducerAccess');
    await del(prisma.whatsAppSession, 'WhatsAppSession');
    await del(prisma.whatsAppMessageLog, 'WhatsAppMessageLog');
    await del(prisma.passwordResetCode, 'PasswordResetCode');
    await del(prisma.pushSubscription, 'PushSubscription');
    await del(prisma.refreshToken, 'RefreshToken');
    await del(prisma.userCompany, 'UserCompany (others)', { userId: { not: adminId } });
    await del(prisma.userCompany, 'UserCompany (admin)', { userId: adminId });
    await prisma.user.update({
        where: { id: adminId },
        data: { companyId: null, activeCompanyId: null, companyByType: {}, roleByType: {} },
    });
    await del(prisma.user, 'User', { id: { not: adminId } });
    await del(prisma.company, 'Company');
    const [uCount, cCount, fCount] = await Promise.all([
        prisma.user.count(),
        prisma.company.count(),
        prisma.freight.count(),
    ]);
    console.log(`\nDone. Remaining: ${uCount} user(s), ${cCount} companies, ${fCount} freights.`);
    console.log(`Admin preserved: ${admin.email}\n`);
}
main()
    .catch(e => { console.error('Error:', e.message); process.exit(1); })
    .finally(() => prisma.$disconnect());
//# sourceMappingURL=nuke-data.js.map