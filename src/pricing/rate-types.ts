import type { Decimal } from "@prisma/client/runtime/library";

export interface PriceResult {
  amount: Decimal | number;
  rateId: string;
  source: string;
  units?: number;
}
