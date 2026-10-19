// Bundles the smoke Worker against dist/ and executes it in workerd via Miniflare.
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const result = await build({
  entryPoints: [new URL('./smoke.worker.ts', import.meta.url).pathname],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
});
const mf = new Miniflare({ modules: true, script: result.outputFiles[0].text, compatibilityDate: '2025-09-01' });
try {
  const response = await mf.dispatchFetch('http://localhost/');
  const body = await response.json();
  const expected = {
    idn: 'xn--bcher-kva.de',
    zoneId: 'b'.repeat(32),
    created: true,
    challengeName: '_domainwright.example.com',
    verification: 'pending',
  };
  for (const [key, value] of Object.entries(expected)) {
    if (body[key] !== value)
      throw new Error(`Workers smoke test: ${key} = ${JSON.stringify(body[key])}, expected ${JSON.stringify(value)}`);
  }
  if (body.challengeLength !== 'domainwright-verification='.length + 32) throw new Error('unexpected challenge length');
  console.log('Workers runtime smoke test passed', body);
} finally {
  await mf.dispose();
}
