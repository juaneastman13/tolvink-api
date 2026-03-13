// =====================================================================
// TOLVINK — Prisma Decimal → Number Serialization Interceptor
// Prevents Prisma Decimal objects from reaching API responses
// =====================================================================

import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Decimal } from '@prisma/client/runtime/library';

/**
 * Recursively converts Prisma Decimal instances to JavaScript numbers.
 * Applied globally so no endpoint accidentally leaks Decimal objects.
 */
function transformDecimals(value: any): any {
  if (value === null || value === undefined) return value;
  if (value instanceof Decimal) return value.toNumber();
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(transformDecimals);
  if (typeof value === 'object') {
    const result: any = {};
    for (const key of Object.keys(value)) {
      result[key] = transformDecimals(value[key]);
    }
    return result;
  }
  return value;
}

@Injectable()
export class DecimalTransformInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(
      map((data) => transformDecimals(data)),
    );
  }
}
