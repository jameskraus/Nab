import type { Account, CategoryGroupWithCategories, Payee } from "ynab";

export type NameCandidate = {
  id: string;
  name: string;
};

export type CategoryCandidate = NameCandidate & {
  group: string;
};

export class NameNotFoundError extends Error {
  public readonly query: string;

  constructor(query: string) {
    super(`No match found for "${query}".`);
    this.name = "NameNotFoundError";
    this.query = query;
  }
}

export class NameAmbiguousError<T extends NameCandidate> extends Error {
  public readonly query: string;
  public readonly candidates: T[];

  constructor(query: string, candidates: T[]) {
    const names = candidates.map((candidate) => candidate.name).join(", ");
    super(`Ambiguous match for "${query}". Candidates: ${names}`);
    this.name = "NameAmbiguousError";
    this.query = query;
    this.candidates = candidates;
  }
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

export function resolveByName<T extends NameCandidate>(items: T[], name: string): T {
  const normalized = normalizeName(name);
  if (!normalized) {
    throw new Error("Provide a non-empty name.");
  }

  const matches = items.filter((item) => normalizeName(item.name) === normalized);
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new NameNotFoundError(name);
  throw new NameAmbiguousError(name, matches);
}

export function flattenCategories(groups: CategoryGroupWithCategories[]): CategoryCandidate[] {
  const candidates: CategoryCandidate[] = [];
  for (const group of groups) {
    for (const category of group.categories) {
      candidates.push({
        id: category.id,
        name: category.name,
        group: category.category_group_name ?? group.name,
      });
    }
  }
  return candidates;
}

export function resolveCategory(name: string, groups: CategoryGroupWithCategories[]): string {
  return resolveByName(flattenCategories(groups), name).id;
}

export function resolveAccount(name: string, accounts: Account[]): string {
  return resolveByName(accounts, name).id;
}

export function resolvePayee(name: string, payees: Payee[]): string {
  return resolveByName(payees, name).id;
}
