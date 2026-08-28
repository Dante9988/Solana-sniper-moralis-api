/**
 * Phase 7B.1 — every contract file must import `z` from here, not from
 * "zod" directly, so `.openapi(...)` is always registered on the Zod
 * prototype before any schema uses it (extendZodWithOpenApi is a one-time,
 * order-sensitive side effect — see @asteasolutions/zod-to-openapi).
 */

import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

extendZodWithOpenApi(z);

export { z };
