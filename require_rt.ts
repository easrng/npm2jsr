declare const HAS_CJS: boolean;
declare const HAS_ESM: boolean;
declare const HAS_JSON: boolean;
declare const m: Record<
  string,
  | { j: unknown; i: undefined; x: undefined; m: undefined }
  | { i(): void; x(): unknown; j: undefined; m: undefined }
  | {
    m: Record<PropertyKey, unknown>;
    j: undefined;
    i: undefined;
    x: undefined;
  }
>;
// deno-lint-ignore prefer-const
declare let require: unknown;

const __defProp = Object.defineProperty;
const __getOwnPropNames = Object.getOwnPropertyNames;
const __hasOwn = Object.hasOwn;
const __getOwnPropDesc = Object.getOwnPropertyDescriptor;
const __Error = Error;
const __copyProps = (
  to: Record<PropertyKey, unknown>,
  from: Record<PropertyKey, unknown>,
  desc?: PropertyDescriptor,
) => {
  if ((from && typeof from === "object") || typeof from === "function") {
    const names = __getOwnPropNames(from);
    for (let key = names[0], i = 0; i < names.length; key = names[++i]) {
      if (!__hasOwn(to, key)) {
        __defProp(to, key, {
          get: () => from[key],
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable,
        });
      }
    }
  }
  return to;
};
const __toCommonJS = (mod: Record<PropertyKey, unknown>) => {
  if (__hasOwn(mod, "module.exports")) {
    return mod["module.exports"];
  } else if (!__hasOwn(mod, "default") || __hasOwn(mod, "__esModule")) {
    return mod;
  } else {
    return __copyProps(__defProp({}, "__esModule", { value: true }), mod);
  }
};
require = (id: string) => {
  const mod = m[id];
  if (!mod) {
    throw __defProp(new __Error(`Cannot find module '${id}'`), "code", {
      value: "MODULE_NOT_FOUND",
      configurable: true,
      enumerable: true,
      writable: true,
    });
  }
  if (HAS_JSON && __hasOwn(mod, "j")) {
    return mod.j;
  }
  if (HAS_CJS && __hasOwn(mod, "i")) {
    mod.i!();
    return mod.x!();
  }
  if (HAS_ESM && __hasOwn(mod, "m")) {
    return __toCommonJS(mod.m!);
  }
};
