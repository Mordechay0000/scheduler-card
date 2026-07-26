import nodeResolve from 'rollup-plugin-node-resolve';
import typescript from 'rollup-plugin-typescript2';
import json from 'rollup-plugin-json';
import { terser } from 'rollup-plugin-terser';
import commonjs from 'rollup-plugin-commonjs';
import visualizer from 'rollup-plugin-visualizer';


const plugins = [
  nodeResolve(),
  commonjs({
    include: 'node_modules/**',
  }),
  // The plugin's default include patterns ('*.ts+(|x)') match nothing under
  // the installed picomatch, so every .ts file was silently handed to the
  // JS parser instead of TypeScript. Spell the patterns out explicitly.
  typescript({ include: ['*.ts', '**/*.ts', '*.tsx', '**/*.tsx'] }),
  json(),
  visualizer(),
  terser(),
];

export default [
  {
    input: 'src/scheduler-card.ts',
    output: {
      dir: 'dist',
      format: 'iife',
      sourcemap: false,
    },
    plugins: [...plugins],
    context: 'window',
  },
];
