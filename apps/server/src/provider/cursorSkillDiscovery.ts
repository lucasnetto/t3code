import * as NodeOS from "node:os";

import type { ServerProviderSkill } from "@t3tools/contracts";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

const SKILL_FILE_NAME = "SKILL.md";
const MAX_DISCOVERY_DEPTH = 4;

const CursorSkillFrontmatter = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  "display-name": Schema.optional(Schema.String),
  shortDescription: Schema.optional(Schema.String),
  "short-description": Schema.optional(Schema.String),
});

type CursorSkillFrontmatter = typeof CursorSkillFrontmatter.Type;

const decodeCursorSkillFrontmatter = Schema.decodeUnknownEffect(fromYaml(CursorSkillFrontmatter));

interface CursorSkillRoot {
  readonly directory: string;
  readonly scope: "project" | "user";
}

export interface DiscoverCursorSkillsInput {
  readonly cwd: string;
  readonly homeDirectory?: string;
}

export function resolveCursorSkillHomeDirectory(environment?: NodeJS.ProcessEnv): string {
  return environment?.HOME?.trim() || environment?.USERPROFILE?.trim() || NodeOS.homedir();
}

function extractYamlFrontmatter(contents: string): string | undefined {
  const normalized = contents.startsWith("\uFEFF") ? contents.slice(1) : contents;
  const match = /^---[\t ]*\r?\n([\s\S]*?)\r?\n---[\t ]*(?:\r?\n|$)/.exec(normalized);
  return match?.[1];
}

function trimmed(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function frontmatterDisplayName(frontmatter: CursorSkillFrontmatter): string | undefined {
  return trimmed(frontmatter.displayName) ?? trimmed(frontmatter["display-name"]);
}

function frontmatterShortDescription(frontmatter: CursorSkillFrontmatter): string | undefined {
  return trimmed(frontmatter.shortDescription) ?? trimmed(frontmatter["short-description"]);
}

const parseCursorSkill = Effect.fn("parseCursorSkill")(function* (
  skillPath: string,
  scope: CursorSkillRoot["scope"],
): Effect.fn.Return<ServerProviderSkill | undefined, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const contentsResult = yield* fs.readFileString(skillPath).pipe(Effect.result);
  if (Result.isFailure(contentsResult)) {
    yield* Effect.logWarning("Ignoring unreadable Cursor skill.", { skillPath });
    return undefined;
  }

  const yaml = extractYamlFrontmatter(contentsResult.success);
  if (yaml === undefined) {
    yield* Effect.logWarning("Ignoring Cursor skill without YAML frontmatter.", { skillPath });
    return undefined;
  }

  const frontmatterResult = yield* decodeCursorSkillFrontmatter(yaml).pipe(Effect.result);
  if (Result.isFailure(frontmatterResult)) {
    yield* Effect.logWarning("Ignoring Cursor skill with invalid YAML frontmatter.", { skillPath });
    return undefined;
  }

  const name = trimmed(frontmatterResult.success.name);
  if (!name) {
    yield* Effect.logWarning("Ignoring Cursor skill without a name.", { skillPath });
    return undefined;
  }

  const description = trimmed(frontmatterResult.success.description);
  const displayName = frontmatterDisplayName(frontmatterResult.success);
  const shortDescription = frontmatterShortDescription(frontmatterResult.success);

  return {
    name,
    path: path.resolve(skillPath),
    scope,
    enabled: true,
    ...(description ? { description } : {}),
    ...(displayName ? { displayName } : {}),
    ...(shortDescription ? { shortDescription } : {}),
  };
});

const scanCursorSkillRoot = Effect.fn("scanCursorSkillRoot")(function* (
  root: CursorSkillRoot,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const visitedDirectories = new Set<string>();

  const visitDirectory: (
    directory: string,
    depth: number,
  ) => Effect.Effect<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> =
    Effect.fn("visitCursorSkillDirectory")(function* (directory: string, depth: number) {
      if (depth > MAX_DISCOVERY_DEPTH) {
        return [];
      }

      const realDirectoryResult = yield* fs.realPath(directory).pipe(Effect.result);
      if (Result.isFailure(realDirectoryResult)) {
        return [];
      }
      if (visitedDirectories.has(realDirectoryResult.success)) {
        return [];
      }
      visitedDirectories.add(realDirectoryResult.success);

      const entriesResult = yield* fs.readDirectory(directory).pipe(Effect.result);
      if (Result.isFailure(entriesResult)) {
        yield* Effect.logWarning("Unable to scan a Cursor skill directory.", { directory });
        return [];
      }

      const entries = entriesResult.success.toSorted((left, right) => left.localeCompare(right));
      if (entries.includes(SKILL_FILE_NAME)) {
        const skill = yield* parseCursorSkill(path.join(directory, SKILL_FILE_NAME), root.scope);
        return skill ? [skill] : [];
      }

      const skills: Array<ServerProviderSkill> = [];
      for (const entry of entries) {
        const childPath = path.join(directory, entry);
        const childStatResult = yield* fs.stat(childPath).pipe(Effect.result);
        if (Result.isSuccess(childStatResult) && childStatResult.success.type === "Directory") {
          skills.push(...(yield* visitDirectory(childPath, depth + 1)));
        }
      }
      return skills;
    });

  return yield* visitDirectory(root.directory, 0);
});

/**
 * Discovers Cursor skills in increasing precedence order. Provider-native roots
 * override shared roots, and project roots override user roots.
 */
export const discoverCursorSkills = Effect.fn("discoverCursorSkills")(function* (
  input: DiscoverCursorSkillsInput,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const homeDirectory = input.homeDirectory ?? resolveCursorSkillHomeDirectory();
  const roots: ReadonlyArray<CursorSkillRoot> = [
    { directory: path.join(homeDirectory, ".agents", "skills"), scope: "user" },
    { directory: path.join(homeDirectory, ".cursor", "skills"), scope: "user" },
    { directory: path.join(input.cwd, ".agents", "skills"), scope: "project" },
    { directory: path.join(input.cwd, ".cursor", "skills"), scope: "project" },
  ];

  const skillsByName = new Map<string, ServerProviderSkill>();
  for (const root of roots) {
    const skills = yield* scanCursorSkillRoot(root);
    for (const skill of skills) {
      skillsByName.set(skill.name.toLowerCase(), skill);
    }
  }

  return Array.from(skillsByName.values()).toSorted((left, right) =>
    left.name.localeCompare(right.name),
  );
});
