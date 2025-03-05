import type * as npm from "npm:@npm/types";
import { UntarStream } from "jsr:@std/tar/untar-stream";
import { dirname } from "jsr:@std/path/posix/dirname";
import { normalize } from "jsr:@std/path/posix/normalize";
import { fromFileUrl } from "jsr:@std/path/posix/from-file-url";
import { serveDir } from "jsr:@std/http/file-server";
import { assert } from "jsr:@std/assert/assert";
import { npmToJsr } from "./to_jsr.ts";

const tmpdir = fromFileUrl(new URL("tmp", import.meta.url));
const cachedir = fromFileUrl(new URL("cache", import.meta.url));

try {
  await Deno.remove(tmpdir, { recursive: true });
} catch {
  // ignore
}
await Deno.mkdir(tmpdir);
await Deno.mkdir(cachedir, { recursive: true });

const cacheAttempts = new Map<string, Promise<string>>();
function ensureCached(pkg: string, version: string) {
  if (/\/\.\.?$|^[^@].*\/|@.*\/.*\/|.+@/.test(pkg)) {
    throw new Error("invalid package name");
  }
  if (/^\.\.?$|[\/@]/.test(version)) throw new Error("invalid package version");
  if (cacheAttempts.has(pkg + "@" + version)) {
    return cacheAttempts.get(pkg + "@" + version)!;
  } else {
    const promise = (async () => {
      const cachePath = cachedir + "/" + pkg + "/" + version;
      if (
        await Deno.stat(cachePath).then(
          () => true,
          () => false,
        )
      ) {
        return cachePath;
      }
      const dir = await Deno.makeTempDir({
        dir: tmpdir,
      });
      const indir = dir + "/node_modules/" + pkg;
      try {
        const manifest: npm.PackumentVersion = await (
          await fetch("https://registry.npmjs.com/" + pkg + "/" + version, {
            headers: { accept: "application/vnd.npm.install-v1+json, */*" },
          })
        ).json();
        for await (
          const entry of (await fetch(manifest.dist.tarball))
            .body!.pipeThrough(new DecompressionStream("gzip"))
            .pipeThrough(new UntarStream())
        ) {
          const tarPath = normalize(entry.path);
          assert(
            tarPath === "package" || tarPath.startsWith("package/"),
            "paths in tarball should start with 'package'",
          );
          const path = normalize(indir + "/" + tarPath.slice("package".length));
          if (entry.header.typeflag === "0") {
            await Deno.mkdir(dirname(path), { recursive: true });
            await entry.readable?.pipeTo((await Deno.create(path)).writable);
          } else if (entry.header.typeflag === "5") {
            await Deno.mkdir(path, { recursive: true });
          }
        }
        await npmToJsr(indir, dir + "/output");
        await Deno.mkdir(dirname(cachePath), { recursive: true });
        await Deno.rename(dir + "/output", cachePath);
        return cachePath;
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    })();
    promise.catch(() => cacheAttempts.delete(pkg + "@" + version));
    cacheAttempts.set(pkg + "@" + version, promise);
    return promise;
  }
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/") {
    return new Response(
      "this is an instance of https://github.com/easrng/npm2jsr",
      {
        headers: {
          "content-type": "text/plain",
        },
      },
    );
  }
  const match = url.pathname.match(
    /(^\/@npm\/[^\/]+\/meta.json$)|(^\/@npm\/[^\/]+\/[^\/]+_meta.json$)|(^\/@npm\/[^\/]+\/[^\/]+\/)/,
  );
  if (match?.[1]) {
    const encoded = match[1].slice(6, -10);
    const scope = encoded.indexOf("__");
    const pkg = scope === -1
      ? encoded
      : `@${encoded.slice(0, scope)}/${encoded.slice(scope + 2)}`;
    const packument: npm.Packument = await (
      await fetch("https://registry.npmjs.com/" + pkg)
    ).json();
    return Response.json({
      scope: "npm",
      name: encoded,
      versions: Object.fromEntries(
        Object.entries(packument.versions).map((e) => [
          e[0],
          e[1].deprecated ? { yanked: true } : {},
        ]),
      ),
    });
  } else if (match?.[2]) {
    const [encoded, version] = match[2].slice(6, -10).split("/");
    const scope = encoded.indexOf("__");
    const pkg = scope === -1
      ? encoded
      : `@${encoded.slice(0, scope)}/${encoded.slice(scope + 2)}`;
    const path = await ensureCached(pkg, version);
    return Response.json(
      JSON.parse(await Deno.readTextFile(path + "/_meta.json")),
    );
  } else if (match?.[3]) {
    const [encoded, version] = match[3].slice(6, -1).split("/");
    const scope = encoded.indexOf("__");
    const pkg = scope === -1
      ? encoded
      : `@${encoded.slice(0, scope)}/${encoded.slice(scope + 2)}`;
    const path = await ensureCached(pkg, version);
    return serveDir(req, {
      fsRoot: path,
      showDirListing: true,
      showIndex: false,
      showDotfiles: true,
      quiet: true,
      urlRoot: normalize(decodeURIComponent(match[3].slice(1, -1))),
    });
  }
  return new Response("Not Found", {
    status: 404,
    headers: {
      "content-type": "text/plain",
    },
  });
}

export default {
  async fetch(req: Request): Promise<Response> {
    const res = await handle(req);
    res.headers.set("access-control-allow-origin", "*");
    res.headers.set("access-control-allow-headers", "*");
    return res;
  },
};
