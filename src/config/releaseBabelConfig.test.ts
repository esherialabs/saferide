import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type BabelCore = {
  transformSync(
    code: string,
    options: Record<string, unknown>,
  ): { code?: string | null } | null;
};

const requireFromTest = createRequire(import.meta.url);
const babel = requireFromTest('@babel/core') as BabelCore;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const configFile = path.join(projectRoot, 'babel.config.js');

const source = [
  "export function report(draftId: string, error: unknown) {",
  "  console.log('draft', draftId);",
  "  console.info('draft', draftId);",
  "  console.warn('failed', error);",
  "  console.error('failed', error);",
  "  console.debug('draft', draftId);",
  "  return draftId.length;",
  "}",
].join('\n');

function transform(envName: 'production' | 'development'): string {
  const result = babel.transformSync(source, {
    babelrc: false,
    configFile,
    cwd: projectRoot,
    envName,
    filename: path.join(projectRoot, 'src/releaseConsoleProbe.ts'),
    root: projectRoot,
  });
  return result?.code ?? '';
}

describe('release Babel config', () => {
  it('strips console calls from production bundles', () => {
    const output = transform('production');

    expect(output).not.toMatch(/console\./);
    expect(output).toContain('draftId.length');
  });

  it('keeps console calls in development bundles', () => {
    const output = transform('development');

    expect(output).toContain('console.log');
    expect(output).toContain('console.warn');
  });
});
