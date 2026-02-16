// Quick script to check user in database
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkUser() {
  try {
    console.log('Connecting to database...');

    // Get the email from command line or use a default
    const email = process.argv[2];

    if (!email) {
      console.error('Usage: node check-user.js <email>');
      process.exit(1);
    }

    console.log('Looking for user:', email);

    const user = await prisma.user.findFirst({
      where: { email },
      include: { company: true }
    });

    if (!user) {
      console.log('❌ User not found');
      process.exit(0);
    }

    console.log('\n✅ User found:');
    console.log('ID:', user.id);
    console.log('Name:', user.name);
    console.log('Email:', user.email);
    console.log('Phone:', user.phone);
    console.log('Role:', user.role);
    console.log('Active:', user.active);
    console.log('CompanyId:', user.companyId);
    console.log('UserTypes:', user.userTypes);
    console.log('IsSuperAdmin:', user.isSuperAdmin);
    console.log('\nCompany:');
    if (user.company) {
      console.log('  ID:', user.company.id);
      console.log('  Name:', user.company.name);
      console.log('  Type:', user.company.type);
      console.log('  HasInternalFleet:', user.company.hasInternalFleet);
    } else {
      console.log('  ⚠️  NULL - User has no company');
    }

    console.log('\n✅ User is valid for login');

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error);
  } finally {
    await prisma.$disconnect();
  }
}

checkUser();
