import { describe, expect, it } from "vitest";
import { buildRecipeFromHints, validateStyleRecipe } from "./recipe.schema";

describe("buildRecipeFromHints", () => {
  it("returns a complete recipe for a known style hint", () => {
    const recipe = buildRecipeFromHints(
      "recipe_test",
      { width: 1200, height: 1500, mimeType: "image/png" },
      { pageTitle: "summer green outdoor tree shadow" }
    );

    expect(validateStyleRecipe(recipe)).toBe(true);
    expect(recipe.title).toContain("夏日");
    expect(recipe.generationParams.aspectRatio).toBe("4:5");
    expect(recipe.promptZh).toContain("人物图");
  });

  it("keeps a deterministic fallback for unknown pages", () => {
    const recipe = buildRecipeFromHints("recipe_generic", {}, {});

    expect(validateStyleRecipe(recipe)).toBe(true);
    expect(recipe.tags).toContain("网页参考");
    expect(recipe.scene).not.toContain("待填");
  });
});
