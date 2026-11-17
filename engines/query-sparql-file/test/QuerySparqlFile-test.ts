/** @jest-environment setup-polly-jest/jest-environment-node */

import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { QueryStringContext } from '@comunica/types';
import 'jest-rdf';
import { BindingsFactory } from '@comunica/utils-bindings-factory';
import arrayifyStream from 'arrayify-stream';
import { DataFactory } from 'rdf-data-factory';
import '@comunica/utils-jest';
import { QueryEngine } from '../lib/QueryEngine';

const DF = new DataFactory();
const BF = new BindingsFactory(DF);

describe('System test: QuerySparqlFile', () => {
  let engine: QueryEngine;

  beforeEach(() => {
    engine = new QueryEngine();
  });

  describe('query', () => {
    describe('simple SPO on a raw RDF document', () => {
      it('should return a result for a jsonld file by a relative file path', async() => {
        const p = path.join(path.relative(process.cwd(), __dirname), 'assets/dummy.jsonld');
        const query = `SELECT * WHERE { ?s ?p ?o. }`;
        const context: QueryStringContext = { sources: [{ value: p }]};

        const result = await arrayifyStream(await engine.queryBindings(query, context));
        expect(result).toHaveLength(2);
      });

      it('should return a result for a ttl file by a relative file path using fileBaseIRI', async() => {
        const p = path.join(path.relative(process.cwd(), __dirname), 'assets/dummy.ttl');
        const query = `
PREFIX foaf: <http://xmlns.com/foaf/0.1/>

SELECT ?person ?name
WHERE {
  <data/Alice> foaf:knows ?person .
  ?person a <data/Person> ;
          foaf:name ?name .
}
        `;
        const baseIRI = 'http://example.org/';
        const fileBaseIRI = 'http://example.org/data/';
        const context: QueryStringContext = { sources: [{ value: p }], baseIRI, fileBaseIRI };

        const expectedResult = [
          BF.bindings([
            [ DF.variable('name'), DF.literal('Bob', DF.namedNode('http://www.w3.org/2001/XMLSchema#string')) ],
            [ DF.variable('person'), DF.namedNode(`${fileBaseIRI}Bob`) ],
          ]),
        ];

        const result = await arrayifyStream(await engine.queryBindings(query, context));
        expect(result).toEqualBindingsArray(expectedResult);
      });
    });

    describe('SERVICE clauses targeting files', () => {
      let source: string;
      let serviceTarget: string;
      let query: string;

      beforeEach(() => {
        source = path.join(path.relative(process.cwd(), __dirname), 'assets/dummy.ttl');
        serviceTarget = pathToFileURL(path.join(__dirname, 'assets/dummy.jsonld')).href;
        query = `SELECT * WHERE { SERVICE <${serviceTarget}> { ?s ?p ?o. } }`;
      });

      it('should not be allowed by default', async() => {
        const context: QueryStringContext = { sources: [{ value: source }]};
        await expect(async() => arrayifyStream(await engine.queryBindings(query, context))).rejects
          .toThrow(`Dereferencing the local file '${serviceTarget}' is not allowed within this scope.`);
      });

      it('should produce no results by default when silent', async() => {
        const querySilent = `SELECT * WHERE { SERVICE SILENT <${serviceTarget}> { ?s ?p ?o. } }`;
        const context: QueryStringContext = { sources: [{ value: source }]};
        await expect(arrayifyStream(await engine.queryBindings(querySilent, context))).resolves.toHaveLength(0);
      });

      it('should be allowed with serviceAllowFileTargets', async() => {
        const context: QueryStringContext = { sources: [{ value: source }], serviceAllowFileTargets: true };
        await expect(arrayifyStream(await engine.queryBindings(query, context))).resolves.toHaveLength(2);
      });

      it('should not block file sources that are passed as query sources', async() => {
        const queryCombined = `SELECT * WHERE {
          ?s ?p ?o.
          OPTIONAL { SERVICE SILENT <${serviceTarget}> { ?s2 ?p2 ?o2. } }
        }`;
        const context: QueryStringContext = { sources: [{ value: source }]};
        await expect(arrayifyStream(await engine.queryBindings(queryCombined, context))).resolves.toHaveLength(5);
      });
    });

    describe('joins over a union whose inputs share a term order', () => {
      it('should merge-join the union', async() => {
        const context: QueryStringContext = {
          sources: [{ value: path.join(path.relative(process.cwd(), __dirname), 'assets/ordered.ttl') }],
        };
        const query = `SELECT * WHERE {
          { ?s <http://ex/p0> ?o } UNION { ?s <http://ex/p1> ?o }
          ?s <http://ex/q> ?x
        }`;
        await expect(arrayifyStream(await engine.queryBindings(query, context))).resolves.toHaveLength(20);
        const { data } = await new QueryEngine().explain(query, context, 'physical');
        expect(data).toContain('join-inner(merge)');
      });

      it('should merge-join a filtered union', async() => {
        const context: QueryStringContext = {
          sources: [{ value: path.join(path.relative(process.cwd(), __dirname), 'assets/ordered.ttl') }],
        };
        const query = `SELECT * WHERE {
          { { ?s <http://ex/p0> ?o } UNION { ?s <http://ex/p1> ?o } FILTER(?o != <http://ex/none>) }
          ?s <http://ex/q> ?x
        }`;
        await expect(arrayifyStream(await engine.queryBindings(query, context))).resolves.toHaveLength(20);
        const { data } = await new QueryEngine().explain(query, context, 'physical');
        expect(data).toContain('join-inner(merge)');
      });

      it('should multi-merge-join the union with other patterns', async() => {
        const context: QueryStringContext = {
          sources: [{ value: path.join(path.relative(process.cwd(), __dirname), 'assets/ordered.ttl') }],
        };
        const query = `SELECT * WHERE {
          { ?s <http://ex/p0> ?o } UNION { ?s <http://ex/p1> ?o }
          ?s <http://ex/q> ?x .
          ?s <http://ex/r> ?y .
        }`;
        await expect(arrayifyStream(await engine.queryBindings(query, context))).resolves.toHaveLength(20);
        const { data } = await new QueryEngine().explain(query, context, 'physical');
        expect(data).toContain('join-inner(multi-merge)');
      });
    });

    describe('joins over operators that do not keep the term order of their input', () => {
      let context: QueryStringContext;

      beforeEach(() => {
        context = { sources: [{ value: path.join(path.relative(process.cwd(), __dirname), 'assets/ordered.ttl') }]};
      });

      it('should join a union', async() => {
        const query = `SELECT * WHERE {
          { ?s <http://ex/p0> ?o } UNION { ?s <http://ex/p1> ?o }
          ?s <http://ex/q> ?x
        }`;
        await expect(arrayifyStream(await engine.queryBindings(query, context))).resolves.toHaveLength(20);
      });

      it('should join an order by', async() => {
        const query = `SELECT * WHERE {
          { SELECT ?s ?o WHERE { ?s <http://ex/p0> ?o } ORDER BY DESC(?s) }
          ?s <http://ex/q> ?x
        }`;
        await expect(arrayifyStream(await engine.queryBindings(query, context))).resolves.toHaveLength(10);
      });
    });

    it('should join patterns that share their subject and object', async() => {
      const context: QueryStringContext = {
        sources: [{ value: path.join(path.relative(process.cwd(), __dirname), 'assets/shared-objects.ttl') }],
      };
      const query = `SELECT * WHERE {
        ?s <http://ex/r1> ?o .
        ?s <http://ex/r2> ?o .
        ?s <http://ex/r3> ?o .
      }`;
      const bindings = await arrayifyStream(await engine.queryBindings(query, context));
      expect(bindings.map(binding => `${binding.get('s')!.value} ${binding.get('o')!.value}`).sort()).toEqual([
        'http://ex/s0 http://ex/o3',
        'http://ex/s0 http://ex/o5',
        'http://ex/s1 http://ex/o3',
        'http://ex/s1 http://ex/o5',
      ]);
    });
  });

  describe('endpoint restrictions', () => {
    it('should respect restrictions provided in a local VoRD description', async() => {
      // An endpoint that truncates every response to 2 results, out of 5.
      const queries: string[] = [];
      const fetch = async(input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const query = init?.body ?
          new URLSearchParams(String(init.body)).get('query')! :
          new URL(input instanceof Request ? input.url : String(input)).searchParams.get('query')!;
        queries.push(query);
        const offset = Number(/OFFSET (\d+)/u.exec(query)?.[1] ?? 0);
        const bindings = [];
        for (let i = offset; i < Math.min(5, offset + 2); i++) {
          bindings.push({ o: { type: 'uri', value: `http://example.org/o${i}` }});
        }
        return new Response(
          JSON.stringify({ head: { vars: [ 'o' ]}, results: { bindings }}),
          { status: 200, headers: { 'Content-Type': 'application/sparql-results+json' }},
        );
      };
      const context: QueryStringContext = {
        sources: [{ type: 'sparql', value: 'http://restricted.example.org/sparql' }],
        fetch,
        endpointRestrictions: {
          'http://restricted.example.org/sparql':
            path.join(path.relative(process.cwd(), __dirname), 'assets/vord-restrictions.ttl'),
        },
      };
      const query = 'SELECT ?o WHERE { <http://example.org/s> <http://example.org/p> ?o }';

      const bindings = await arrayifyStream(await engine.queryBindings(query, context));
      expect(bindings).toHaveLength(5);
      expect(queries).toHaveLength(3);
    });
  });
});
