// Node has no `cloudflare:` module scheme. @cloudflare/workers-oauth-provider
// imports WorkerEntrypoint from `cloudflare:workers` (it only uses it to tell
// class handlers from object handlers), so tests resolve that one specifier to
// a module carrying the same base class. Production runs in workerd, untouched.
import { register } from 'node:module';

const source = 'export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }';

register(
  'data:text/javascript,' + encodeURIComponent(`
    export async function resolve(specifier, context, next) {
      if (specifier === 'cloudflare:workers') {
        return { url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(source)}), shortCircuit: true };
      }
      return next(specifier, context);
    }
  `),
);
