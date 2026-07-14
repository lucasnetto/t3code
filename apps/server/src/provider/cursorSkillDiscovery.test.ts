import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverCursorSkills } from "./cursorSkillDiscovery.ts";

const writeSkill = Effect.fn("writeCursorSkillFixture")(function* (
  skillPath: string,
  frontmatter: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(skillPath), { recursive: true });
  yield* fs.writeFileString(skillPath, `---\n${frontmatter}\n---\n\n# Skill\n`);
});

const makeDiscoveryFixture = Effect.fn("makeCursorSkillDiscoveryFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({
    directory: NodeOS.tmpdir(),
    prefix: "cursor-skill-discovery-",
  });
  return {
    root,
    homeDirectory: path.join(root, "home"),
    cwd: path.join(root, "project"),
  };
});

it.layer(NodeServices.layer)("discoverCursorSkills", (it) => {
  it.effect(
    "discovers shared and native user skills while keeping manual-only skills enabled",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fixture = yield* makeDiscoveryFixture();
        yield* writeSkill(
          path.join(fixture.homeDirectory, ".agents", "skills", "shared", "SKILL.md"),
          [
            "name: shared",
            "description: |",
            "  Shared multi-line",
            "  description.",
            "disable-model-invocation: true",
            "display-name: Shared Skill",
            "short-description: Run the shared workflow",
          ].join("\n"),
        );
        yield* writeSkill(
          path.join(fixture.homeDirectory, ".cursor", "skills", "native", "SKILL.md"),
          "name: native\ndescription: Native Cursor skill",
        );

        const discovered = yield* discoverCursorSkills(fixture);
        expect(discovered).toEqual([
          expect.objectContaining({
            name: "native",
            description: "Native Cursor skill",
            scope: "user",
            enabled: true,
          }),
          expect.objectContaining({
            name: "shared",
            description: "Shared multi-line\ndescription.",
            displayName: "Shared Skill",
            shortDescription: "Run the shared workflow",
            scope: "user",
            enabled: true,
          }),
        ]);
      }),
  );

  it.effect("uses deterministic native-over-shared and project-over-user precedence", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fixture = yield* makeDiscoveryFixture();
      const variants = [
        [fixture.homeDirectory, ".agents", "user shared"],
        [fixture.homeDirectory, ".cursor", "user native"],
        [fixture.cwd, ".agents", "project shared"],
        [fixture.cwd, ".cursor", "project native"],
      ] as const;
      for (const [base, source, description] of variants) {
        yield* writeSkill(
          path.join(base, source, "skills", "duplicate", "SKILL.md"),
          `name: duplicate\ndescription: ${description}`,
        );
      }
      yield* writeSkill(
        path.join(fixture.cwd, ".agents", "skills", "alpha", "SKILL.md"),
        "name: alpha",
      );

      const discovered = yield* discoverCursorSkills(fixture);
      expect(discovered.map((skill) => skill.name)).toEqual(["alpha", "duplicate"]);
      expect(discovered[1]).toMatchObject({
        description: "project native",
        scope: "project",
      });
      expect(discovered[1]?.path).toContain("/.cursor/skills/duplicate/SKILL.md");
    }),
  );

  it.effect("skips invalid skills and follows directory symlinks without looping", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* makeDiscoveryFixture();
      const agentsRoot = path.join(fixture.homeDirectory, ".agents", "skills");
      const externalSkill = path.join(fixture.root, "external-skill");
      yield* writeSkill(
        path.join(externalSkill, "SKILL.md"),
        "name: linked\ndescription: Symlinked skill",
      );
      yield* fs.makeDirectory(path.join(agentsRoot, "invalid"), { recursive: true });
      yield* fs.writeFileString(
        path.join(agentsRoot, "invalid", "SKILL.md"),
        "---\nname: [invalid\n---\n",
      );
      yield* fs.makeDirectory(path.join(agentsRoot, "missing-frontmatter"), { recursive: true });
      yield* fs.writeFileString(
        path.join(agentsRoot, "missing-frontmatter", "SKILL.md"),
        "# Missing frontmatter\n",
      );
      yield* fs.symlink(externalSkill, path.join(agentsRoot, "linked"));
      yield* fs.makeDirectory(path.join(agentsRoot, "cycle"), { recursive: true });
      yield* fs.symlink(agentsRoot, path.join(agentsRoot, "cycle", "back"));

      const discovered = yield* discoverCursorSkills(fixture);
      expect(discovered).toEqual([
        expect.objectContaining({
          name: "linked",
          description: "Symlinked skill",
          enabled: true,
        }),
      ]);
    }),
  );
});
