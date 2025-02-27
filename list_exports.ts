import { toFileUrl } from "jsr:@std/path/posix/to-file-url";
import { fromFileUrl } from "jsr:@std/path/posix/from-file-url";
import { relative } from "jsr:@std/path/posix/relative";
import { resolve } from "jsr:@std/path/posix/resolve";
import { expandGlob } from "jsr:@std/fs/expand-glob";
import { assert } from "jsr:@std/assert/assert";

type NotDot = string & { __not: "." };

type PackageExportsEntry = PackageExportsEntryPath | PackageExportsEntryObject;
type PackageExportsEntryPath = string | null;
interface PackageExportsEntryObject {
  [k: string]: PackageExportsEntry | PackageExportsFallback;
}
type PackageExportsFallback = PackageExportsEntry[];
type ExportsPathMap = {
  [k: `.${string}`]: PackageExportsEntry | PackageExportsFallback;
};
interface PackageJSON {
  exports?:
    | never // line up comments lol
    // same as { "./": "./" }
    | undefined
    | null
    // same as { ".": _ }
    | string
    | PackageExportsEntry[]
    | {
      [k: `${NotDot}${string}`]: PackageExportsEntry | PackageExportsFallback;
    }
    // map of paths
    | ExportsPathMap;
}

const normalizeURLPath = (str: string): `.${string}` =>
  `.${
    toFileUrl(fromFileUrl("file:///" + str))
      .href.slice("file://".length)
      .replace(/\/$/, "")
  }${str.endsWith("/") ? "/" : ""}`;
const parsePattern = (str: string) => {
  const match = str.match(/\*|\/$/g);
  if (match === null) return;
  assert(match.length === 1, "only one wildcard allowed");
  const index = str.lastIndexOf(match[0]);
  const prefix = str.slice(0, index + Number(match[0] === "/"));
  const suffix = str.slice(index + 1);
  return { prefix, suffix };
};

export async function importSubpaths(packagePath: string) {
  const packageJson = (
    await import(toFileUrl(`${resolve(packagePath)}/package.json`).href, {
      with: {
        type: "json",
      },
    })
  ).default as PackageJSON;
  let exports: ExportsPathMap | undefined;
  if (packageJson.exports != null) {
    if (
      typeof packageJson.exports === "object" &&
      !Array.isArray(packageJson.exports)
    ) {
      exports = {};
      for (const firstKey in packageJson.exports) {
        if (firstKey[0] === ".") {
          for (const key in packageJson.exports) {
            assert(key[0] === ".", "all keys should be subpaths");
          }
          Object.assign(exports, packageJson.exports);
        } else {
          for (const key in packageJson.exports) {
            assert(key[0] !== ".", "all keys should be conditions");
          }
          exports["."] = packageJson.exports;
        }
        break;
      }
    } else {
      exports = { ".": packageJson.exports };
    }
  }
  function allPaths(
    entry: PackageExportsEntry | PackageExportsFallback,
  ): string[] {
    if (entry == null) return [];
    if (typeof entry === "string") return [entry];
    if (Array.isArray(entry)) return entry.flatMap(allPaths);
    return Object.values(entry).flatMap(allPaths);
  }
  const patterns: {
    targetPattern: { prefix: string; suffix: string };
    specifierPattern: { prefix: string; suffix: string };
  }[] = [];
  const specifiers = new Set<string>();
  if (exports) {
    for (const specifier of Object.keys(exports).map(normalizeURLPath)) {
      const specifierPattern = parsePattern(specifier);
      if (specifierPattern == null) {
        specifiers.add(specifier);
      } else {
        for (
          const targetPath of allPaths(exports[specifier]).map(
            normalizeURLPath,
          )
        ) {
          const targetPattern = parsePattern(targetPath);
          assert(
            targetPattern,
            `target '${targetPath}' of specifier '${specifier}' is not a pattern`,
          );
          patterns.push({ targetPattern, specifierPattern });
        }
      }
    }
  } else {
    const cjsSuffixes = ["", ".js", ".json", "/index.js", "/index.json"];
    specifiers.add(".");
    for (const cjsSuffix of cjsSuffixes) {
      patterns.push({
        targetPattern: parsePattern("./*" + cjsSuffix)!,
        specifierPattern: parsePattern("./*")!,
      });
    }
  }
  if (patterns.length) {
    for await (const item of expandGlob("**/*", { root: packagePath })) {
      const child = "." +
        toFileUrl("/" + relative(packagePath, item.path)).href.slice(
          "file://".length,
        );
      outer: for (const e of patterns) {
        if (
          child.startsWith(e.targetPattern.prefix) &&
          child.endsWith(e.targetPattern.suffix)
        ) {
          let candidate = e.specifierPattern.prefix +
            child.slice(
              e.targetPattern.prefix.length,
              e.targetPattern.suffix
                ? 0 - e.targetPattern.suffix.length
                : Infinity,
            ) +
            e.specifierPattern.suffix;
          if (candidate === "./") candidate = ".";
          for (const p of patterns) {
            if (
              p !== e &&
              candidate.startsWith(p.specifierPattern.prefix) &&
              p.specifierPattern.prefix.length >
                e.specifierPattern.prefix.length
            ) {
              // skip if better subpath match found
              continue outer;
            }
          }
          specifiers.add(candidate);
        }
      }
    }
  }
  return specifiers;
}
