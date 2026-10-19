/**
 * Runs inside workerd (the Cloudflare Workers runtime) to prove the published build uses
 * only Workers-compatible APIs. Provider calls go to an in-Worker mock, never the network.
 */
import { DomainPilot, normalizeHostname } from '../../dist/index.js';

const ACCOUNT = 'a'.repeat(32);
const ZONE_ID = 'b'.repeat(32);

const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const ok = (result: unknown): Response =>
    Response.json({ success: true, errors: [], messages: [], result, result_info: { total_pages: 1 } });
  if (url.host === 'api.cloudflare.com') {
    if (url.pathname.endsWith('/zones') && request.method === 'GET') return ok([]);
    if (url.pathname.endsWith('/zones') && request.method === 'POST') {
      return ok({
        id: ZONE_ID,
        name: 'example.com',
        status: 'pending',
        type: 'full',
        name_servers: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'],
        account: { id: ACCOUNT },
      });
    }
  }
  if (url.host === 'cloudflare-dns.com') return Response.json({ Status: 3 });
  return new Response('not found', { status: 404 });
};

export default {
  async fetch(): Promise<Response> {
    const client = new DomainPilot({
      cloudflare: { apiToken: 'x'.repeat(40), accountId: ACCOUNT },
      ownership: { secret: 's'.repeat(32) },
      http: { fetch: mockFetch, retry: false },
    });
    const zone = await client.cloudflare.zones.create({ domain: 'Example.com' });
    const challenge = await client.ownership.createChallenge({ hostname: 'example.com', tenantId: 'tenant-a' });
    const verification = await client.ownership.verifyChallenge({ hostname: 'example.com', tenantId: 'tenant-a' });
    return Response.json({
      idn: normalizeHostname('bücher.de'),
      zoneId: zone.id,
      created: zone.created,
      nameservers: zone.nameservers,
      challengeName: challenge.record.name,
      challengeLength: challenge.record.content.length,
      verification: verification.status,
    });
  },
};
