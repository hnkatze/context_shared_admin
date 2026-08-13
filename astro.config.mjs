// @ts-check
import { defineConfig } from 'astro/config';

import vercel from '@astrojs/vercel';


// https://astro.build/config
export default defineConfig({
  // Every page in this panel reads per-tenant data, so nothing is prerendered.
  output: "server",

  adapter: vercel()
});
