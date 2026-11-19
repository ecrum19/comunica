import { KeysInitQuery, KeysQuerySourceIdentify } from '@comunica/context-entries';
import { ActionContext, Bus } from '@comunica/core';
import type { IActionContext } from '@comunica/types';
import type * as RDF from '@rdfjs/types';
import { DataFactory } from 'rdf-data-factory';
import { Readable } from 'readable-stream';
import { streamifyArray } from 'streamify-array';
import { ActorContextPreprocessEndpointRestrictions } from '../lib/ActorContextPreprocessEndpointRestrictions';
import '@comunica/utils-jest';

const DF = new DataFactory();

const VORD = 'https://w3id.org/vord#';
const SD = 'http://www.w3.org/ns/sparql-service-description#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF_TYPE = DF.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');

function vord(localName: string): RDF.NamedNode {
  return DF.namedNode(`${VORD}${localName}`);
}

function sd(localName: string): RDF.NamedNode {
  return DF.namedNode(`${SD}${localName}`);
}

function typed(value: string, datatype: string): RDF.Literal {
  return DF.literal(value, DF.namedNode(`${XSD}${datatype}`));
}

/**
 * Create the quads of a service with a single rate restriction.
 * @param service The IRI of the service.
 * @param endpoint The IRI of the endpoint of the service.
 * @param maxValue The maximum number of requests per minute.
 */
function serviceQuads(service: string, endpoint: string, maxValue: number): RDF.Quad[] {
  const restriction = DF.namedNode(`${service}#rate`);
  return [
    DF.quad(DF.namedNode(service), RDF_TYPE, sd('Service')),
    DF.quad(DF.namedNode(service), sd('endpoint'), DF.namedNode(endpoint)),
    DF.quad(DF.namedNode(service), vord('hasRestriction'), restriction),
    DF.quad(restriction, RDF_TYPE, vord('RateRestriction')),
    DF.quad(restriction, vord('maxValue'), typed(String(maxValue), 'integer')),
    DF.quad(restriction, vord('windowDuration'), typed('PT1M', 'duration')),
  ];
}

describe('ActorContextPreprocessEndpointRestrictions', () => {
  let bus: any;
  let documents: Record<string, () => RDF.Stream>;
  let mediatorDereferenceRdf: any;
  let actor: ActorContextPreprocessEndpointRestrictions;
  let context: IActionContext;

  beforeEach(() => {
    bus = new Bus({ name: 'bus' });
    documents = {};
    mediatorDereferenceRdf = {
      mediate: jest.fn(async({ url }: { url: string }) => {
        if (!documents[url]) {
          throw new Error(`Could not dereference '${url}'`);
        }
        return { data: documents[url](), url };
      }),
    };
    actor = new ActorContextPreprocessEndpointRestrictions({ name: 'actor', bus, mediatorDereferenceRdf });
    context = new ActionContext();
  });

  /**
   * Run the actor on a context with the given endpointRestrictions entry.
   * @param endpointRestrictions The value of the endpointRestrictions context entry.
   */
  async function resolve(endpointRestrictions: any): Promise<IActionContext> {
    return (await actor.run({
      context: context.set(KeysQuerySourceIdentify.endpointRestrictions, endpointRestrictions),
      initialize: true,
    })).context;
  }

  /**
   * Resolve a single restriction object for an endpoint.
   * @param restriction A restriction object.
   */
  async function resolveRestriction(restriction: any): Promise<any> {
    const resolved = (await resolve({ 'http://example.org/sparql': [ restriction ]}))
      .get(KeysQuerySourceIdentify.endpointRestrictionsResolved)!;
    return resolved['http://example.org/sparql'][0];
  }

  it('should test', async() => {
    await expect(actor.test({ context })).resolves.toPassTestVoid();
  });

  describe('run', () => {
    it('should not change a context without endpoint restrictions', async() => {
      await expect(actor.run({ context, initialize: true })).resolves.toEqual({ context });
    });

    it('should not change a context that is not being initialized', async() => {
      const contextIn = context.set(KeysQuerySourceIdentify.endpointRestrictions, { 'http://example.org/sparql': []});
      await expect(actor.run({ context: contextIn })).resolves.toEqual({ context: contextIn });
    });

    it.each([ 'replace', 'compare', 'provided-only' ])('should accept the mode %s', async(mode) => {
      const contextIn = context.set(KeysQuerySourceIdentify.endpointRestrictionsMode, <any> mode);
      await expect(actor.run({ context: contextIn, initialize: true })).resolves.toEqual({ context: contextIn });
    });

    it.each([
      [ 'an unknown mode', 'merge', '"merge"' ],
      [ 'not a string', true, 'true' ],
    ])('should reject a mode that is %s', async(_name, mode, shown) => {
      const contextIn = context.set(KeysQuerySourceIdentify.endpointRestrictionsMode, <any> mode);
      await expect(actor.run({ context: contextIn, initialize: true })).rejects
        .toThrow(`The endpointRestrictionsMode context entry must be one of replace, compare, provided-only, but was ${shown}`);
    });

    it('should not check the mode in a context that is not being initialized', async() => {
      const contextIn = context.set(KeysQuerySourceIdentify.endpointRestrictionsMode, <any> 'merge');
      await expect(actor.run({ context: contextIn })).resolves.toEqual({ context: contextIn });
    });

    it.each([
      [ 'an array', []],
      [ 'a string', 'restrictions.ttl' ],
      [ 'null', null ],
    ])('should reject an entry that is %s', async(_name, value) => {
      await expect(resolve(value)).rejects
        .toThrow('The endpointRestrictions context entry must be an object with endpoint URLs as keys');
    });

    it.each([
      [ 'a number', 10 ],
      [ 'an object', { type: 'rate' }],
      [ 'null', null ],
    ])('should reject restrictions of an endpoint that are %s', async(_name, value) => {
      await expect(resolve({ 'http://example.org/sparql': value })).rejects
        .toThrow('The endpoint restrictions of http://example.org/sparql must be the path or URL of a VoRD description, or a list of restrictions');
    });

    it('should replace the entry by the resolved restrictions, keyed by normalized URL', async() => {
      const contextOut = await resolve({
        'HTTP://Example.org/sparql': [{ type: 'resultSize', maxValue: 100 }],
        'http://other.example.org': [],
      });
      expect(contextOut.has(KeysQuerySourceIdentify.endpointRestrictions)).toBe(false);
      expect(contextOut.get(KeysQuerySourceIdentify.endpointRestrictionsResolved)).toEqual({
        'http://example.org/sparql': [{ type: 'resultSize', maxValue: 100 }],
        'http://other.example.org/': [],
      });
    });

    it('should keep restrictions that were already resolved for other endpoints', async() => {
      context = context.set(KeysQuerySourceIdentify.endpointRestrictionsResolved, {
        'http://other.example.org/': [{ type: 'resultSize', maxValue: 10 }],
        'http://example.org/sparql': [{ type: 'resultSize', maxValue: 20 }],
      });
      const contextOut = await resolve({ 'http://example.org/sparql': [{ type: 'resultSize', maxValue: 100 }]});
      expect(contextOut.get(KeysQuerySourceIdentify.endpointRestrictionsResolved)).toEqual({
        'http://other.example.org/': [{ type: 'resultSize', maxValue: 10 }],
        'http://example.org/sparql': [{ type: 'resultSize', maxValue: 100 }],
      });
    });

    it('should resolve restrictions from documents and objects', async() => {
      documents['wikidata.ttl'] = () => streamifyArray(
        serviceQuads('http://example.org/service', 'https://query.wikidata.org/sparql', 60),
      );
      const contextOut = await resolve({
        'https://query.wikidata.org/sparql': 'wikidata.ttl',
        'https://dbpedia.org/sparql': [{ type: 'concurrentRequests', maxValue: 2 }],
      });
      expect(contextOut.get(KeysQuerySourceIdentify.endpointRestrictionsResolved)).toEqual({
        'https://query.wikidata.org/sparql': [{ type: 'rate', maxValue: 60, windowDuration: 60_000 }],
        'https://dbpedia.org/sparql': [{ type: 'concurrentRequests', maxValue: 2 }],
      });
    });
  });

  describe('readRestrictions', () => {
    const endpoint = 'https://example.org/sparql';

    it('should use the service of the endpoint', async() => {
      documents['https://example.org/vord.ttl'] = () => streamifyArray([
        ...serviceQuads('http://example.org/other', 'https://other.example.org/sparql', 10),
        ...serviceQuads('http://example.org/service', endpoint, 20),
      ]);
      await expect(actor.readRestrictions(endpoint, 'https://example.org/vord.ttl', context)).resolves
        .toEqual([{ type: 'rate', maxValue: 20, windowDuration: 60_000 }]);
    });

    it('should use the only service, even if its endpoint is different', async() => {
      documents['vord.ttl'] = () => streamifyArray(
        serviceQuads('http://example.org/service', 'https://other.example.org/sparql', 10),
      );
      await expect(actor.readRestrictions(endpoint, 'vord.ttl', context)).resolves
        .toEqual([{ type: 'rate', maxValue: 10, windowDuration: 60_000 }]);
    });

    it('should skip restrictions that are not described', async() => {
      documents['vord.ttl'] = () => streamifyArray([
        ...serviceQuads('http://example.org/service', endpoint, 10),
        DF.quad(DF.namedNode('http://example.org/service'), vord('hasRestriction'), DF.namedNode('http://example.org/r')),
      ]);
      await expect(actor.readRestrictions(endpoint, 'vord.ttl', context)).resolves
        .toEqual([{ type: 'rate', maxValue: 10, windowDuration: 60_000 }]);
    });

    it('should not ignore errors in lenient mode', async() => {
      documents['vord.ttl'] = () => streamifyArray(serviceQuads('http://example.org/service', endpoint, 10));
      await actor.readRestrictions(endpoint, 'vord.ttl', context.set(KeysInitQuery.lenient, true));
      expect(mediatorDereferenceRdf.mediate).toHaveBeenCalledWith({ url: 'vord.ttl', context });
    });

    it('should reject a document that describes no restrictions of the endpoint', async() => {
      documents['vord.ttl'] = () => streamifyArray([
        ...serviceQuads('http://example.org/a', 'https://a.example.org/sparql', 10),
        ...serviceQuads('http://example.org/b', 'https://b.example.org/sparql', 20),
      ]);
      await expect(actor.readRestrictions(endpoint, 'vord.ttl', context)).rejects.toThrow(`vord.ttl describes no VoRD restrictions for https://example.org/sparql. It must describe a service with sd:endpoint <https://example.org/sparql>, or a single service, that links to its restrictions with vord:hasRestriction.`);
    });

    it('should reject a document without restrictions', async() => {
      documents['vord.ttl'] = () => streamifyArray([]);
      await expect(actor.readRestrictions(endpoint, 'vord.ttl', context)).rejects
        .toThrow('vord.ttl describes no VoRD restrictions for https://example.org/sparql.');
    });

    it('should reject a URL that cannot be read', async() => {
      await expect(actor.readRestrictions(endpoint, 'https://example.org/missing.ttl', context)).rejects
        .toThrow(new Error(`Could not read the restrictions of https://example.org/sparql from https://example.org/missing.ttl: Could not dereference 'https://example.org/missing.ttl'`));
    });

    it('should reject a local file that cannot be read, and explain which engines can read local files', async() => {
      await expect(actor.readRestrictions(endpoint, 'missing.ttl', context)).rejects
        .toThrow(new Error(`Could not read the restrictions of https://example.org/sparql from missing.ttl: Could not dereference 'missing.ttl' Local files can only be read by engines that can query local files, such as @comunica/query-sparql-file.`));
    });

    it('should reject a document that cannot be parsed', async() => {
      documents['vord.ttl'] = () => {
        const stream = new Readable({ objectMode: true });
        stream._read = () => stream.emit('error', new Error('Unexpected token'));
        return stream;
      };
      await expect(actor.readRestrictions(endpoint, 'vord.ttl', context)).rejects
        .toThrow('Could not read the restrictions of https://example.org/sparql from vord.ttl: Unexpected token');
    });
  });

  describe('parseRestriction', () => {
    it('should parse a restriction with all fields', async() => {
      await expect(resolveRestriction({
        type: 'rate',
        metric: 'vord:requestsPerWindow',
        maxValue: 60,
        minValue: 0,
        burstValue: 15,
        unit: 'http://qudt.org/vocab/unit/COUNT',
        windowDuration: 'PT1M',
        retryAfterHint: 30_000,
        returnsStatusCode: 429,
        httpSignalHeader: 'Retry-After',
        scope: 'vord:PerClientIP',
        enforcement: 'reject',
        hardRestriction: true,
        costModel: 'https://example.org/costModel',
      })).resolves.toEqual({
        type: 'rate',
        metric: `${VORD}requestsPerWindow`,
        maxValue: 60,
        minValue: 0,
        burstValue: 15,
        unit: 'http://qudt.org/vocab/unit/COUNT',
        windowDuration: 60_000,
        retryAfterHint: 30_000,
        returnsStatusCode: 429,
        httpSignalHeader: 'retry-after',
        scope: `${VORD}PerClientIP`,
        enforcement: 'reject',
        hardRestriction: true,
        costModel: 'https://example.org/costModel',
      });
    });

    it('should skip undefined fields', async() => {
      await expect(resolveRestriction({ type: 'resultSize', maxValue: 10, enforcement: undefined })).resolves
        .toEqual({ type: 'resultSize', maxValue: 10 });
    });

    it('should accept types and enforcement modes as VoRD terms', async() => {
      await expect(resolveRestriction({
        type: 'vord:ResultSizeRestriction',
        maxValue: 10,
        enforcement: `${VORD}TruncateResult`,
      })).resolves.toEqual({ type: 'resultSize', maxValue: 10, enforcement: 'truncate' });
    });

    it('should derive the type from the metric', async() => {
      await expect(resolveRestriction({ metric: 'vord:evaluationTime', maxValue: 60 })).resolves
        .toEqual({ type: 'responseTime', metric: `${VORD}evaluationTime`, maxValue: 60 });
    });

    it('should give daily request counts a window of one day', async() => {
      await expect(resolveRestriction({ metric: 'vord:requestsPerDay', maxValue: 1_000 })).resolves
        .toEqual({ type: 'quota', metric: `${VORD}requestsPerDay`, maxValue: 1_000, windowDuration: 86_400_000 });
    });

    it('should accept restrictions without a limit if Comunica does not act on them', async() => {
      await expect(resolveRestriction({ type: 'serverLoad' })).resolves.toEqual({ type: 'serverLoad' });
      await expect(resolveRestriction({ type: 'other', enforcement: 'other' })).resolves
        .toEqual({ type: 'other', enforcement: 'other' });
    });

    it.each([
      [ 'that is not an object', 'rate', 'Restriction 0 of http://example.org/sparql must be an object' ],
      [ 'that is null', null, 'Restriction 0 of http://example.org/sparql must be an object' ],
      [ 'that is an array', [], 'Restriction 0 of http://example.org/sparql must be an object' ],
      [
        'with an unknown field',
        { type: 'rate', maxValue: 10, windowDuration: 1_000, windowduration: 1_000 },
        `Restriction 0 of http://example.org/sparql has an unknown field 'windowduration'. Known fields are: type, metric, maxValue, minValue, burstValue, unit, windowDuration, retryAfterHint, returnsStatusCode, httpSignalHeader, scope, enforcement, hardRestriction, costModel`,
      ],
      [
        'without type or metric',
        { maxValue: 10 },
        `Restriction 0 of http://example.org/sparql needs a type, such as 'rate', or a metric from which it follows, such as 'vord:requestsPerWindow'`,
      ],
      [
        'without a type that follows from its metric',
        { metric: 'https://example.org/metric', maxValue: 10 },
        `Restriction 0 of http://example.org/sparql needs a type`,
      ],
      [
        'with an unknown type',
        { type: 'speed', maxValue: 10 },
        `The type of restriction 0 of http://example.org/sparql must be one of rate, quota, resultSize, costModel, serverLoad, concurrentRequests, responseTime, other, or a VoRD restriction class such as 'vord:RateRestriction'`,
      ],
      [
        'with an unknown enforcement mode',
        { type: 'resultSize', maxValue: 10, enforcement: 'block' },
        `The enforcement of restriction 0 of http://example.org/sparql must be one of reject, truncate, queue, throttle, degrade, other, or a VoRD enforcement mode such as 'vord:RejectRequest'`,
      ],
      [
        'with an IRI that is not a string',
        { type: 'resultSize', maxValue: 10, scope: 1 },
        'The scope of restriction 0 of http://example.org/sparql must be a string',
      ],
      [
        'with a header that is not a string',
        { type: 'resultSize', maxValue: 10, httpSignalHeader: true },
        'The httpSignalHeader of restriction 0 of http://example.org/sparql must be a string',
      ],
      [
        'with a value that is not a number',
        { type: 'resultSize', maxValue: '10' },
        'The maxValue of restriction 0 of http://example.org/sparql must be a number of at least 0',
      ],
      [
        'with a negative value',
        { type: 'resultSize', maxValue: 10, minValue: -1 },
        'The minValue of restriction 0 of http://example.org/sparql must be a number of at least 0',
      ],
      [
        'with an infinite value',
        { type: 'resultSize', maxValue: Number.POSITIVE_INFINITY },
        'The maxValue of restriction 0 of http://example.org/sparql must be a number of at least 0',
      ],
      [
        'with a status code that is not an integer',
        { type: 'concurrentRequests', maxValue: 2, returnsStatusCode: 429.5 },
        'The returnsStatusCode of restriction 0 of http://example.org/sparql must be an HTTP status code, such as 429',
      ],
      [
        'with a status code that is too low',
        { type: 'concurrentRequests', maxValue: 2, returnsStatusCode: 99 },
        'The returnsStatusCode of restriction 0 of http://example.org/sparql must be an HTTP status code',
      ],
      [
        'with a status code that is too high',
        { type: 'concurrentRequests', maxValue: 2, returnsStatusCode: 600 },
        'The returnsStatusCode of restriction 0 of http://example.org/sparql must be an HTTP status code',
      ],
      [
        'with an invalid duration',
        { type: 'rate', maxValue: 10, windowDuration: '1 minute' },
        `The windowDuration of restriction 0 of http://example.org/sparql must be a number of milliseconds above 0, or an xsd:duration such as 'PT1M'`,
      ],
      [
        'with a duration of zero',
        { type: 'rate', maxValue: 10, windowDuration: 0 },
        'The windowDuration of restriction 0 of http://example.org/sparql must be a number of milliseconds above 0',
      ],
      [
        'with a duration that is not a number or string',
        { type: 'rate', maxValue: 10, windowDuration: 1_000, retryAfterHint: true },
        'The retryAfterHint of restriction 0 of http://example.org/sparql must be a number of milliseconds above 0',
      ],
      [
        'with a hardness that is not a boolean',
        { type: 'resultSize', maxValue: 10, hardRestriction: 'true' },
        'The hardRestriction of restriction 0 of http://example.org/sparql must be true or false',
      ],
      [
        'without the limit that Comunica acts on',
        { type: 'concurrentRequests' },
        'Restriction 0 of http://example.org/sparql needs a maxValue above 0',
      ],
      [
        'with a limit of zero',
        { type: 'resultSize', maxValue: 0 },
        'Restriction 0 of http://example.org/sparql needs a maxValue above 0',
      ],
      [
        'with a rate limit without a window',
        { type: 'rate', maxValue: 10 },
        `Restriction 0 of http://example.org/sparql needs a windowDuration, such as 'PT1M'`,
      ],
      [
        'with a quota without a window',
        { type: 'quota', maxValue: 1_000 },
        `Restriction 0 of http://example.org/sparql needs a windowDuration, such as 'PT1M'`,
      ],
    ])('should reject a restriction %s', async(_name, restriction, message) => {
      await expect(resolveRestriction(restriction)).rejects.toThrow(message);
    });
  });

  describe('normalizeUrl', () => {
    it('should normalize URLs', () => {
      expect(ActorContextPreprocessEndpointRestrictions.normalizeUrl('HTTPS://Example.org')).toBe('https://example.org/');
    });

    it('should keep values that are not URLs', () => {
      expect(ActorContextPreprocessEndpointRestrictions.normalizeUrl('not a URL')).toBe('not a URL');
    });
  });
});
