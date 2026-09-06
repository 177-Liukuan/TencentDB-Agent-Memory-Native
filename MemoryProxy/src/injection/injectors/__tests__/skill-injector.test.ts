import { describe, expect, it } from "vitest";

import { wrapAvailableSkillsBlock } from "../skill-injector.js";

describe("Skill capability prompt", () => {
  it("directs the model to Native Skill tools without exposing a curl fallback", () => {
    const output = wrapAvailableSkillsBlock([
      "<available_skills>",
      "- deploy: Deploy the project",
      "</available_skills>",
    ].join("\n"), true);

    expect(output).toContain("skill_search");
    expect(output).toContain("skill_view");
    expect(output).toContain("skill_files_read");
    expect(output).toContain("even partially relevant");
    expect(output).toContain("you MUST load it by calling the `skill_view` tool");
    expect(output).toContain("even if you think you could handle the task");
    expect(output).toContain("Only proceed without loading a skill if genuinely none are relevant");
    expect(output).toContain("- deploy: Deploy the project");
    expect(output).toContain("优先使用它们完成任务");
    expect(output).not.toMatch(/skill_patch|skill_create/);
    expect(output).not.toContain("不要使用本地 `Read` 或 `Bash` 访问");
    expect(output).not.toMatch(/does not expose|没有提供给模型/i);
    expect(output).not.toMatch(/curl/i);
  });

  it("does not advertise Skill tools when Native Proxy Tools are disabled", () => {
    const output = wrapAvailableSkillsBlock([
      "<available_skills>",
      "- deploy: Deploy the project",
      "</available_skills>",
    ].join("\n"), false);

    expect(output).toContain("当前请求未提供云端 Skill 工具");
    expect(output).not.toContain("skill_search");
    expect(output).not.toContain("skill_view");
    expect(output).not.toContain("MUST load");
    expect(output).not.toMatch(/curl/i);
  });
});
