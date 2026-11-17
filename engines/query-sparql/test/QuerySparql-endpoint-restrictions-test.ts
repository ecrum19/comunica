import { join } from 'node:path';
import { QueryEngine } from '../lib/QueryEngine';
import { QueryEngineFactory } from '../lib/QueryEngineFactory';

interface IEndpointRequest {
  query: string;
  time: number;
}

/**
 * Create a fetch function for a SPARQL endpoint that has the given number of results for every query,
 * that respects LIMIT and OFFSET, and that truncates every result to the given number of results.
 * Requests without query obtain the given service description.
 * @param serviceDescription A Turtle service description.
 * @param total The number of results.
 * @param truncateAt The maximum number of results per response.
 * @param requests An array in which the received queries are stored.
 */
function createEndpointFetch(
  serviceDescription: string,
  total: number,
  truncateAt: number,
  requests: IEndpointRequest[],
): typeof fetch {
  return async(input: RequestInfo | URL, init?: RequestInit) => {
    const query = init?.body ?
      new URLSearchParams(String(init.body)).get('query') :
      new URL(input instanceof Request ? input.url : String(input)).searchParams.get('query');
    if (!query) {
      return new Response(serviceDescription, { status: 200, headers: { 'Content-Type': 'text/turtle' }});
    }
    requests.push({ query, time: Date.now() });

    const limit = /LIMIT (\d+)/u.exec(query);
    const offset = /OFFSET (\d+)/u.exec(query);
    const start = offset ? Number(offset[1]) : 0;
    const end = Math.min(total, start + truncateAt, limit ? start + Number(limit[1]) : total);
    const bindings = [];
    for (let i = start; i < end; i++) {
      bindings.push({ o: { type: 'uri', value: `http://example.org/o${i}` }});
    }
    return new Response(
      JSON.stringify({ head: { vars: [ 'o' ]}, results: { bindings }}),
      { status: 200, headers: { 'Content-Type': 'application/sparql-results+json' }},
    );
  };
}

function createServiceDescription(endpoint: string, restrictions: string): string {
  return `
@prefix sd: <http://www.w3.org/ns/sparql-service-description#> .
@prefix vord: <https://w3id.org/vord#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<${endpoint}#service> a sd:Service ;
  sd:endpoint <${endpoint}> ;
  sd:supportedLanguage sd:SPARQL11Query ${restrictions}.
`;
}

const vordRestrictions = `;
  vord:hasRestriction <#results>, <#rate> .

<#results> a vord:Restriction, vord:ResultSizeRestriction ;
  vord:metric vord:resultBindings ;
  vord:maxValue "2"^^xsd:integer ;
  vord:enforcement vord:TruncateResult ;
  vord:hardRestriction true .

<#rate> a vord:Restriction, vord:RateRestriction ;
  vord:metric vord:requestsPerWindow ;
  vord:maxValue "1"^^xsd:integer ;
  vord:windowDuration "PT0.2S"^^xsd:duration ;
  vord:enforcement vord:RejectRequest ;
  vord:hardRestriction true `;

/**
 * Endpoints are passed without forcing their type,
 * as the service descriptions of single forced SPARQL sources are not fetched by default.
 */
describe('System test: QuerySparql with an endpoint that advertises VoRD restrictions', () => {
  let engine: QueryEngine;

  beforeAll(() => {
    engine = new QueryEngine();
  });

  it('obtains all results in pages that are spaced out according to the rate limit', async() => {
    const endpoint = 'http://restricted.example.org/sparql';
    const requests: IEndpointRequest[] = [];
    const bindings = await (await engine.queryBindings('SELECT ?o WHERE { <http://example.org/s> <http://example.org/p> ?o }', {
      sources: [ endpoint ],
      fetch: createEndpointFetch(createServiceDescription(endpoint, vordRestrictions), 5, 2, requests),
    })).toArray();

    expect(bindings.map(binding => binding.get('o')!.value)).toEqual([
      'http://example.org/o0',
      'http://example.org/o1',
      'http://example.org/o2',
      'http://example.org/o3',
      'http://example.org/o4',
    ]);
    expect(requests.map(request => request.query)).toEqual([
      'SELECT ?o WHERE { <http://example.org/s> <http://example.org/p> ?o . } LIMIT 2',
      'SELECT ?o WHERE { <http://example.org/s> <http://example.org/p> ?o . } LIMIT 2 OFFSET 2',
      'SELECT ?o WHERE { <http://example.org/s> <http://example.org/p> ?o . } LIMIT 2 OFFSET 4',
    ]);
    // Requests are spaced 200ms apart when they are sent, but the time until they reach the endpoint may vary.
    // Without rate limiting, pages would be requested only a few milliseconds apart.
    for (let i = 1; i < requests.length; i++) {
      expect(requests[i].time - requests[i - 1].time).toBeGreaterThanOrEqual(150);
    }
  });

  it('obtains truncated results from an endpoint without VoRD restrictions', async() => {
    const endpoint = 'http://unrestricted.example.org/sparql';
    const requests: IEndpointRequest[] = [];
    const bindings = await (await engine.queryBindings('SELECT ?o WHERE { <http://example.org/s> <http://example.org/p> ?o }', {
      sources: [ endpoint ],
      fetch: createEndpointFetch(createServiceDescription(endpoint, ''), 5, 2, requests),
    })).toArray();

    expect(bindings).toHaveLength(2);
    expect(requests).toHaveLength(1);
  });
});

describe('System test: QuerySparql with a forced SPARQL endpoint that advertises VoRD restrictions', () => {
  it('ignores the restrictions by default, as the service description is not fetched', async() => {
    const endpoint = 'http://forced-default.example.org/sparql';
    const requests: IEndpointRequest[] = [];
    const bindings = await (await new QueryEngine().queryBindings('SELECT ?o WHERE { <http://example.org/s> <http://example.org/p> ?o }', {
      sources: [{ type: 'sparql', value: endpoint }],
      fetch: createEndpointFetch(createServiceDescription(endpoint, vordRestrictions), 5, 2, requests),
    })).toArray();

    expect(bindings).toHaveLength(2);
    expect(requests).toHaveLength(1);
  });

  it('respects the restrictions if service descriptions of forced SPARQL sources are fetched', async() => {
    const engine = await new QueryEngineFactory()
      .create({ configPath: join(__dirname, 'assets', 'config-fetch-service-description.json') });
    const endpoint = 'http://forced-fetching.example.org/sparql';
    const requests: IEndpointRequest[] = [];
    const bindings = await (await engine.queryBindings('SELECT ?o WHERE { <http://example.org/s> <http://example.org/p> ?o }', {
      sources: [{ type: 'sparql', value: endpoint }],
      fetch: createEndpointFetch(createServiceDescription(endpoint, vordRestrictions), 5, 2, requests),
    })).toArray();

    expect(bindings).toHaveLength(5);
    expect(requests).toHaveLength(3);
  }, 60_000);
});

describe('System test: QuerySparql with endpoint restrictions provided by the user', () => {
  const query = 'SELECT ?o WHERE { <http://example.org/s> <http://example.org/p> ?o }';
  let engine: QueryEngine;

  beforeAll(() => {
    engine = new QueryEngine();
  });

  it('respects restrictions provided as objects for an endpoint without service description', async() => {
    const endpoint = 'http://provided-objects.example.org/sparql';
    const requests: IEndpointRequest[] = [];
    const bindings = await (await engine.queryBindings(query, {
      sources: [{ type: 'sparql', value: endpoint }],
      fetch: createEndpointFetch(createServiceDescription(endpoint, ''), 5, 2, requests),
      endpointRestrictions: {
        [endpoint]: [
          { type: 'resultSize', maxValue: 2, enforcement: 'truncate' },
          { type: 'rate', maxValue: 1, windowDuration: 'PT0.2S' },
        ],
      },
    })).toArray();

    expect(bindings).toHaveLength(5);
    expect(requests).toHaveLength(3);
    for (let i = 1; i < requests.length; i++) {
      expect(requests[i].time - requests[i - 1].time).toBeGreaterThanOrEqual(150);
    }
  });

  it('respects restrictions provided as a VoRD description at a URL', async() => {
    const endpoint = 'http://provided-description.example.org/sparql';
    const requests: IEndpointRequest[] = [];
    // The fetch function returns the service description with restrictions for every request without query.
    const bindings = await (await engine.queryBindings(query, {
      sources: [{ type: 'sparql', value: endpoint }],
      fetch: createEndpointFetch(createServiceDescription(endpoint, vordRestrictions), 5, 2, requests),
      endpointRestrictions: { [endpoint]: 'http://provided-description.example.org/vord.ttl' },
    })).toArray();

    expect(bindings).toHaveLength(5);
    expect(requests).toHaveLength(3);
  });

  it('replaces the restrictions that the endpoint advertises', async() => {
    const endpoint = 'http://provided-replaced.example.org/sparql';
    const requests: IEndpointRequest[] = [];
    const bindings = await (await engine.queryBindings(query, {
      sources: [ endpoint ],
      fetch: createEndpointFetch(createServiceDescription(endpoint, vordRestrictions), 5, 2, requests),
      endpointRestrictions: { [endpoint]: []},
    })).toArray();

    // Without the advertised result size restriction, results are not requested in pages, and are truncated.
    expect(bindings).toHaveLength(2);
    expect(requests).toHaveLength(1);
  });

  it('rejects local files, as this engine cannot read them', async() => {
    const endpoint = 'http://provided-file.example.org/sparql';
    await expect(engine.queryBindings(query, {
      sources: [{ type: 'sparql', value: endpoint }],
      fetch: createEndpointFetch(createServiceDescription(endpoint, ''), 5, 2, []),
      endpointRestrictions: { [endpoint]: 'vord.ttl' },
    })).rejects.toThrow('can only be read by engines that can query local files, such as @comunica/query-sparql-file');
  });

  it('rejects invalid restrictions', async() => {
    const endpoint = 'http://provided-invalid.example.org/sparql';
    await expect(engine.queryBindings(query, {
      sources: [{ type: 'sparql', value: endpoint }],
      endpointRestrictions: { [endpoint]: [{ type: 'rate', maxValue: 1 }]},
    })).rejects.toThrow(`Restriction 0 of ${endpoint} needs a windowDuration, such as 'PT1M'`);
  });
});
