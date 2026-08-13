import type { APIRoute } from "astro";
import { SESSION_COOKIE } from "../lib/auth";

/** POST only: a GET would let any embedded image sign the admin out. */
export const POST: APIRoute = ({ cookies, redirect }) => {
  cookies.delete(SESSION_COOKIE, { path: "/" });
  return redirect("/login", 303);
};
