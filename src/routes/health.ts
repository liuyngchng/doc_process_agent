import { Router, Request, Response } from 'express';
import { nowReadable } from '../time.js';

export function createHealthRouter(): Router {
  const router = Router();

  router.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      timestamp: nowReadable(),
    });
  });

  return router;
}