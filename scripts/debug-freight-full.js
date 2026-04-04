"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
async function main() {
    const code = process.argv[2] || 'FLT-0020';
    const f = await prisma.freight.findFirst({
        where: { code },
        include: {
            items: true,
            originCompany: { select: { id: true, name: true, type: true, types: true, hasInternalFleet: true } },
            destCompany: { select: { id: true, name: true, type: true, types: true } },
            destPlant: { select: { id: true, name: true, companyId: true } },
            requestedBy: { select: { id: true, name: true, email: true, companyId: true, activeCompanyId: true } },
            assignments: {
                include: {
                    transportCompany: { select: { id: true, name: true } },
                    truck: { select: { id: true, plate: true, model: true } },
                    driver: { select: { id: true, name: true } },
                },
            },
            conversation: { select: { id: true, participants: { select: { companyId: true } } } },
            auditLogs: { orderBy: { createdAt: 'asc' } },
        },
    });
    if (!f) {
        console.log(`${code} not found`);
        return;
    }
    console.log('\n========== FREIGHT ==========');
    console.log('code:', f.code);
    console.log('status:', f.status);
    console.log('createdAt:', f.createdAt);
    console.log('loadDate:', f.loadDate, 'loadTime:', f.loadTime);
    console.log('truckCount:', f.truckCount, 'assignedTruckCount:', f.assignedTruckCount, 'isMultiTruck:', f.isMultiTruck);
    console.log('notes:', f.notes || '(none)');
    console.log('\n--- Origin ---');
    console.log('originCompanyId:', f.originCompanyId);
    console.log('originCompany:', f.originCompany?.name, `(${f.originCompany?.type})`, 'hasInternalFleet:', f.originCompany?.hasInternalFleet);
    console.log('originName:', f.originName);
    console.log('originLat:', f.originLat, 'originLng:', f.originLng);
    console.log('\n--- Dest ---');
    console.log('destCompanyId:', f.destCompanyId, f.destCompanyId ? '✅' : '❌ NULL');
    console.log('destCompany:', f.destCompany?.name, f.destCompany ? `(${f.destCompany.type})` : '');
    console.log('destPlantId:', f.destPlantId);
    console.log('destPlant:', f.destPlant || '(none)');
    console.log('destName:', f.destName);
    console.log('destLat:', f.destLat, 'destLng:', f.destLng);
    console.log('\n--- Requested By ---');
    console.log(f.requestedBy);
    console.log('\n--- Items ---');
    f.items.forEach(i => console.log(`  ${i.grain} — ${i.tons} tn`));
    console.log('\n--- Assignments ---');
    if (f.assignments.length === 0)
        console.log('  (none)');
    f.assignments.forEach(a => {
        console.log(`  id:${a.id} status:${a.status} transport:${a.transportCompany?.name || 'N/A'} truck:${a.truck?.plate || a.plate || 'N/A'} driver:${a.driver?.name || 'N/A'} tripStatus:${a.tripStatus || 'N/A'}`);
    });
    console.log('\n--- Conversation ---');
    console.log('participants:', f.conversation?.participants?.map(p => p.companyId) || '(none)');
    console.log('\n--- Audit Log ---');
    f.auditLogs.forEach(l => console.log(`  ${l.createdAt} | ${l.action} | ${l.fromValue || ''} → ${l.toValue || ''}`));
}
main().catch(console.error).finally(() => prisma.$disconnect());
//# sourceMappingURL=debug-freight-full.js.map