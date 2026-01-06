import { expect, test } from "bun:test";
import type { Account, CategoryGroupWithCategories, Payee } from "ynab";

import {
  NameAmbiguousError,
  NameNotFoundError,
  resolveAccount,
  resolveByName,
  resolveCategory,
  resolvePayee,
} from "@/domain/nameResolution";

test("resolveByName matches case-insensitively", () => {
  const items = [{ id: "1", name: "Rent" }];
  const match = resolveByName(items, "rent");
  expect(match.id).toBe("1");
});

test("resolveByName throws for ambiguous matches", () => {
  const items = [
    { id: "1", name: "Rent" },
    { id: "2", name: "rent" },
  ];
  expect(() => resolveByName(items, "Rent")).toThrow(NameAmbiguousError);
  try {
    resolveByName(items, "Rent");
  } catch (err) {
    const error = err as NameAmbiguousError<{ id: string; name: string }>;
    expect(error.candidates).toHaveLength(2);
  }
});

test("resolveByName throws for missing matches", () => {
  expect(() => resolveByName([{ id: "1", name: "Rent" }], "Food")).toThrow(NameNotFoundError);
});

test("resolveCategory includes group candidates when ambiguous", () => {
  const groups: CategoryGroupWithCategories[] = [
    {
      id: "g1",
      name: "Housing",
      hidden: false,
      deleted: false,
      categories: [
        {
          id: "c1",
          category_group_id: "g1",
          name: "Utilities",
          hidden: false,
          budgeted: 0,
          activity: 0,
          balance: 0,
          deleted: false,
        },
      ],
    },
    {
      id: "g2",
      name: "Home",
      hidden: false,
      deleted: false,
      categories: [
        {
          id: "c2",
          category_group_id: "g2",
          name: "Utilities",
          hidden: false,
          budgeted: 0,
          activity: 0,
          balance: 0,
          deleted: false,
        },
      ],
    },
  ];

  expect(() => resolveCategory("Utilities", groups)).toThrow(NameAmbiguousError);
  try {
    resolveCategory("Utilities", groups);
  } catch (err) {
    const error = err as NameAmbiguousError<{ id: string; name: string; group: string }>;
    expect(error.candidates.map((candidate) => candidate.group).sort()).toEqual([
      "Home",
      "Housing",
    ]);
  }
});

test("resolveAccount returns matching id", () => {
  const accounts: Account[] = [
    {
      id: "a1",
      name: "Checking",
      type: "checking",
      on_budget: true,
      closed: false,
      balance: 0,
      cleared_balance: 0,
      uncleared_balance: 0,
      transfer_payee_id: null,
      deleted: false,
    },
  ];

  expect(resolveAccount("checking", accounts)).toBe("a1");
});

test("resolvePayee throws for ambiguous matches", () => {
  const payees: Payee[] = [
    { id: "p1", name: "Coffee", transfer_account_id: null, deleted: false },
    { id: "p2", name: "coffee", transfer_account_id: null, deleted: false },
  ];
  expect(() => resolvePayee("Coffee", payees)).toThrow(NameAmbiguousError);
});
