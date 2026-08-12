import type { Env } from "../src/rooms/types";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}
