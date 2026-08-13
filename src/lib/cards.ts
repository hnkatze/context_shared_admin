import { withTenant } from "./db";

/** A card is only ever read to be judged, so the list stays bounded rather than paged. */
const MAX_CARDS = 200;

export type Decision = {
  readonly choice: string;
  readonly rejected: string;
  readonly reason: string;
};

/**
 * `kind` is deliberately unconstrained: live rows already carry values beyond the
 * documented commit/pr/endpoint set, and a stricter guard would blank a valid card.
 */
export type SourceRef = {
  readonly kind: string;
  readonly ref: string;
};

/** A jsonb column reaches the panel as parsed-but-unverified JSON; a bad row degrades, never throws. */
export type JsonColumn<TItem> =
  | { readonly status: "ok"; readonly items: readonly TItem[] }
  | { readonly status: "unreadable" };

export type CardView = {
  readonly cardKey: string;
  readonly module: string;
  readonly summary: string;
  readonly whyNotObvious: string;
  readonly decisions: JsonColumn<Decision>;
  readonly sourceRefs: JsonColumn<SourceRef>;
  readonly gotchas: readonly string[];
  readonly consumerNotes: readonly string[];
  readonly tags: readonly string[];
  readonly author: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly projectSlug: string;
  readonly projectName: string;
};

export type ProjectFacet = {
  readonly slug: string;
  readonly name: string;
  readonly count: number;
};

export type CardFilters = {
  readonly query: string;
  readonly module: string;
  readonly project: string;
};

export type CardsView = {
  readonly cards: readonly CardView[];
  /** Matches before the list is capped, so the count line cannot overstate what is shown. */
  readonly total: number;
  readonly modules: readonly string[];
  readonly projects: readonly ProjectFacet[];
};

export type CardLookup =
  | { readonly status: "found"; readonly card: CardView }
  | { readonly status: "not-found" };

export type DeleteOutcome =
  | { readonly status: "deleted"; readonly rows: number }
  | { readonly status: "mismatch" }
  | { readonly status: "already-gone" }
  | { readonly status: "failed"; readonly message: string };

/** Columns as Postgres returns them; the two jsonb ones are parsed JSON of unproven shape. */
type CardRow = {
  readonly card_key: string;
  readonly module: string;
  readonly summary: string;
  readonly why_not_obvious: string;
  readonly decisions: unknown;
  readonly gotchas: readonly string[];
  readonly consumer_notes: readonly string[];
  readonly source_refs: unknown;
  readonly tags: readonly string[];
  readonly author: string;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly project_slug: string;
  readonly project_name: string;
};

type MatchCount = { readonly match_count: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDecision(value: unknown): value is Decision {
  return (
    isRecord(value) &&
    typeof value.choice === "string" &&
    typeof value.rejected === "string" &&
    typeof value.reason === "string"
  );
}

function isSourceRef(value: unknown): value is SourceRef {
  return isRecord(value) && typeof value.kind === "string" && typeof value.ref === "string";
}

/** The annotated return type is what keeps `Array.isArray`'s `any[]` from leaking outward. */
function asList(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function parseColumn<TItem>(
  value: unknown,
  isItem: (candidate: unknown) => candidate is TItem,
): JsonColumn<TItem> {
  const items = asList(value);
  if (items === null) return { status: "unreadable" };
  return items.every(isItem) ? { status: "ok", items } : { status: "unreadable" };
}

export function parseDecisions(value: unknown): JsonColumn<Decision> {
  return parseColumn(value, isDecision);
}

export function parseSourceRefs(value: unknown): JsonColumn<SourceRef> {
  return parseColumn(value, isSourceRef);
}

function toCardView(row: CardRow): CardView {
  return {
    cardKey: row.card_key,
    module: row.module,
    summary: row.summary,
    whyNotObvious: row.why_not_obvious,
    decisions: parseDecisions(row.decisions),
    sourceRefs: parseSourceRefs(row.source_refs),
    gotchas: row.gotchas,
    consumerNotes: row.consumer_notes,
    tags: row.tags,
    author: row.author,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    projectSlug: row.project_slug,
    projectName: row.project_name,
  };
}

const CARD_COLUMNS = `c.card_key, c.module, c.summary, c.why_not_obvious, c.decisions,
          c.gotchas, c.consumer_notes, c.source_refs, c.tags, c.author,
          c.created_at, c.updated_at, p.slug as project_slug, p.name as project_name`;

/** A null parameter makes its filter branch true, so no filter value is ever spliced into SQL. */
function nullable(value: string): string | null {
  return value === "" ? null : value;
}

export async function loadCards(orgId: string, filters: CardFilters): Promise<CardsView> {
  return withTenant(orgId, async (client) => {
    const query = nullable(filters.query);
    const module = nullable(filters.module);
    const project = nullable(filters.project);

    const cardResult = await client.query<CardRow & MatchCount>(
      `select ${CARD_COLUMNS}, (count(*) over ())::int as match_count
         from cards c
         join projects p on p.id = c.project_id
        where ($1::text is null or c.search_vector @@ plainto_tsquery('simple', $1))
          and ($2::text is null or c.module = $2)
          and ($3::text is null or p.slug = $3)
        order by c.updated_at desc
        limit ${MAX_CARDS}`,
      [query, module, project],
    );

    // Every module on the board, not only the ones surviving the filters: a select that
    // hides the option you are trying to switch to is a dead end.
    const moduleResult = await client.query<{ module: string }>(
      "select distinct module from cards order by module",
    );

    // Counted under the search and the module but not under the project, so the chips can
    // say where the matches are — including in the project you are not looking at.
    const projectResult = await client.query<ProjectFacet>(
      `select p.slug, p.name, count(c.id)::int as count
         from projects p
         left join cards c
           on c.project_id = p.id
          and ($1::text is null or c.search_vector @@ plainto_tsquery('simple', $1))
          and ($2::text is null or c.module = $2)
        group by p.slug, p.name
        order by p.slug`,
      [query, module],
    );

    return {
      cards: cardResult.rows.map(toCardView),
      total: cardResult.rows.at(0)?.match_count ?? 0,
      modules: moduleResult.rows.map((row) => row.module),
      projects: projectResult.rows,
    };
  });
}

/** `card_key` is unique per project, never board-wide, so the slug is half of the identity. */
export async function findCard(
  orgId: string,
  projectSlug: string,
  cardKey: string,
): Promise<CardLookup> {
  return withTenant(orgId, async (client) => {
    const result = await client.query<CardRow>(
      `select ${CARD_COLUMNS}
         from cards c
         join projects p on p.id = c.project_id
        where c.org_id = $1 and p.slug = $2 and c.card_key = $3`,
      [orgId, projectSlug, cardKey],
    );
    const row = result.rows.at(0);
    return row === undefined ? { status: "not-found" } : { status: "found", card: toCardView(row) };
  });
}

/**
 * The typed confirmation is compared against the stored key inside the same transaction as the
 * delete, so no submitted field can assert that the operator confirmed anything.
 */
export async function deleteCard(
  orgId: string,
  projectSlug: string,
  cardKey: string,
  typedConfirmation: string,
): Promise<DeleteOutcome> {
  try {
    return await withTenant(orgId, async (client) => {
      const found = await client.query<{ card_key: string }>(
        `select c.card_key
           from cards c
           join projects p on p.id = c.project_id
          where c.org_id = $1 and p.slug = $2 and c.card_key = $3
            for update of c`,
        [orgId, projectSlug, cardKey],
      );
      const target = found.rows.at(0);
      if (target === undefined) return { status: "already-gone" };
      if (typedConfirmation !== target.card_key) return { status: "mismatch" };

      const deleted = await client.query(
        `delete from cards c
          using projects p
          where p.id = c.project_id
            and c.org_id = $1 and p.slug = $2 and c.card_key = $3`,
        [orgId, projectSlug, cardKey],
      );
      const rows = deleted.rowCount ?? 0;
      return rows === 0 ? { status: "already-gone" } : { status: "deleted", rows };
    });
  } catch (error) {
    return { status: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}
