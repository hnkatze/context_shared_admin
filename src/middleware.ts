import { defineMiddleware } from "astro:middleware";
import { SESSION_COOKIE, isSessionValid } from "./lib/auth";

const PUBLIC_PATHS = new Set(["/login"]);

/** Astro's own build output and the favicons; none of it reads tenant data. */
function isPublicAsset(pathname: string): boolean {
  return (
    pathname.startsWith("/_astro/") ||
    pathname.startsWith("/_image") ||
    pathname.startsWith("/favicon.")
  );
}

/**
 * The panel mints and revokes API keys, so every route is closed by default and
 * opened by exception; a new page is guarded the moment it is created.
 */
export const onRequest = defineMiddleware((context, next) => {
  const { pathname, search } = context.url;
  if (PUBLIC_PATHS.has(pathname) || isPublicAsset(pathname)) return next();
  if (isSessionValid(context.cookies.get(SESSION_COOKIE)?.value)) return next();
  return context.redirect(`/login?next=${encodeURIComponent(`${pathname}${search}`)}`);
});
