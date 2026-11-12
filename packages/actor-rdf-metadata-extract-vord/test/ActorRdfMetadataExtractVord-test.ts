import { ActionContext, Bus } from '@comunica/core';
import type { IActionContext } from '@comunica/types';
import type * as RDF from '@rdfjs/types';
import { DataFactory } from 'rdf-data-factory';
import { Readable } from 'readable-stream';
import { streamifyArray } from 'streamify-array';
import { ActorRdfMetadataExtractVord } from '../lib/ActorRdfMetadataExtractVord';
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

describe('ActorRdfMetadataExtractVord', () => {
  let bus: any;
  let context: IActionContext;
  let actor: ActorRdfMetadataExtractVord;

  const requestTime = 0;
  const url = 'https://example.org/sparql';

  beforeEach(() => {
    bus = new Bus({ name: 'bus' });
    context = new ActionContext();
    actor = new ActorRdfMetadataExtractVord({ name: 'actor', bus });
  });

  describe('test', () => {
    it('should test successfully', async() => {
      await expect(actor.test({ url, metadata: <any> undefined, requestTime, context })).resolves.toPassTestVoid();
    });
  });

  describe('run', () => {
    const service = DF.namedNode('https://example.org/sparql/service');
    const rateRestriction = DF.namedNode('https://example.org/sparql/rateRestriction');
    const resultRestriction = DF.namedNode('https://example.org/sparql/resultRestriction');
    const responseTimeRestriction = DF.namedNode('https://example.org/sparql/responseTimeRestriction');

    // Corresponds to the basic-service.ttl example of the VoRD vocabulary
    const basicServiceQuads = [
      DF.quad(service, RDF_TYPE, sd('Service')),
      DF.quad(service, sd('endpoint'), DF.namedNode(url)),
      DF.quad(service, sd('supportedLanguage'), sd('SPARQLQuery')),
      DF.quad(service, sd('feature'), sd('BasicFederatedQuery')),
      DF.quad(service, vord('hasRestriction'), rateRestriction),
      DF.quad(service, vord('hasRestriction'), resultRestriction),
      DF.quad(service, vord('hasRestriction'), responseTimeRestriction),

      DF.quad(rateRestriction, RDF_TYPE, vord('Restriction')),
      DF.quad(rateRestriction, RDF_TYPE, vord('RateRestriction')),
      DF.quad(rateRestriction, vord('metric'), vord('requestsPerWindow')),
      DF.quad(rateRestriction, vord('maxValue'), typed('60', 'integer')),
      DF.quad(rateRestriction, vord('burstValue'), typed('15', 'integer')),
      DF.quad(rateRestriction, vord('unit'), DF.namedNode('http://qudt.org/vocab/unit/COUNT')),
      DF.quad(rateRestriction, vord('windowDuration'), typed('PT1M', 'duration')),
      DF.quad(rateRestriction, vord('hasScope'), vord('PerClientIP')),
      DF.quad(rateRestriction, vord('enforcement'), vord('RejectRequest')),
      DF.quad(rateRestriction, vord('hardRestriction'), typed('true', 'boolean')),
      DF.quad(rateRestriction, vord('returnsStatusCode'), typed('429', 'integer')),
      DF.quad(rateRestriction, vord('retryAfterHint'), typed('PT30S', 'duration')),
      DF.quad(rateRestriction, vord('httpSignalHeader'), DF.namedNode('http://www.w3.org/2011/http-headers#retry-after')),

      DF.quad(resultRestriction, RDF_TYPE, vord('ResultSizeRestriction')),
      DF.quad(resultRestriction, RDF_TYPE, vord('Restriction')),
      DF.quad(resultRestriction, vord('metric'), vord('resultBindings')),
      DF.quad(resultRestriction, vord('maxValue'), typed('50000', 'integer')),
      DF.quad(resultRestriction, vord('hasScope'), vord('PerRequest')),
      DF.quad(resultRestriction, vord('enforcement'), vord('TruncateResult')),
      DF.quad(resultRestriction, vord('hardRestriction'), typed('true', 'boolean')),

      DF.quad(responseTimeRestriction, RDF_TYPE, vord('ResponseTimeRestriction')),
      DF.quad(responseTimeRestriction, vord('metric'), vord('evaluationTime')),
      DF.quad(responseTimeRestriction, vord('maxValue'), typed('600', 'integer')),
      DF.quad(responseTimeRestriction, vord('unit'), DF.namedNode('http://qudt.org/vocab/unit/SEC')),
      DF.quad(responseTimeRestriction, vord('enforcement'), vord('RejectRequest')),
      DF.quad(responseTimeRestriction, vord('hardRestriction'), typed('true', 'boolean')),
      DF.quad(responseTimeRestriction, vord('returnsStatusCode'), typed('503', 'integer')),
    ];

    const basicServiceRestrictions = [
      {
        type: 'rate',
        metric: `${VORD}requestsPerWindow`,
        maxValue: 60,
        burstValue: 15,
        unit: 'http://qudt.org/vocab/unit/COUNT',
        windowDuration: 60_000,
        scope: `${VORD}PerClientIP`,
        enforcement: 'reject',
        hardRestriction: true,
        returnsStatusCode: 429,
        retryAfterHint: 30_000,
        httpSignalHeader: 'retry-after',
      },
      {
        type: 'resultSize',
        metric: `${VORD}resultBindings`,
        maxValue: 50000,
        scope: `${VORD}PerRequest`,
        enforcement: 'truncate',
        hardRestriction: true,
      },
      {
        type: 'responseTime',
        metric: `${VORD}evaluationTime`,
        maxValue: 600,
        unit: 'http://qudt.org/vocab/unit/SEC',
        enforcement: 'reject',
        hardRestriction: true,
        returnsStatusCode: 503,
      },
    ];

    it('should parse the restrictions of a service whose endpoint is the requested URL', async() => {
      const metadata = streamifyArray([ ...basicServiceQuads ]);
      await expect(actor.run({ url, metadata, context, requestTime })).resolves.toEqual({
        metadata: { restrictions: basicServiceRestrictions },
      });
    });

    it('should parse the restrictions of a service identified by the requested URL', async() => {
      const metadata = streamifyArray([
        DF.quad(DF.namedNode(url), vord('hasRestriction'), resultRestriction),
        ...basicServiceQuads.filter(quad => quad.subject.equals(resultRestriction)),
        // A second service that does not apply
        DF.quad(service, vord('hasRestriction'), rateRestriction),
        ...basicServiceQuads.filter(quad => quad.subject.equals(rateRestriction)),
      ]);
      await expect(actor.run({ url, metadata, context, requestTime })).resolves.toEqual({
        metadata: { restrictions: [ basicServiceRestrictions[1] ]},
      });
    });

    it('should only use the restrictions of the service that applies to the requested URL', async() => {
      const otherService = DF.blankNode();
      const metadata = streamifyArray([
        ...basicServiceQuads,
        DF.quad(otherService, sd('endpoint'), DF.namedNode('https://example.org/other-sparql')),
        DF.quad(otherService, vord('hasRestriction'), DF.namedNode('https://example.org/other-restriction')),
        DF.quad(DF.namedNode('https://example.org/other-restriction'), RDF_TYPE, vord('QuotaRestriction')),
      ]);
      await expect(actor.run({ url, metadata, context, requestTime })).resolves.toEqual({
        metadata: { restrictions: basicServiceRestrictions },
      });
    });

    it('should use the restrictions of the only service if it does not apply to the requested URL', async() => {
      const metadata = streamifyArray([ ...basicServiceQuads ]);
      await expect(actor.run({ url: 'http://localhost:3000/sparql', metadata, context, requestTime }))
        .resolves.toEqual({
          metadata: { restrictions: basicServiceRestrictions },
        });
    });

    it('should not use restrictions if multiple services exist that do not apply to the requested URL', async() => {
      const metadata = streamifyArray([
        ...basicServiceQuads,
        DF.quad(DF.blankNode(), vord('hasRestriction'), resultRestriction),
      ]);
      await expect(actor.run({ url: 'http://localhost:3000/sparql', metadata, context, requestTime }))
        .resolves.toEqual({ metadata: {}});
    });

    it('should not emit restrictions if there are none', async() => {
      const metadata = streamifyArray([
        DF.quad(service, sd('endpoint'), DF.namedNode(url)),
        DF.quad(service, sd('feature'), sd('BasicFederatedQuery')),
      ]);
      await expect(actor.run({ url, metadata, context, requestTime })).resolves.toEqual({ metadata: {}});
    });

    it('should ignore restriction links without a description', async() => {
      const metadata = streamifyArray([
        DF.quad(service, sd('endpoint'), DF.namedNode(url)),
        DF.quad(service, vord('hasRestriction'), DF.namedNode('https://example.org/undescribed')),
      ]);
      await expect(actor.run({ url, metadata, context, requestTime })).resolves.toEqual({ metadata: {}});
    });

    it('should consider sd:feature links to typed restrictions', async() => {
      const restriction = DF.blankNode();
      const restrictionGeneric = DF.blankNode();
      const notRestriction = DF.blankNode();
      const metadata = streamifyArray([
        DF.quad(service, sd('endpoint'), DF.namedNode(url)),
        DF.quad(service, sd('feature'), restriction),
        DF.quad(service, sd('feature'), restrictionGeneric),
        DF.quad(service, sd('feature'), notRestriction),
        DF.quad(service, sd('feature'), sd('UnionDefaultGraph')),
        DF.quad(restriction, RDF_TYPE, vord('ConcurrentRequestsRestriction')),
        DF.quad(restriction, vord('maxValue'), typed('3', 'integer')),
        DF.quad(restrictionGeneric, RDF_TYPE, vord('Restriction')),
        DF.quad(restrictionGeneric, vord('metric'), vord('requestsPerDay')),
        DF.quad(restrictionGeneric, vord('maxValue'), typed('1000', 'integer')),
        DF.quad(notRestriction, RDF_TYPE, DF.namedNode('https://example.org/OtherFeature')),
      ]);
      await expect(actor.run({ url, metadata, context, requestTime })).resolves.toEqual({
        metadata: {
          restrictions: [
            { type: 'concurrentRequests', maxValue: 3 },
            {
              type: 'quota',
              metric: `${VORD}requestsPerDay`,
              maxValue: 1000,
              windowDuration: 24 * 60 * 60 * 1_000,
            },
          ],
        },
      });
    });

    it('should reject on stream errors', async() => {
      const metadata = new Readable();
      metadata._read = () => metadata.emit('error', new Error('metadata error'));
      await expect(actor.run({ url, metadata, context, requestTime })).rejects.toThrow('metadata error');
    });
  });

  describe('parseRestriction', () => {
    const restriction = DF.namedNode('https://example.org/restriction');

    it('should parse all properties', () => {
      expect(ActorRdfMetadataExtractVord.parseRestriction([
        DF.quad(restriction, RDF_TYPE, vord('CostModelRestriction')),
        DF.quad(restriction, vord('metric'), vord('estimatedCostUnits')),
        DF.quad(restriction, vord('maxValue'), typed('200000', 'integer')),
        DF.quad(restriction, vord('minValue'), typed('10', 'integer')),
        DF.quad(restriction, vord('costModel'), DF.namedNode('https://example.org/costModel')),
        DF.quad(restriction, vord('hasScope'), DF.namedNode('https://example.org/CustomScope')),
        DF.quad(restriction, vord('enforcement'), DF.namedNode('https://example.org/CustomEnforcement')),
        DF.quad(restriction, vord('hardRestriction'), typed('false', 'boolean')),
        DF.quad(restriction, vord('httpSignalHeader'), DF.literal('X-RateLimit-Remaining')),
        DF.quad(restriction, DF.namedNode('https://example.org/unknown'), DF.literal('unknown')),
      ])).toEqual({
        type: 'costModel',
        metric: `${VORD}estimatedCostUnits`,
        maxValue: 200000,
        minValue: 10,
        costModel: 'https://example.org/costModel',
        scope: 'https://example.org/CustomScope',
        enforcement: 'other',
        hardRestriction: false,
        httpSignalHeader: 'x-ratelimit-remaining',
      });
    });

    it.each([
      [ 'RateRestriction', 'rate' ],
      [ 'QuotaRestriction', 'quota' ],
      [ 'ResultSizeRestriction', 'resultSize' ],
      [ 'CostModelRestriction', 'costModel' ],
      [ 'ServerLoadRestriction', 'serverLoad' ],
      [ 'ConcurrentRequestsRestriction', 'concurrentRequests' ],
      [ 'ResponseTimeRestriction', 'responseTime' ],
    ])('should map class %s to type %s', (className, type) => {
      expect(ActorRdfMetadataExtractVord.parseRestriction([
        DF.quad(restriction, RDF_TYPE, vord(className)),
        DF.quad(restriction, RDF_TYPE, vord('Restriction')),
      ])).toEqual({ type });
    });

    it.each([
      [ 'requestsPerWindow', 'rate' ],
      [ 'resultBindings', 'resultSize' ],
      [ 'evaluationTime', 'responseTime' ],
      [ 'estimatedCostUnits', 'costModel' ],
    ])('should map metric %s to type %s if no specific class is given', (metric, type) => {
      expect(ActorRdfMetadataExtractVord.parseRestriction([
        DF.quad(restriction, RDF_TYPE, vord('Restriction')),
        DF.quad(restriction, vord('metric'), vord(metric)),
      ])).toEqual({ type, metric: `${VORD}${metric}` });
    });

    it('should fall back to type other for unknown metrics', () => {
      expect(ActorRdfMetadataExtractVord.parseRestriction([
        DF.quad(restriction, vord('metric'), DF.namedNode('https://example.org/customMetric')),
      ])).toEqual({ type: 'other', metric: 'https://example.org/customMetric' });
    });

    it('should fall back to type other without metric', () => {
      expect(ActorRdfMetadataExtractVord.parseRestriction([
        DF.quad(restriction, vord('maxValue'), typed('1', 'integer')),
      ])).toEqual({ type: 'other', maxValue: 1 });
    });

    it.each([
      [ 'RejectRequest', 'reject' ],
      [ 'TruncateResult', 'truncate' ],
      [ 'QueueRequest', 'queue' ],
      [ 'ThrottleResponse', 'throttle' ],
      [ 'DegradeQuality', 'degrade' ],
    ])('should map enforcement %s to %s', (enforcement, value) => {
      expect(ActorRdfMetadataExtractVord.parseRestriction([
        DF.quad(restriction, vord('enforcement'), vord(enforcement)),
      ])).toEqual({ type: 'other', enforcement: value });
    });

    it('should keep explicit windows for daily request counts', () => {
      expect(ActorRdfMetadataExtractVord.parseRestriction([
        DF.quad(restriction, vord('metric'), vord('requestsPerDay')),
        DF.quad(restriction, vord('windowDuration'), typed('PT12H', 'duration')),
      ])).toEqual({ type: 'quota', metric: `${VORD}requestsPerDay`, windowDuration: 12 * 60 * 60 * 1_000 });
    });

    it('should interpret 1 as a true hardRestriction', () => {
      expect(ActorRdfMetadataExtractVord.parseRestriction([
        DF.quad(restriction, vord('hardRestriction'), typed('1', 'boolean')),
      ])).toEqual({ type: 'other', hardRestriction: true });
    });

    it('should ignore invalid values', () => {
      expect(ActorRdfMetadataExtractVord.parseRestriction([
        DF.quad(restriction, vord('maxValue'), DF.literal('many')),
        DF.quad(restriction, vord('windowDuration'), DF.literal('one minute')),
      ])).toEqual({ type: 'other' });
    });
  });

  describe('parseDurationMilliseconds', () => {
    it.each([
      [ 'PT1M', 60_000 ],
      [ 'PT30S', 30_000 ],
      [ 'PT0.5S', 500 ],
      [ 'P1D', 24 * 60 * 60 * 1_000 ],
      [ 'P1Y2M3DT4H5M6S', ((((((365 + 60 + 3) * 24) + 4) * 60) + 5) * 60 + 6) * 1_000 ],
    ])('should parse %s', (value, expected) => {
      expect(ActorRdfMetadataExtractVord.parseDurationMilliseconds(value)).toBe(expected);
    });

    it.each([
      'invalid',
      '-PT1M',
      'PT0S',
    ])('should not parse %s', (value) => {
      expect(ActorRdfMetadataExtractVord.parseDurationMilliseconds(value)).toBeUndefined();
    });
  });

  describe('parseHeaderName', () => {
    it.each([
      [ 'an IRI with a fragment', DF.namedNode('http://www.w3.org/2011/http-headers#retry-after'), 'retry-after' ],
      [ 'an IRI with a path', DF.namedNode('https://example.org/headers/Retry-After'), 'retry-after' ],
      [ 'a literal', DF.literal('Retry-After'), 'retry-after' ],
    ])('should parse a header name from %s', (_, term, expected) => {
      expect(ActorRdfMetadataExtractVord.parseHeaderName(term)).toBe(expected);
    });
  });
});
