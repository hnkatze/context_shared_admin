import { withTenant } from "./db";
import {
  findNearDuplicates,
  type NearDuplicatePair,
  type NearDuplicateReason,
  type ProjectIdentity,
} from "./projects";

/**
 * Arbitrary: the spec fixes no threshold, and no measurement justifies one yet.
 * This constant is the only definition of "stale" on the board — retune it here.
 */
export const STALE_AFTER_DAYS = 90;

/** The lists are a sample; the headline counts come from SQL over every row, so a cap never hides one. */
export const SAMPLE_LIMIT = 10;

export type HealthTotals = {
  readonly cards: number;
  readonly stale: number;
  readonly unverifiable: number;
};

export type StaleCard = {
  readonly cardKey: string;
  readonly summary: string;
  readonly projectName: string;
  readonly updatedAt: Date;
};

/** `no-anchors`: source_refs is an empty list. `malformed`: it is not a list at all. */
export type UnverifiableReason = "no-anchors" | "malformed";

export type UnverifiableCard = {
  readonly cardKey: string;
  readonly summary: string;
  readonly projectName: string;
  readonly reason: UnverifiableReason;
};

export type ForkSuspicion = {
  readonly suspect: ProjectIdentity;
  readonly real: ProjectIdentity;
  readonly suspectCardCount: number;
  readonly realCardCount: number;
  readonly reason: NearDuplicateReason;
  readonly distance: number;
};

export type BoardHealth = {
  readonly totals: HealthTotals;
  readonly stale: readonly StaleCard[];
  readonly unverifiable: readonly UnverifiableCard[];
  readonly forks: readonly ForkSuspicion[];
};

/** A percentage of the whole board, clamped so a proportion bar can never overrun its track. */
export function proportion(count: number, total: number): number {
  if (total <= 0 || count <= 0) return 0;
  return Math.min(100, (count / total) * 100);
}

/** /cards is the only place a card can be read in full or deleted; the query pre-filters to one. */
export function reviewHref(cardKey: string): string {
  return `/cards?q=${encodeURIComponent(cardKey)}`;
}

/**
 * The fork is the emptier slug: a typo is published to once and abandoned, while the real
 * project keeps accumulating. On a tie the alphabetically first slug is named, so the row is stable.
 */
export function orientFork(
  pair: NearDuplicatePair,
  cardCounts: ReadonlyMap<string, number>,
): ForkSuspicion {
  const leftCount = cardCounts.get(pair.left.slug) ?? 0;
  const rightCount = cardCounts.get(pair.right.slug) ?? 0;
  const leftIsSuspect = leftCount <= rightCount;
  return {
    suspect: leftIsSuspect ? pair.left : pair.right,
    real: leftIsSuspect ? pair.right : pair.left,
    suspectCardCount: leftIsSuspect ? leftCount : rightCount,
    realCardCount: leftIsSuspect ? rightCount : leftCount,
    reason: pair.reason,
    distance: pair.distance,
  };
}

const cardCount = (count: number): string => (count === 1 ? "1 card" : `${count} cards`);

/** Names the suspect in words, so the pairing never rests on the colour the slug is printed in. */
export function describeFork(fork: ForkSuspicion): string {
  const shape =
    fork.reason === "skeleton"
      ? "Identical apart from punctuation"
      : `${fork.distance === 1 ? "One character" : `${fork.distance} characters`} apart`;
  return `${shape}. ${fork.suspect.slug} holds ${cardCount(fork.suspectCardCount)}, ${fork.real.slug} holds ${cardCount(fork.realCardCount)}.`;
}

/**
 * jsonb_array_length raises on a non-array and Postgres does not promise to short-circuit
 * OR, so CASE — which does evaluate in order — is what keeps a malformed row from erroring.
 */
const UNVERIFIABLE_PREDICATE = `case
       when jsonb_typeof(c.source_refs) = 'array' then jsonb_array_length(c.source_refs) = 0
       else true
     end`;

const STALE_PREDICATE = (parameter: string): string =>
  `c.updated_at < now() - (${parameter}::int * interval '1 day')`;

type StaleRow = {
  readonly card_key: string;
  readonly summary: string;
  readonly project_name: string;
  readonly updated_at: Date;
};

type UnverifiableRow = {
  readonly card_key: string;
  readonly summary: string;
  readonly project_name: string;
  /** jsonb arrives already parsed, and nothing guarantees the shape the MCP wrote. */
  readonly source_refs: unknown;
};

type ProjectRow = {
  readonly slug: string;
  readonly name: string;
  readonly card_count: number;
};

/** Array.isArray widens `unknown` to `any[]`; this predicate keeps the element type honest. */
function isJsonArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/**
 * Every count is aggregated in Postgres and only the sampled rows travel, so the page cost
 * stays flat as the board grows. Read-only throughout: this screen never writes.
 */
export async function loadBoardHealth(orgId: string): Promise<BoardHealth> {
  return withTenant(orgId, async (client) => {
    const totalsResult = await client.query<HealthTotals>(
      `select count(*)::int as cards,
              count(*) filter (where ${STALE_PREDICATE("$1")})::int as stale,
              count(*) filter (where ${UNVERIFIABLE_PREDICATE})::int as unverifiable
         from cards c`,
      [STALE_AFTER_DAYS],
    );

    const staleResult = await client.query<StaleRow>(
      `select c.card_key, c.summary, c.updated_at, p.name as project_name
         from cards c
         join projects p on p.id = c.project_id
        where ${STALE_PREDICATE("$1")}
        order by c.updated_at asc
        limit $2`,
      [STALE_AFTER_DAYS, SAMPLE_LIMIT],
    );

    const unverifiableResult = await client.query<UnverifiableRow>(
      `select c.card_key, c.summary, c.source_refs, p.name as project_name
         from cards c
         join projects p on p.id = c.project_id
        where ${UNVERIFIABLE_PREDICATE}
        order by c.updated_at desc
        limit $1`,
      [SAMPLE_LIMIT],
    );

    const projectResult = await client.query<ProjectRow>(
      `select p.slug, p.name, count(c.id)::int as card_count
         from projects p
         left join cards c on c.project_id = p.id
        group by p.slug, p.name
        order by p.slug`,
    );

    const cardCounts = new Map(projectResult.rows.map((row) => [row.slug, row.card_count]));
    const identities: readonly ProjectIdentity[] = projectResult.rows.map((row) => ({
      slug: row.slug,
      name: row.name,
    }));

    return {
      totals: totalsResult.rows.at(0) ?? { cards: 0, stale: 0, unverifiable: 0 },
      stale: staleResult.rows.map((row) => ({
        cardKey: row.card_key,
        summary: row.summary,
        projectName: row.project_name,
        updatedAt: row.updated_at,
      })),
      unverifiable: unverifiableResult.rows.map((row) => ({
        cardKey: row.card_key,
        summary: row.summary,
        projectName: row.project_name,
        reason: isJsonArray(row.source_refs) ? "no-anchors" : "malformed",
      })),
      forks: findNearDuplicates(identities).map((pair) => orientFork(pair, cardCounts)),
    };
  });
}
