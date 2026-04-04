"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
async function main() {
    const userId = process.argv[2] || '27299dd6-7dd3-481b-a8df-ccccfed7a769';
    const user = await prisma.user.findUnique({
        where: { id: userId },
        include: {
            company: { select: { id: true, name: true, type: true, types: true } },
            memberships: { include: { company: { select: { id: true, name: true, type: true, types: true } } } },
        },
    });
    if (!user) {
        console.log('User not found');
        return;
    }
    console.log('\n=== USER ===');
    console.log('name:', user.name);
    console.log('email:', user.email);
    console.log('role:', user.role);
    console.log('companyId:', user.companyId);
    console.log('activeCompanyId:', user.activeCompanyId);
    console.log('userTypes:', user.userTypes);
    console.log('companyByType:', user.companyByType);
    console.log('\n=== PRIMARY COMPANY ===');
    console.log(user.company);
    console.log('\n=== MEMBERSHIPS ===');
    for (const m of user.memberships) {
        console.log(`  ${m.companyId} — ${m.company?.name} (${m.company?.type}) active:${m.active} role:${m.role}`);
    }
    const activeCompany = user.memberships.find(m => m.companyId === (user.activeCompanyId || user.companyId) && m.active);
    console.log('\n=== RESOLVED ===');
    console.log('activeCompany:', activeCompany?.company?.name, activeCompany?.company?.type);
    const types = user.memberships
        .filter(m => m.active)
        .map(m => {
        const arr = Array.isArray(m.company?.types) && (m.company?.types).length > 0
            ? m.company?.types
            : [m.company?.type];
        return arr;
    }).flat();
    console.log('all userTypes:', [...new Set(types)]);
}
main().catch(console.error).finally(() => prisma.$disconnect());
//# sourceMappingURL=debug-user.js.map