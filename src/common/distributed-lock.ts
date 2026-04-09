import { Prisma } from '@prisma/client';

type PrismaLike = {
  $queryRaw<T = unknown>(query: TemplateStringsArray | Prisma.Sql, ...values: any[]): Promise<T>;
};

export async function tryAcquirePgLock(prisma: PrismaLike, key: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ locked: boolean }>>(
    Prisma.sql`SELECT pg_try_advisory_lock(hashtext(${key})) AS locked`,
  );
  return !!rows?.[0]?.locked;
}

export async function releasePgLock(prisma: PrismaLike, key: string): Promise<void> {
  await prisma.$queryRaw(
    Prisma.sql`SELECT pg_advisory_unlock(hashtext(${key}))`,
  ).catch(() => {});
}

export async function acquirePgLockWithWait(
  prisma: PrismaLike,
  key: string,
  waitMs = 2000,
  stepMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await tryAcquirePgLock(prisma, key)) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}
