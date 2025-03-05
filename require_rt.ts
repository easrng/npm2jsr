declare const HAS_CJS: boolean;
declare const HAS_JSON: boolean;
declare const m: Record<
  string,
  { j: unknown; i: undefined } | { i(): void; j: undefined }
>;
// deno-lint-ignore prefer-const
declare let require: unknown;

const __defProp = Object.defineProperty;
const __hasOwn = Object.hasOwn;
const __Error = Error;
require = (id: string) => {
  const mod = m[id] || {};
  if (HAS_JSON && __hasOwn(mod, "j")) {
    return mod.j;
  }
  if (HAS_CJS && __hasOwn(mod, "i")) {
    return mod.i!();
  }
  throw __defProp(new __Error(`Cannot find module '${id}'`), "code", {
    value: "MODULE_NOT_FOUND",
    configurable: true,
    enumerable: true,
    writable: true,
  });
};
