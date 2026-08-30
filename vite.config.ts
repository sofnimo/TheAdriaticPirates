import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage } from 'node:http';
import { defineConfig, type Plugin } from 'vite';
import glsl from 'vite-plugin-glsl';

const root = dirname(fileURLToPath(import.meta.url));

/**
 * Clean routes for the multi-page dev entries.
 *
 * Vite serves `testmodels.html` at `/testmodels.html` out of the box; this makes
 * `/testmodels` work too, so the bench has a URL you can type. Query strings are
 * preserved — every scene in this project is configured through them.
 */
const ROUTES: Record<string, string> = {
  '/testmodels': '/testmodels.html',
  '/grassworld': '/grassworld.html',
};

function cleanRoutes(): Plugin {
  const rewrite = (req: IncomingMessage): void => {
    const url = req.url ?? '/';
    const q = url.indexOf('?');
    const pathname = (q === -1 ? url : url.slice(0, q)).replace(/\/+$/, '');
    const target = ROUTES[pathname];
    if (target) req.url = target + (q === -1 ? '' : url.slice(q));
  };

  return {
    name: 'adriatic-clean-routes',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        rewrite(req);
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, _res, next) => {
        rewrite(req);
        next();
      });
    },
  };
}

/**
 * Serves three's Draco decoder at `/draco/` without committing 300 kB of wasm to the repo.
 *
 * GLTFLoader needs the decoder as *files it fetches at runtime*, not as an import, so the
 * usual "just import it" answer does not apply. In dev the files are streamed straight out
 * of node_modules; for a build they are copied into the output next to the bundle. The
 * model bench is the only consumer — plenty of downloadable glTF is Draco-compressed, and
 * failing on it with a decoder error is a bad first five minutes.
 */
function dracoDecoder(): Plugin {
  const src = resolve(root, 'node_modules/three/examples/jsm/libs/draco/gltf');
  let outDir = 'dist';

  return {
    name: 'adriatic-draco-decoder',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    configureServer(server) {
      server.middlewares.use('/draco', (req, res, next) => {
        const name = (req.url ?? '/').split('?')[0]?.replace(/^\/+/, '') ?? '';
        // Path traversal guard: the decoder is four known files, nothing else.
        if (!/^[\w.]+$/.test(name)) return next();
        const file = join(src, name);
        try {
          if (!statSync(file).isFile()) return next();
        } catch {
          return next();
        }
        res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        res.end(readFileSync(file));
      });
    },
    closeBundle() {
      const dest = resolve(root, outDir, 'draco');
      mkdirSync(dest, { recursive: true });
      for (const name of readdirSync(src)) copyFileSync(join(src, name), join(dest, name));
    },
  };
}

export default defineConfig({
  // GLSL #include support is load-bearing for the shared gouache chunk (04_LIGHT.md §2.2):
  // the ramp exists as exactly one .glsl file that every material includes, never a
  // string constant copy-pasted per material.
  plugins: [
    glsl({
      include: ['**/*.glsl', '**/*.vert', '**/*.frag'],
      // The gouache ramp gets #included by many shaders; dedupe repeats within one
      // compilation unit so a shader that pulls it in transitively twice still builds.
      removeDuplicatedImports: true,
      minify: false,
    }),
    cleanRoutes(),
    dracoDecoder(),
  ],
  // Model files dropped into src/models/ are assets, not modules — the bench globs them
  // as URLs and hands them to GLTFLoader.
  assetsInclude: ['**/*.glb', '**/*.gltf', '**/*.bin', '**/*.fbx', '**/*.obj', '**/*.mtl', '**/*.hdr'],
  server: { open: true },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      input: {
        main: resolve(root, 'index.html'),
        testmodels: resolve(root, 'testmodels.html'),
        grassworld: resolve(root, 'grassworld.html'),
      },
    },
  },
});
