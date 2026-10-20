import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../../lib/prisma';
import { PlatformEarningsQuerySchema } from '../../schema/platform-earnings.schema';
import { platformEarningsSql } from '../../services/platform-earnings.service';

export async function getPlatformEarnings(req: Request, res: Response, next: NextFunction) {
  try {
    const query = PlatformEarningsQuerySchema.parse(req.query);
    const [data] = await prisma.$queryRaw<Array<Record<string, unknown>>>(platformEarningsSql(query));
    res.set('Cache-Control', 'private, no-store');
    res.json({ success: true, data });
  } catch (error) { next(error); }
}
