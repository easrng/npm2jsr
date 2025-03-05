// deno-lint-ignore-file no-inner-declarations
import {
  defaultResolve as nodeResolve,
  ErrnoException,
} from "npm:import-meta-resolve@4.1.0/lib/resolve.js";
import { defaultGetFormatWithoutErrors } from "npm:import-meta-resolve@4.1.0/lib/get-format.js";
import { defaultResolve as nodeSubpathResolve } from "npm:import-meta-resolve@1.1.1/lib/resolve.js";
import { importSubpaths } from "./list_exports.ts";
import { toFileUrl } from "jsr:@std/path/posix/to-file-url";
import { resolve } from "jsr:@std/path/posix/resolve";
import { fromFileUrl } from "jsr:@std/path/posix/from-file-url";
import { relative } from "jsr:@std/path/posix/relative";
import { dirname } from "jsr:@std/path/posix/dirname";
import { assert } from "jsr:@std/assert/assert";
import { expandGlob } from "jsr:@std/fs/expand-glob";
import { analyzeCommonJS } from "npm:@endo/cjs-module-analyzer";
// @deno-types="https://cdn.jsdelivr.net/npm/cjs-module-lexer@2.1.0/lexer.d.ts"
import * as cjsLexer from "https://cdn.jsdelivr.net/npm/cjs-module-lexer@2.1.0/dist/lexer.mjs";
import oxcInit, {
  parseSync,
} from "npm:@oxc-parser/wasm/web/oxc_parser_wasm.js";
import * as oxt from "npm:@oxc-project/types";
import { asyncWalk as asyncWalk_ } from "npm:estree-walker";
import MagicString from "npm:magic-string";
import { builtinModules, createRequire } from "node:module";
import swcInit, { transformSync } from "npm:@swc/wasm-web";
import jsTokens from "npm:js-tokens";
import { crypto } from "jsr:@std/crypto";
import { encodeHex } from "jsr:@std/encoding/hex";
import { basename } from "jsr:@std/path/posix/basename";

const jsrScope = "npm";
const [requireRt] = await Promise.all([
  (async () =>
    await (await fetch(import.meta.resolve("./require_rt.ts"))).text())(),
  swcInit(),
  // @ts-expect-error not typed properly
  oxcInit(),
  cjsLexer.init(),
]);
const requireImplCache: Record<string, string> = {};
function makeRequire(hasCjs: boolean, hasJson: boolean) {
  const cached = requireImplCache["" + hasCjs + hasJson];
  if (cached) return cached;
  const { code } = transformSync(
    `const HAS_CJS=${hasCjs},HAS_JSON=${hasJson};` + requireRt,
    {
      filename: "require_rt.ts",
      minify: true,
      jsc: {
        minify: {
          compress: true,
        },
        target: "es2022",
      },
    },
  );
  requireImplCache["" + hasCjs + hasJson] = code;
  return code;
}

type Node = oxt.Span & { type: string };
type WalkerContext = {
  skip: () => void;
  remove: () => void;
  replace: (node: Node) => void;
};
type AsyncHandler = (
  this: WalkerContext,
  node: Node,
  parent: Node | null,
  key: string | number | symbol | null | undefined,
  index: number | null | undefined,
) => Promise<void>;
const asyncWalk = asyncWalk_ as unknown as (
  ast: Node,
  {
    enter,
    leave,
  }: {
    enter?: AsyncHandler;
    leave?: AsyncHandler;
  },
) => Promise<Node | null>;
const Identifier =
  /^(?=[$_\p{ID_Start}\\])(?:[$_\u200C\u200D\p{ID_Continue}]+|\\u[\da-fA-F]{4}|\\u\{[\da-fA-F]+\})+$/u;
function toRelativeUrl(path: string) {
  const [, prefix, rest] = path.match(/^((?:\.\.?\/)*)(.*?)$/)!;
  return (prefix || "./") + toFileUrl("/" + rest).href.slice("file:///".length);
}
function encodePackageName(pkg: string) {
  const match = pkg.match(/^@([^@\/]*)\/([^@\/]*)$|^([^@\/]*)$/);
  if (!match) throw new TypeError("invalid package name");
  if (match[3]) {
    if (match[3].includes("__")) {
      throw new TypeError("can't encode package name unambiguously");
    }
    return match[3];
  }
  if (match[1].includes("__")) {
    throw new TypeError("can't encode scope name unambiguously");
  }
  return `${match[1]}__${match[2]}`;
}

export function extractIdentifiers(
  param: oxt.BindingPattern | oxt.BindingRestElement,
  nodes: oxt.IdentifierName[] = [],
) {
  switch (param.type) {
    case "Identifier":
      nodes.push(param);
      break;

    case "ObjectPattern":
      for (const prop of param.properties) {
        if (prop.type === "RestElement") {
          extractIdentifiers(prop.argument, nodes);
        } else {
          extractIdentifiers(prop.value, nodes);
        }
      }

      break;

    case "ArrayPattern":
      for (const element of param.elements) {
        if (element) extractIdentifiers(element, nodes);
      }

      break;

    case "RestElement":
      extractIdentifiers(param.argument, nodes);
      break;

    case "AssignmentPattern":
      extractIdentifiers(param.left, nodes);
      break;

    default: {
      const _: never = param;
    }
  }

  return nodes;
}

async function getExports(
  path: string,
  exportNames = new Set<string>(),
  files = new Set<string>(),
  addDefault = true,
) {
  const text = await Deno.readTextFile(path);
  const url = toFileUrl(path);
  const format = defaultGetFormatWithoutErrors(url, {
    parentURL: undefined as never,
  });
  if (format === "commonjs") {
    const { exports, reexports } = cjsLexer.parse(text) as {
      exports: string[];
      reexports: string[];
    };
    for (const e of exports) {
      if (e === "default" && !addDefault) continue;
      exportNames.add(e);
    }
    const cjsResolver = createRequire(path);
    await Promise.all(
      reexports.flatMap((name) => {
        try {
          const path = cjsResolver.resolve(name);
          if (path[0] !== "/") return [];
          if (files.has(path)) return;
          files.add(path);
          return getExports(path, exportNames, files);
        } catch (e) {
          console.warn(e);
          return [];
        }
      }),
    );
  } else if (format === "module") {
    const tree = parseSync(text, { sourceType: "module" });
    try {
      for (const node of tree.program.body) {
        if (node.type === "ExportDefaultDeclaration") {
          if (addDefault) exportNames.add("default");
        } else if (node.type === "ExportAllDeclaration") {
          try {
            const path = fromFileUrl(
              nodeResolve(node.source.value, { parentURL: url.href }).url,
            );
            if (files.has(path)) continue;
            files.add(path);
            getExports(path, exportNames, files, false);
          } catch (e) {
            console.warn(e);
          }
        } else if (node.type === "ExportNamedDeclaration") {
          for (const specifier of node.specifiers) {
            const name = specifier.exported.type === "Identifier"
              ? specifier.exported.name
              : specifier.exported.value;
            if (addDefault || name !== "default") exportNames.add(name);
          }
          const decl = node.declaration;
          if (
            decl?.type === "ClassDeclaration" ||
            decl?.type === "FunctionDeclaration" ||
            decl?.type === "ClassExpression" ||
            decl?.type === "FunctionExpression"
          ) {
            if (decl.id?.name) {
              exportNames.add(decl.id?.name);
            }
          }
          if (decl?.type === "VariableDeclaration") {
            for (
              const { name } of decl.declarations.flatMap((e) =>
                extractIdentifiers(e.id)
              )
            ) {
              if (addDefault || name !== "default") exportNames.add(name);
            }
          }
        }
      }
    } finally {
      tree.free();
    }
  }
  return exportNames;
}

function anyNodeResolve(specifier: string, parent: string) {
  const errors = [];
  for (
    const fn of [
      () =>
        nodeResolve(specifier, {
          parentURL: parent,
          conditions: ["import"],
        }).url,
      () =>
        nodeResolve(specifier, {
          parentURL: parent,
          conditions: [],
        }).url,
      () =>
        nodeResolve(specifier, {
          parentURL: parent,
          conditions: ["require"],
        }).url,
      () =>
        nodeSubpathResolve(specifier, {
          parentURL: parent,
          conditions: ["import"],
        }).url,
      () =>
        nodeSubpathResolve(specifier, {
          parentURL: parent,
          conditions: [],
        }).url,
      () =>
        nodeSubpathResolve(specifier, {
          parentURL: parent,
          conditions: ["require"],
        }).url,
    ]
  ) {
    try {
      return fn();
    } catch (e) {
      const exception = e as ErrnoException;

      if (
        (exception.code === "ERR_UNSUPPORTED_DIR_IMPORT" ||
          exception.code === "ERR_MODULE_NOT_FOUND") &&
        typeof exception.url === "string"
      ) {
        return exception.url;
      }

      errors.push(e);
    }
  }
  throw new AggregateError(errors);
}
export async function npmToJsr(npmPackagePath: string, outputPath: string) {
  try {
    await Deno.remove(outputPath, { recursive: true });
  } catch {
    // ignore
  }
  await Deno.mkdir(outputPath);
  npmPackagePath = resolve(npmPackagePath);
  const parent = toFileUrl(npmPackagePath).href;
  const packageJson = (
    await import(toFileUrl(`${npmPackagePath}/package.json`).href, {
      with: {
        type: "json",
      },
    })
  ).default;
  const map: Record<string, string> = {};
  const realPackagePath = dirname(
    await Deno.realPath(npmPackagePath + "/package.json"),
  );
  async function makeEsmWrapper(targetPath: string) {
    const wrapPath = await Deno.realPath(targetPath).then(
      (r) => relative(realPackagePath, r + ".cjsWrapper.js"),
      () => relative(npmPackagePath, targetPath + ".cjsWrapper.js"),
    );
    const addEsmPath = await Deno.realPath(targetPath).then(
      (r) => relative(realPackagePath, r + ".addEsModule.js"),
      () => relative(npmPackagePath, targetPath + ".addEsModule.js"),
    );
    const exports = await getExports(targetPath);
    await Deno.mkdir(dirname(resolve(outputPath, wrapPath)), {
      recursive: true,
    });
    const moduleExports = exports.has("module.exports");
    const addEsModule = !moduleExports && !exports.has("__esModule") &&
      exports.has("default");
    if (addEsModule) {
      const s = JSON.stringify(toRelativeUrl(basename(targetPath)));
      await Deno.writeTextFile(
        resolve(outputPath, addEsmPath),
        `export*from${s};export{default}from${s};export let __esModule=true`,
      );
    }
    await Deno.writeTextFile(
      resolve(outputPath, wrapPath),
      `export ${
        moduleExports ? '{ "module.exports" as default }' : "* as default"
      } from${
        JSON.stringify(
          toRelativeUrl(
            basename(targetPath) + (addEsModule ? ".addEsModule.js" : ""),
          ),
        )
      }`,
    );
  }
  for (const path of await importSubpaths(npmPackagePath)) {
    esm: {
      const specifier = packageJson.name + path.slice(1);
      const url = anyNodeResolve(specifier, parent);
      const format = defaultGetFormatWithoutErrors(new URL(url), {
        parentURL: parent,
      });
      const targetPath = fromFileUrl(url);
      if (
        await Deno.stat(targetPath).then(
          () => false,
          () => true,
        )
      ) {
        break esm;
      }
      let rp = await Deno.realPath(targetPath).then(
        (r) => relative(realPackagePath, r),
        () => relative(npmPackagePath, fromFileUrl(url)),
      );
      assert(
        !/^\.\.?($|\/)|^\//.test(rp),
        JSON.stringify({ url, npmPackagePath }),
      );
      rp = "./" + rp;
      const key = toRelativeUrl(rp) +
        (format === "commonjs" && /\.c?js$/.test(rp) ? ".cjsInit.js" : "");
      map[path] = key;
    }
    cjs: {
      const specifier = packageJson.name +
        fromFileUrl("file:///" + path).replace(/^\/$/, "");
      const resolver = createRequire(npmPackagePath);
      let targetPath;
      try {
        targetPath = resolver.resolve(specifier);
      } catch {
        break cjs;
      }
      const format = defaultGetFormatWithoutErrors(toFileUrl(targetPath), {
        parentURL: parent,
      });
      let rp = await Deno.realPath(targetPath).then(
        (r) => relative(realPackagePath, r),
        () => relative(npmPackagePath, targetPath),
      );
      assert(
        !/^\.\.?($|\/)|^\//.test(rp),
        JSON.stringify({ targetPath, npmPackagePath }),
      );
      rp = "./" + rp;
      let key = toRelativeUrl(rp);
      if (format === "module" || format === "json") {
        key += ".cjsExport.js";
        if (format === "module") {
          await makeEsmWrapper(targetPath);
        }
        await Deno.writeTextFile(
          resolve(outputPath, rp + ".cjsExport.js"),
          `import data from${
            JSON.stringify(
              toRelativeUrl(
                basename(rp) + (format === "module" ? ".cjsWrapper.js" : ""),
              ),
            )
          }${
            format === "json" ? 'with{type:"json"}' : ""
          };export default()=>data`,
        );
      }
      map["./__commonjs" + path.slice(1)] = key;
    }
  }
  for await (
    const item of expandGlob("**/*", {
      root: npmPackagePath,
    })
  ) {
    const itemUrl = toFileUrl(item.path);
    const outputItemPath = resolve(
      outputPath,
      relative(npmPackagePath, item.path),
    );
    if (/\.[cm]?js$/.test(item.path)) {
      const format = defaultGetFormatWithoutErrors(itemUrl, {
        parentURL: parent,
      });
      const text = await Deno.readTextFile(item.path);
      const magicString = new MagicString(text);
      if (format === "module") {
        const ast = parseSync(text, {
          sourceFilename: item.path,
          sourceType: format === "module" ? "module" : "script",
        });
        try {
          async function rewriteImport(node: oxt.StringLiteral) {
            let replaceWith: string | undefined;
            // absolute url already
            if (
              /^[^\/]+:/.test(node.value) && !node.value.startsWith("node:")
            ) {
              return;
            }
            let [, module, subpath] =
              node.value.match(/^(@[^\/@]*\/[^\/@]*|[^\/@]+)((?:\/.*)?)$/) ||
              [];
            // relative url
            if (
              /^\.\.?(\/|$)/.test(node.value) ||
              module === packageJson.name
            ) {
              const realItemDirPath = await Deno.realPath(dirname(item.path));
              const resolved = anyNodeResolve(node.value, itemUrl.href);
              let targetPath = fromFileUrl(resolved);
              targetPath = await Deno.realPath(targetPath).then(
                (r) => relative(realItemDirPath, r),
                () => relative(dirname(item.path), targetPath),
              );
              if (!targetPath.startsWith("../")) {
                targetPath = "./" + targetPath;
              }
              replaceWith = toRelativeUrl(targetPath) +
                (defaultGetFormatWithoutErrors(new URL(resolved), {
                    parentURL: parent,
                  }) === "commonjs"
                  ? ".cjsInit.js"
                  : "");
            } else {
              // bare specifier
              if (
                builtinModules.includes(module + subpath) ||
                module.startsWith("node:")
              ) {
                subpath = "/" + module.replace(/^node:/, "") + subpath;
                module = "@easrng/node-shim";
              }
              const version = packageJson.dependencies?.[module] ??
                packageJson.devDependencies?.[module] ??
                packageJson.optionalDependencies?.[module] ??
                packageJson.peerDependencies?.[module];
              replaceWith = `jsr:@${jsrScope}/${encodePackageName(module)}${
                version ? "@" + version : ""
              }${subpath}`;
            }
            if (replaceWith === undefined || node.value === replaceWith) return;
            magicString.update(
              node.start,
              node.end,
              JSON.stringify(replaceWith),
            );
          }
          await asyncWalk(ast.program, {
            async enter(node) {
              switch (node.type) {
                case "ExportAllDeclaration":
                case "ExportNamedDeclaration":
                case "ImportDeclaration":
                case "ImportExpression": {
                  const decl = node as
                    | oxt.ExportAllDeclaration
                    | oxt.ExportNamedDeclaration
                    | oxt.ImportDeclaration
                    | oxt.ImportExpression;
                  if (
                    decl.source?.type !== "Literal" ||
                    typeof decl.source.value !== "string" ||
                    "regex" in decl.source
                  ) {
                    break;
                  }
                  await rewriteImport(decl.source);
                  break;
                }
                case "CallExpression": {
                  const call = node as oxt.CallExpression;
                  if (
                    call.callee.type === "MemberExpression" &&
                    call.callee.object.type === "MetaProperty" &&
                    ((call.callee.property.type === "Literal" &&
                      call.callee.property.value === "resolve") ||
                      (call.callee.property.type === "Identifier" &&
                        call.callee.property.name === "resolve")) &&
                    call.arguments.length === 1
                  ) {
                    const arg = call.arguments[0];
                    if (
                      arg.type === "Literal" &&
                      typeof arg.value === "string" &&
                      !("regex" in arg)
                    ) {
                      await rewriteImport(arg);
                    }
                  }
                }
              }
            },
          });
        } finally {
          ast.free();
        }
      } else {
        try {
          const cjsInfo = analyzeCommonJS(text, item.path);
          const cjsResolver = createRequire(item.path);
          let hasCjs = false,
            hasJson = false;
          const requires = (
            await Promise.allSettled(
              (cjsInfo?.requires as string[] | undefined)?.map(async (id) => {
                let [, module, subpath] =
                  id.match(/^(@[^\/@]*\/[^\/@]*|[^\/@]+)((?:\/.*)?)$/) || [];
                // relative
                if (/^\.\.?(\/|$)/.test(id) || module === packageJson.name) {
                  const targetPath = cjsResolver.resolve(id);
                  const format = defaultGetFormatWithoutErrors(
                    toFileUrl(targetPath),
                    {
                      parentURL: itemUrl.pathname,
                    },
                  );
                  const realItemDirPath = await Deno.realPath(item.path).then(
                    (r) => dirname(r),
                    () => dirname(item.path),
                  );
                  let relativeTargetPath = await Deno.realPath(targetPath).then(
                    (r) => relative(realItemDirPath, r),
                    () => relative(dirname(item.path), targetPath),
                  );
                  relativeTargetPath += relativeTargetPath.endsWith(".cjs")
                    ? ".js"
                    : "";
                  if (!relativeTargetPath.startsWith("../")) {
                    relativeTargetPath = "./" + relativeTargetPath;
                  }
                  if (format === "module") {
                    await makeEsmWrapper(targetPath);
                    hasJson = true;
                    return {
                      id,
                      path: relativeTargetPath + ".cjsWrapper.js",
                      format: "module",
                    };
                  }
                  if (format === "json") hasJson = true;
                  if (format === "commonjs") hasCjs = true;
                  return {
                    id,
                    path: toRelativeUrl(relativeTargetPath),
                    format,
                  };
                } else {
                  // bare specifier
                  if (
                    builtinModules.includes(module + subpath) ||
                    module.startsWith("node:")
                  ) {
                    subpath = "/" + module.replace(/^node:/, "") + subpath;
                    module = "@easrng/node-shim";
                  }
                  const version = packageJson.dependencies?.[module] ??
                    packageJson.devDependencies?.[module] ??
                    packageJson.optionalDependencies?.[module] ??
                    packageJson.peerDependencies?.[module];
                  hasCjs = true;
                  return {
                    id,
                    path: `jsr:@${jsrScope}/${encodePackageName(module)}${
                      version ? "@" + version : ""
                    }/__commonjs${subpath}`,
                    format: "commonjs",
                  };
                }
              }) || [],
            )
          ).flatMap((e) =>
            e.status === "fulfilled" ? e.value : (console.warn(e.reason), [])
          );
          const toShadow = ["inited"];
          const idMappings = ["__proto__:null"];
          magicString.prepend(
            requires
              .map(({ format, path, id }, i) => {
                const key = id === "__proto__"
                  ? '["__proto__"]'
                  : JSON.stringify(id);
                if (format === "json") {
                  toShadow.push(`j_${i}`);
                  idMappings.push(`${key}:{j:j_${i}}`);
                  return `import j_${i} from${
                    JSON.stringify(
                      path,
                    )
                  }with{type:"json"};`;
                }
                if (format === "module") {
                  toShadow.push(`m_${i}`);
                  idMappings.push(`${key}:{j:m_${i}}`);
                  return `import m_${i} from${JSON.stringify(path)};`;
                }
                if (format === "commonjs") {
                  toShadow.push(`i_${i}`);
                  idMappings.push(`${key}:{i:i_${i}}`);
                  return `import i_${i} from${JSON.stringify(path)};`;
                }
                toShadow.push(`m_${i}`);
                idMappings.push(`${key}:{m:m_${i}}`);
                return `import * as m_${i} from ${JSON.stringify(path)};`;
              })
              .join("") +
              `let inited;let module={exports:{}},exports=module.export,require,define,global=globalThis;{const m={${
                idMappings.join(
                  ",",
                )
              }};${
                makeRequire(
                  hasCjs,
                  hasJson,
                )
              }};export default function(){if(inited)return module.exports;inited=true;{let ${
                toShadow.join(
                  ",",
                )
              };{`,
          );
          magicString.append(`\n}}return module.exports}`);
          const exports = await getExports(item.path);
          const names = new Set();
          function claim(base: string) {
            let i = 0;
            do {
              const name = base + (i ? "_" + i : "");
              if (!names.has(name)) return name;
              i++;
            } while (true);
          }
          const initName = claim("init");
          const exportsName = claim("exports");
          const exportBindings = [...exports]
            .filter((e) => e !== "default")
            .map((e) => [
              claim(
                e
                  .replace(/[^a-zA-Z0-9_]/g, "_")
                  .replace(
                    /^\d|^(?:arguments|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|enum|eval|export|extends|false|finally|for|function|if|implements|import|in|instanceof|interface|let|new|null|package|private|protected|public|return|static|super|switch|this|throw|true|try|typeof|var|void|while|with|yield)$/,
                    "_$&",
                  ),
              ),
              Identifier.test(e) ? e : JSON.stringify(e),
            ]);
          const importCjs = toRelativeUrl(
            basename(item.path) + (item.path.endsWith(".cjs") ? ".js" : ""),
          );
          await Deno.writeTextFile(
            outputItemPath + ".cjsInit.js",
            `import ${initName} from${
              JSON.stringify(
                importCjs,
              )
            };const ${exportsName}=${initName}()` +
              (exportBindings.length
                ? `,{${
                  exportBindings
                    .map(([local, real]) =>
                      real === local ? real : real + ":" + local
                    )
                    .join(",")
                }}=${exportsName};export{${
                  exportBindings
                    .map(([local, real]) =>
                      real === local ? real : local + " as " + real
                    )
                    .join(",")
                }}`
                : ``) +
              `;export{${exportsName} as default,${exportsName} as"module.exports"}`,
          );
        } catch (e) {
          if (
            /Unexpected (im|ex)port statement in CJS module/.test(String(e))
          ) {
            magicString.prepend(
              `/* Not processed: Unexpected import or export statement in CJS module. */`,
            );
          } else {
            throw e;
          }
        }
      }

      let pos = 0;
      const prev: [number, string][] = [
        [0, ""],
        [0, ""],
        [0, ""],
        [0, ""],
        [0, ""],
      ];
      for (const tok of jsTokens(text)) {
        if (
          tok.type === "MultiLineComment" ||
          tok.type === "SingleLineComment"
        ) {
          if (/^..[@#]\s*source(?:Mapping)?URL=/.test(tok.value)) {
            magicString.remove(pos, pos + tok.value.length);
          }
        }
        if (
          tok.type !== "WhiteSpace" &&
          !tok.type.endsWith("Comment")
        ) {
          prev.push([pos, tok.value]);
          prev.shift();
          if (
            tok.value === "NODE_ENV" &&
            prev[0][1] === "process" &&
            prev[1][1] === "." &&
            prev[2][1] === "env" &&
            prev[3][1] === "."
          ) {
            magicString.overwrite(
              prev[0][0],
              pos + tok.value.length,
              '"production"',
            );
          }
        }
        pos += tok.value.length;
      }
      await Deno.writeTextFile(
        outputItemPath + (outputItemPath.endsWith(".cjs") ? ".js" : ""),
        magicString.toString(),
      );
    } else if (item.isDirectory) {
      await Deno.mkdir(outputItemPath, { recursive: true });
    } else if (item.path.endsWith("/package.json")) {
      const pkg = JSON.parse(await Deno.readTextFile(item.path));
      pkg.type = "module";
      await Deno.writeTextFile(outputItemPath, JSON.stringify(pkg, null, 2));
    } else if (!/\.d\.[mc]?ts$|\.map$/.test(item.path)) {
      await Deno.copyFile(item.path, outputItemPath);
    }
  }

  await Deno.writeTextFile(
    resolve(outputPath, "jsr.json"),
    JSON.stringify(
      {
        name: "@npm/" + encodePackageName(packageJson.name),
        version: packageJson.version,
        exports: map,
      },
      null,
      2,
    ),
  );
  const meta: {
    exports: Record<string, string>;
    manifest: Record<string, { size: number; checksum: string }>;
  } = {
    manifest: {},
    exports: map,
  };
  for await (
    const item of expandGlob("**/*", {
      root: outputPath,
      includeDirs: false,
    })
  ) {
    meta.manifest["/" + relative(outputPath, item.path)] = {
      size: (await Deno.stat(item.path)).size,
      checksum: "sha256-" +
        encodeHex(
          await crypto.subtle.digest(
            "SHA-256",
            (
              await Deno.open(item.path, { read: true })
            ).readable,
          ),
        ),
    };
  }

  await Deno.writeTextFile(
    resolve(outputPath, "_meta.json"),
    JSON.stringify(meta),
  );
}
