import { defineConfig } from 'vite';
import glsl from 'vite-plugin-glsl';

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
  ],
  server: { open: true },
  build: { target: 'es2022', sourcemap: true },
});
