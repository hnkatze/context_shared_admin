/** Vercel injects into process.env; `astro dev` injects into import.meta.env. Both matter. */
export function readEnv(name: string): string {
  const fromProcess = process.env[name];
  const fromVite = (import.meta.env as Record<string, string | undefined>)[name];
  const value = fromProcess ?? fromVite;
  if (value === undefined || value === "") {
    throw new Error(`Missing environment variable ${name}`);
  }
  return value;
}
