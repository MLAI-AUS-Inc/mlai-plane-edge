import { handleRequest } from "./gateway";
import type { Env } from "./types";

export default {
  fetch(request, env): Promise<Response> {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<Env>;

export { handleRequest } from "./gateway";
