import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const deadline = Date.now() + 30_000;
let lastError: unknown;

while (Date.now() < deadline) {
  try {
    await db.$queryRaw`SELECT 1`;
    await db.$disconnect();
    console.log("PostgreSQL is ready");
    process.exit(0);
  } catch (error) {
    lastError = error;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

await db.$disconnect();
console.error("PostgreSQL did not become ready within 30 seconds", lastError);
process.exit(1);
