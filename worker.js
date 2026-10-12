import { handleProxy } from './proxy.js';

// Cloudflare Worker: serves public/ as static assets and relays /proxy/* to Profixio.
export default {
  async fetch(request, env) {
    return (await handleProxy(request)) ?? env.ASSETS.fetch(request);
  },
};
