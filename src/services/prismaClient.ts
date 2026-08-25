import { PrismaClient } from "@prisma/client";

// Shared singleton for the intelligence layer's structured, multi-model
// writes, matching the module-level singleton pattern already used in
// src/services/tokenTrackingService.ts.
export const prisma = new PrismaClient();
