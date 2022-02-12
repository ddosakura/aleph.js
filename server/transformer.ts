import { dirname, join } from "https://deno.land/std@0.125.0/path/mod.ts";
import { transform, transformCSS } from "../compiler/mod.ts";
import { toLocalPath, toUrl } from "../lib/path.ts";
import util from "../lib/util.ts";
import { VERSION } from "../version.ts";
import { resolveImportMap } from "./config.ts";

export const serveCode = async (pathname: string, env: Record<string, string>, mtime?: Date) => {
  const [sepcifier, rawCode] = await readCode(pathname);
  const isDev = env.ALEPH_ENV === "development";
  let js: string;
  if (pathname.endsWith(".css")) {
    js = await bundleCSS(sepcifier, rawCode, {
      minify: !isDev,
      cssModules: pathname.endsWith(".module.css"),
      toJs: true,
    });
  } else {
    const importMap = await resolveImportMap();
    const ret = await transform(sepcifier, rawCode, {
      alephPkgUri: getAlephPkgUri(),
      importMap,
      isDev,
    });
    js = ret.code;
  }
  const headers = new Headers({ "Content-Type": "application/javascript; charset=utf-8" });
  if (mtime) {
    headers.set("Last-Modified", mtime.toUTCString());
  }
  return new Response(js, { headers });
};

async function bundleCSS(
  pathname: string,
  rawCode: string,
  options: {
    minify?: boolean;
    cssModules?: boolean;
    toJs?: boolean;
  },
  tracing = new Set<string>(),
): Promise<string> {
  const eof = options.minify ? "" : "\n";
  let { code: css, dependencies, exports } = await transformCSS(pathname, rawCode, {
    ...options,
    analyzeDependencies: true,
    drafts: {
      nesting: true,
      customMedia: true,
    },
  });
  if (dependencies && dependencies.length > 0) {
    const csses = await Promise.all(
      dependencies.filter((dep) => dep.type === "import").map(async (dep) => {
        const p = join(dirname(pathname), dep.url);
        if (tracing.has(p)) {
          return "";
        }
        tracing.add(p);
        const [filename, css] = await readCode(p);
        return await bundleCSS(filename, css, { minify: options.minify }, tracing);
      }),
    );
    css = csses.join(eof) + eof + css;
  }
  if (options.toJs) {
    const cssModulesExports: Record<string, string> = {};
    if (exports) {
      for (const [key, value] of Object.entries(exports)) {
        cssModulesExports[key] = value.name;
      }
    }
    return [
      `import { applyCSS } from "${toLocalPath(getAlephPkgUri())}framework/core/style.ts";`,
      `export const css = ${JSON.stringify(css)};`,
      `export default ${JSON.stringify(cssModulesExports)};`,
      `applyCSS(${JSON.stringify(pathname)}, { css });`,
    ].join(eof);
  }
  return css;
}

async function readCode(pathname: string): Promise<[string, string]> {
  if (pathname.startsWith("/-/")) {
    const url = toUrl(pathname);
    return [url, await fetch(url).then((res) => res.text())];
  }
  return [`.${pathname}`, await Deno.readTextFile(`.${pathname}`)];
}

function getAlephPkgUri() {
  // @ts-ignore
  if (util.isFilledString(globalThis.__ALEPH_PKG_URI)) {
    // @ts-ignore
    return globalThis.__ALEPH_PKG_URI;
  }
  let uri = `https://deno.land/x/aleph@v${VERSION}`;
  const DEV_PORT = Deno.env.get("ALEPH_DEV_PORT");
  if (DEV_PORT) {
    uri = `http://localhost:${DEV_PORT}`;
  }
  // @ts-ignore
  globalThis.__ALEPH_PKG_URI = uri;
  return uri;
}