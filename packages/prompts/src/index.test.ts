import { describe, expect, it } from "vitest";
import { buildRecipeFromHints } from "@styleme/core";
import { buildGenerationPrompt } from ".";

describe("buildGenerationPrompt", () => {
  it("keeps image inputs and recipe in the final prompt", () => {
    const recipe = buildRecipeFromHints("recipe_prompt", {}, { pageTitle: "ccd portrait" });
    const prompt = buildGenerationPrompt({
      jobId: "job_prompt",
      mode: "codex-dev",
      referenceImagePathOrUrls: ["reference.png"],
      subjectImagePathOrUrls: ["subject-01.png"],
      recipe,
      count: 4,
      maxRetries: 0
    });

    expect(prompt).toContain("reference.png");
    expect(prompt).toContain("subject-01.png");
    expect(prompt).toContain("recipe.json");
    expect(prompt).toContain("不要复制");
  });
});
