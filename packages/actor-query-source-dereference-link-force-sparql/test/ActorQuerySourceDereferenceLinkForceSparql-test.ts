import type {
  IActionQuerySourceIdentifyHypermedia,
  MediatorQuerySourceIdentifyHypermedia,
} from '@comunica/bus-query-source-identify-hypermedia';
import type {
  IActionRdfMetadataAccumulate,
  IActorRdfMetadataAccumulateOutput,
  MediatorRdfMetadataAccumulate,
} from '@comunica/bus-rdf-metadata-accumulate';
import { KeysCore, KeysQueryOperation, KeysQuerySourceIdentify } from '@comunica/context-entries';
import { ActionContext, Bus } from '@comunica/core';
import type { IQuerySource } from '@comunica/types';
import arrayifyStream from 'arrayify-stream';
import { ActorQuerySourceDereferenceLinkForceSparql } from '../lib/ActorQuerySourceDereferenceLinkForceSparql';
import '@comunica/utils-jest';

const CANNOT_HANDLE = 'actor can only handle a single forced SPARQL source, ' +
  'or SPARQL endpoints whose restrictions are provided with endpointRestrictionsMode provided-only';

describe('ActorQuerySourceDereferenceLinkForceSparql', () => {
  let bus: any;
  let mediatorMetadataAccumulate: MediatorRdfMetadataAccumulate;
  let mediatorQuerySourceIdentifyHypermedia: MediatorQuerySourceIdentifyHypermedia;

  beforeEach(() => {
    bus = new Bus({ name: 'bus' });
    mediatorMetadataAccumulate = <MediatorRdfMetadataAccumulate>{
      async mediate(action: IActionRdfMetadataAccumulate): Promise<IActorRdfMetadataAccumulateOutput> {
        if (action.mode === 'initialize') {
          return {
            metadata: {
              cardinality: { type: 'exact', value: 0 },
            },
          };
        }
        return { metadata: { ...action.accumulatedMetadata, ...action.appendingMetadata }};
      },
    };
    mediatorQuerySourceIdentifyHypermedia = <MediatorQuerySourceIdentifyHypermedia> {
      async mediate(input: IActionQuerySourceIdentifyHypermedia) {
        await arrayifyStream(input.quads);
        return {
          dataset: 'MYDATASET',
          source: <IQuerySource> <any> 'QUERYSOURCE',
        };
      },
    };
  });

  describe('An ActorQuerySourceDereferenceLinkForceSparql instance', () => {
    let actor: ActorQuerySourceDereferenceLinkForceSparql;

    beforeEach(() => {
      actor = new ActorQuerySourceDereferenceLinkForceSparql({
        name: 'actor',
        bus,
        mediatorMetadataAccumulate,
        mediatorQuerySourceIdentifyHypermedia,
      });
    });

    describe('test', () => {
      it('should pass for a SPARQL endpoint', async() => {
        await expect(actor.test({
          link: { url: 'URL', forceSourceType: 'sparql' },
          context: new ActionContext()
            .set(KeysQueryOperation.querySources, [ <any> 'abc' ]),
        })).resolves.toPassTestVoid();
      });

      it('should not pass for a SPARQL endpoint if service descriptions must be fetched', async() => {
        actor = new ActorQuerySourceDereferenceLinkForceSparql({
          name: 'actor',
          bus,
          mediatorMetadataAccumulate,
          mediatorQuerySourceIdentifyHypermedia,
          fetchServiceDescription: true,
        });
        await expect(actor.test({
          link: { url: 'URL', forceSourceType: 'sparql' },
          context: new ActionContext()
            .set(KeysQueryOperation.querySources, [ <any> 'abc' ]),
        })).resolves.toFailTest('actor is configured to let the service description of SPARQL sources be fetched');
      });

      it('should not pass for multiple sources', async() => {
        await expect(actor.test({
          link: { url: 'URL', forceSourceType: 'sparql' },
          context: new ActionContext()
            .set(KeysQueryOperation.querySources, [ <any> 'abc', 'def' ]),
        })).resolves.toFailTest(CANNOT_HANDLE);
      });

      it('should not pass for a file source', async() => {
        await expect(actor.test({
          link: { url: 'URL', forceSourceType: 'file' },
          context: new ActionContext()
            .set(KeysQueryOperation.querySources, [ <any> 'abc' ]),
        })).resolves.toFailTest(CANNOT_HANDLE);
      });

      describe('with provided endpoint restrictions', () => {
        const url = 'http://example.org/sparql';
        const withRestrictions = (mode?: string, sources = [ 'abc', 'def' ]) => {
          let context = new ActionContext()
            .set(KeysQueryOperation.querySources, <any> sources)
            .set(KeysQuerySourceIdentify.endpointRestrictionsResolved, { [url]: []});
          if (mode) {
            context = context.set(KeysQuerySourceIdentify.endpointRestrictionsMode, <any> mode);
          }
          return context;
        };

        it('should pass for any number of sources in the provided-only mode', async() => {
          await expect(actor.test({ link: { url }, context: withRestrictions('provided-only') }))
            .resolves.toPassTestVoid();
          const link = { url: 'HTTP://EXAMPLE.ORG/sparql', forceSourceType: 'sparql' };
          await expect(actor.test({ link, context: withRestrictions('provided-only') }))
            .resolves.toPassTestVoid();
        });

        it('should pass in the provided-only mode if service descriptions must be fetched', async() => {
          actor = new ActorQuerySourceDereferenceLinkForceSparql({
            name: 'actor',
            bus,
            mediatorMetadataAccumulate,
            mediatorQuerySourceIdentifyHypermedia,
            fetchServiceDescription: true,
          });
          await expect(actor.test({ link: { url }, context: withRestrictions('provided-only') }))
            .resolves.toPassTestVoid();
        });

        it('should not pass in the provided-only mode for other endpoints and other source types', async() => {
          await expect(actor.test({ link: { url: `${url}/other` }, context: withRestrictions('provided-only') }))
            .resolves.toFailTest(CANNOT_HANDLE);
          const fileLink = { url, forceSourceType: 'file' };
          await expect(actor.test({ link: fileLink, context: withRestrictions('provided-only') }))
            .resolves.toFailTest(CANNOT_HANDLE);
        });

        it('should not pass in the compare mode, also for a single forced SPARQL source', async() => {
          const context = withRestrictions('compare', [ 'abc' ]);
          await expect(actor.test({ link: { url, forceSourceType: 'sparql' }, context }))
            .resolves.toFailTest(`actor lets the service description of ${url} be fetched, to compare its restrictions with the provided ones`);
        });

        it('should behave as without provided restrictions in the replace mode', async() => {
          const context = withRestrictions(undefined, [ 'abc' ]);
          await expect(actor.test({ link: { url, forceSourceType: 'sparql' }, context }))
            .resolves.toPassTestVoid();
          await expect(actor.test({ link: { url }, context: withRestrictions('replace') }))
            .resolves.toFailTest(CANNOT_HANDLE);
        });

        it('should find restrictions provided for URLs that cannot be parsed', async() => {
          const context = new ActionContext()
            .set(KeysQuerySourceIdentify.endpointRestrictionsResolved, { 'not a URL': []});
          const { hasProvidedRestrictions } = ActorQuerySourceDereferenceLinkForceSparql;
          expect(hasProvidedRestrictions(context, 'not a URL')).toBe(true);
          expect(hasProvidedRestrictions(context, 'other')).toBe(false);
          expect(hasProvidedRestrictions(new ActionContext(), 'other')).toBe(false);
        });
      });
    });

    describe('run', () => {
      it('should resolve', async() => {
        const { source, metadata, dataset } = await actor.run({
          link: { url: 'startUrl' },
          context: new ActionContext(),
        });
        expect(source).toBe('QUERYSOURCE');
        expect(metadata).toEqual({ cardinality: { type: 'exact', value: 0 }});
        expect(dataset).toBe('MYDATASET');
      });

      it('should identify an endpoint with provided restrictions as a SPARQL endpoint without fetching it', async() => {
        const logger: any = { info: jest.fn() };
        const mediate = jest.spyOn(mediatorQuerySourceIdentifyHypermedia, 'mediate');
        const { source } = await actor.run({
          link: { url: 'http://example.org/sparql' },
          context: new ActionContext()
            .set(KeysCore.log, logger)
            .set(KeysQuerySourceIdentify.endpointRestrictionsMode, 'provided-only')
            .set(KeysQuerySourceIdentify.endpointRestrictionsResolved, { 'http://example.org/sparql': []}),
        });
        expect(source).toBe('QUERYSOURCE');
        expect(mediate)
          .toHaveBeenCalledWith(expect.objectContaining({ forceSourceType: 'sparql', url: 'http://example.org/sparql' }));
        expect(logger.info).toHaveBeenCalledWith(
          'Not fetching the service description of http://example.org/sparql, as only the restrictions provided for it are used',
          expect.anything(),
        );
      });

      it('should resolve with a link context', async() => {
        const { source, metadata, dataset } = await actor.run({
          link: { url: 'startUrl', context: new ActionContext() },
          context: new ActionContext(),
        });
        expect(source).toBe('QUERYSOURCE');
        expect(metadata).toEqual({ cardinality: { type: 'exact', value: 0 }});
        expect(dataset).toBe('MYDATASET');
      });
    });
  });
});
