import { withTenant } from "./db";

export type ProjectIdentity = {
  readonly slug: string;
  readonly name: string;
};

/** `skeleton`: the slugs differ only in punctuation. `distance`: they differ by a typo. */
export type NearDuplicateReason = "skeleton" | "distance";

export type NearDuplicatePair = {
  readonly left: ProjectIdentity;
  readonly right: ProjectIdentity;
  readonly reason: NearDuplicateReason;
  readonly distance: number;
};

/** Two edits is a typo on a long slug and a different word on a short one. */
const MAX_TYPO_DISTANCE = 2;
const MIN_LENGTH_FOR_DISTANCE = 5;

export const MAX_PROJECT_NAME_LENGTH = 120;

/** Collapses `api_v2`, `api-v2` and `APIv2` onto one key so punctuation forks surface. */
export function slugSkeleton(slug: string): string {
  return slug.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Plain Levenshtein over two rolling rows; slugs are short, so the O(n·m) cost is irrelevant. */
export function slugDistance(left: string, right: string): number {
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;

  let previous: number[] = [];
  for (let column = 0; column <= right.length; column += 1) previous.push(column);

  for (let row = 0; row < left.length; row += 1) {
    const current: number[] = [row + 1];
    for (let column = 0; column < right.length; column += 1) {
      const substitution = previous[column] + (left[row] === right[column] ? 0 : 1);
      const deletion = previous[column + 1] + 1;
      const insertion = current[column] + 1;
      current.push(Math.min(substitution, deletion, insertion));
    }
    previous = current;
  }

  return previous[right.length];
}

/**
 * Short slugs skip the distance rule on purpose: two edits separate `web` from `api`,
 * which are genuinely different projects rather than one misspelled twice.
 */
export function findNearDuplicates(
  projects: readonly ProjectIdentity[],
): readonly NearDuplicatePair[] {
  const pairs: NearDuplicatePair[] = [];

  for (let i = 0; i < projects.length; i += 1) {
    const left = projects[i];
    for (let j = i + 1; j < projects.length; j += 1) {
      const right = projects[j];
      if (left.slug === right.slug) continue;

      const skeleton = slugSkeleton(left.slug);
      const distance = slugDistance(left.slug, right.slug);

      if (skeleton.length > 0 && skeleton === slugSkeleton(right.slug)) {
        pairs.push({ left, right, reason: "skeleton", distance });
        continue;
      }

      const longEnough =
        left.slug.length >= MIN_LENGTH_FOR_DISTANCE &&
        right.slug.length >= MIN_LENGTH_FOR_DISTANCE;
      if (longEnough && distance <= MAX_TYPO_DISTANCE) {
        pairs.push({ left, right, reason: "distance", distance });
      }
    }
  }

  return pairs;
}

export type RenameResult =
  | { readonly status: "renamed"; readonly name: string }
  | { readonly status: "rejected"; readonly message: string }
  | { readonly status: "unknown-slug" }
  | { readonly status: "failed"; readonly message: string };

/**
 * The slug is the agents' address for the project, so only the display name moves;
 * changing the slug would orphan every card already published against it.
 */
export async function renameProject(
  orgId: string,
  slug: string,
  name: string,
): Promise<RenameResult> {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return { status: "rejected", message: "A display name is required." };
  }
  if (trimmed.length > MAX_PROJECT_NAME_LENGTH) {
    return {
      status: "rejected",
      message: `A display name is at most ${MAX_PROJECT_NAME_LENGTH} characters.`,
    };
  }

  try {
    const updated = await withTenant(orgId, async (client) => {
      const result = await client.query(
        "update projects set name = $1 where org_id = $2 and slug = $3",
        [trimmed, orgId, slug],
      );
      return result.rowCount ?? 0;
    });
    if (updated === 0) return { status: "unknown-slug" };
    return { status: "renamed", name: trimmed };
  } catch (error) {
    return { status: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}
