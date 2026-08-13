// Prints the PANEL_PASSWORD_HASH value for a password. Fields are colon-separated, not
// `$`-separated as crypt-style hashes usually are: Vite expands `$1`/`$8` inside a .env
// file and would truncate the hash before the panel could parse it. Usage:
//   node scripts/hash-password.mjs 'the password'
import { randomBytes, scryptSync } from "node:crypto";

const COST = 16384;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;
const KEY_LENGTH = 32;

const password = process.argv[2];
if (typeof password !== "string" || password.length === 0) {
  console.error("usage: node scripts/hash-password.mjs '<password>'");
  process.exit(1);
}

const salt = randomBytes(16);
const key = scryptSync(password.normalize("NFKC"), salt, KEY_LENGTH, {
  N: COST,
  r: BLOCK_SIZE,
  p: PARALLELIZATION,
  maxmem: 256 * COST * BLOCK_SIZE,
});

const parts = [
  "scrypt",
  COST,
  BLOCK_SIZE,
  PARALLELIZATION,
  salt.toString("base64"),
  key.toString("base64"),
];
console.log(parts.join(":"));
