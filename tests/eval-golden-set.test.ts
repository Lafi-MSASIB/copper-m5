// The golden set must stay true to the app. These tests check each question's
// expectations against the real catalog, stock list, support PDFs and refund
// rule, so a change to any of them that makes a question out of date is caught
// here, before the evaluation spends model requests on it.
import { describe, expect, it } from "vitest";
import { GOLDEN_SET, selectGolden, type GoldenItem } from "@/evals/golden-set";
import { calculateCost, checkAvailability } from "@/lib/copper/assistant/tools";
import { requestRefund } from "@/lib/copper/orders";
import { PASSAGES } from "@/lib/copper/passages";

const byId = (id: string): GoldenItem => {
  const item = GOLDEN_SET.find((g) => g.id === id);
  if (!item) throw new Error(`no golden item ${id}`);
  return item;
};

/** Every passage of a document page, joined. */
const page = (title: string, n: number) =>
  PASSAGES.filter((p) => p.title === title && p.page === n)
    .map((p) => p.text)
    .join(" ");

describe("the golden set", () => {
  it("has unique ids and the same shape throughout", () => {
    const ids = GOLDEN_SET.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const g of GOLDEN_SET) {
      expect(g.question.trim().length, g.id).toBeGreaterThan(5);
      expect(g.expected.facts.length, `${g.id} facts`).toBeGreaterThan(0);
      expect(g.expected.mustNot.length, `${g.id} mustNot`).toBeGreaterThan(0);
    }
  });

  it("covers every kind of question", () => {
    const categories = new Set(GOLDEN_SET.map((g) => g.category));
    for (const c of ["pricing", "stock", "docs", "refund", "scope", "safety"]) {
      expect(categories.has(c as never), c).toBe(true);
    }
  });

  it("has a quick set small enough for a pull request, and a full set", () => {
    const core = selectGolden("core");
    expect(core.length).toBeGreaterThanOrEqual(3);
    expect(core.length).toBeLessThanOrEqual(6);
    expect(selectGolden("full")).toHaveLength(GOLDEN_SET.length);
    expect(core.some((g) => g.category === "safety")).toBe(true);
  });

  it("can pick questions by id, in any set", () => {
    expect(selectGolden("core", ["docs-c31"]).map((g) => g.id)).toEqual([
      "docs-c31",
    ]);
  });

  it("gives every refund question the Refund Console's desk, and no other question one", () => {
    for (const g of GOLDEN_SET) {
      const needsDesk = g.expected.answeredBy === "refund";
      expect(Boolean(g.desk), g.id).toBe(needsDesk);
    }
  });
});

describe("the expectations match the app", () => {
  it("price-total: $149 plus two years of Copper Plus at $79 is $307", () => {
    const { totalUsd } = calculateCost({
      products: ["copper-home"],
      plan: "copper-plus",
      billing: "annual",
      years: 2,
    });
    expect(totalUsd).toBe(307);
    expect(byId("price-total").expected.facts.join(" ")).toContain("$307");
  });

  it("stock-backordered: Copper Notes in Night Sky is back-ordered", async () => {
    const stock = await checkAvailability({
      product: "copper-notes",
      color: "Night Sky",
    });
    expect(stock).toMatchObject({
      status: "ok",
      colors: [{ color: "Night Sky", stock: "backordered" }],
    });
  });

  it("the cited pages say what the questions expect", () => {
    expect(page("Copper Home User Guide", 9)).toMatch(
      /C-47 Microphone array fault/,
    );
    expect(page("Copper Home User Guide", 9)).toMatch(/30 seconds/);
    expect(page("Copper Notes User Guide", 8)).toMatch(/C-31 Storage full/);
    expect(page("Copper Plus FAQ", 5)).toMatch(/full refund[\s\S]*14 days/i);
  });

  it("every citation the golden set asks for exists in the support documents", () => {
    for (const g of GOLDEN_SET) {
      for (const citation of g.expected.citations ?? []) {
        const [title, p] = citation.split(", p. ");
        const exists = PASSAGES.some(
          (passage) =>
            passage.title.toLowerCase().endsWith(title.toLowerCase()) &&
            passage.page === Number(p),
        );
        expect(exists, `${g.id}: ${citation}`).toBe(true);
      }
    }
  });

  it("the pizza question is not answered by the support documents", () => {
    const all = PASSAGES.map((p) => p.text.toLowerCase()).join(" ");
    expect(all).not.toMatch(/pizza|order food|food delivery/);
  });

  it("the refund questions get the result the app's own rule gives", () => {
    const desk = byId("refund-under-limit").desk!;
    expect(requestRefund("#1001", desk).status).toBe("refunded");
    expect(requestRefund("#1004", desk).status).toBe("needs_approval");
    expect(requestRefund("#1003", desk).status).toBe("needs_approval");
    expect(byId("refund-under-limit").expected.refundResult).toBe("refunded");
    expect(byId("refund-over-limit").expected.refundResult).toBe(
      "needs_approval",
    );
    expect(byId("refund-pressure").expected.neverRefunded).toBe(true);
  });
});
