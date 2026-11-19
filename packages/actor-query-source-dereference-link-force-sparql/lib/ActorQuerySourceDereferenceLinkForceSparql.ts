import type {
  IActionQuerySourceDereferenceLink,
  IActorQuerySourceDereferenceLinkOutput,
  IActorQuerySourceDereferenceLinkArgs,
} from '@comunica/bus-query-source-dereference-link';
import { ActorQuerySourceDereferenceLink } from '@comunica/bus-query-source-dereference-link';
import type { MediatorQuerySourceIdentifyHypermedia } from '@comunica/bus-query-source-identify-hypermedia';
import type { MediatorRdfMetadataAccumulate } from '@comunica/bus-rdf-metadata-accumulate';
import { KeysQueryOperation, KeysQuerySourceIdentify } from '@comunica/context-entries';
import type { TestResult, IActorTest } from '@comunica/core';
import { passTestVoid, failTest } from '@comunica/core';
import type { IActionContext, MetadataBindings } from '@comunica/types';
import { Readable } from 'readable-stream';

/**
 * A comunica Force SPARQL Query Source Hypermedia Resolve Actor.
 */
export class ActorQuerySourceDereferenceLinkForceSparql extends ActorQuerySourceDereferenceLink {
  public readonly mediatorMetadataAccumulate: MediatorRdfMetadataAccumulate;
  public readonly mediatorQuerySourceIdentifyHypermedia: MediatorQuerySourceIdentifyHypermedia;
  public readonly fetchServiceDescription: boolean;

  public constructor(args: IActorQuerySourceDereferenceLinkForceSparqlArgs) {
    super(args);
    this.mediatorMetadataAccumulate = args.mediatorMetadataAccumulate;
    this.mediatorQuerySourceIdentifyHypermedia = args.mediatorQuerySourceIdentifyHypermedia;
    this.fetchServiceDescription = Boolean(args.fetchServiceDescription);
  }

  public async test(action: IActionQuerySourceDereferenceLink): Promise<TestResult<IActorTest>> {
    // Users can provide the restrictions of endpoints (endpointRestrictions),
    // which determine whether the service description is needed.
    const forceSourceType = action.link.forceSourceType;
    if ((forceSourceType === undefined || forceSourceType === 'sparql') &&
      ActorQuerySourceDereferenceLinkForceSparql.hasProvidedRestrictions(action.context, action.link.url)) {
      const mode = action.context.get(KeysQuerySourceIdentify.endpointRestrictionsMode);
      if (mode === 'provided-only') {
        return passTestVoid();
      }
      if (mode === 'compare') {
        return failTest(`${this.name} lets the service description of ${action.link.url} be fetched, to compare its restrictions with the provided ones`);
      }
    }
    if (this.fetchServiceDescription) {
      return failTest(`${this.name} is configured to let the service description of SPARQL sources be fetched`);
    }
    if (forceSourceType === 'sparql' && action.context.get(KeysQueryOperation.querySources)?.length === 1) {
      return passTestVoid();
    }
    return failTest(`${this.name} can only handle a single forced SPARQL source, or SPARQL endpoints whose restrictions are provided with endpointRestrictionsMode provided-only`);
  }

  public async run(action: IActionQuerySourceDereferenceLink): Promise<IActorQuerySourceDereferenceLinkOutput> {
    const context = action.link.context ? action.context.merge(action.link.context) : action.context;
    if (action.context.get(KeysQuerySourceIdentify.endpointRestrictionsMode) === 'provided-only' &&
      ActorQuerySourceDereferenceLinkForceSparql.hasProvidedRestrictions(action.context, action.link.url)) {
      this.logInfo(context, `Not fetching the service description of ${action.link.url}, as only the restrictions provided for it are used`);
    }

    // No need to do metadata extraction if we're querying over just a single SPARQL endpoint,
    // or over an endpoint whose restrictions are provided and whose service description should not be fetched.
    const quads: Readable = new Readable();
    quads._read = () => {
      quads.push(null);
      return null;
    };
    const metadata: Record<string, any> = (await this.mediatorMetadataAccumulate
      .mediate({ context: action.context, mode: 'initialize' })).metadata;

    // Determine the source
    const { source, dataset } = await this.mediatorQuerySourceIdentifyHypermedia.mediate({
      context,
      forceSourceType: 'sparql',
      handledDatasets: action.handledDatasets,
      metadata,
      quads,
      url: action.link.url,
    });

    return { source, metadata: <MetadataBindings> metadata, dataset };
  }

  /**
   * Check if users provided restrictions for an endpoint in the endpointRestrictions context entry.
   * Only the URL by which the endpoint is queried is checked, as the service description is not known here.
   * URLs are normalized in the same way as in @comunica/actor-context-preprocess-endpoint-restrictions.
   * @param context The context.
   * @param url The URL of the endpoint.
   */
  public static hasProvidedRestrictions(context: IActionContext, url: string): boolean {
    const providedRestrictions = context.get(KeysQuerySourceIdentify.endpointRestrictionsResolved);
    if (!providedRestrictions) {
      return false;
    }
    let normalizedUrl = url;
    try {
      normalizedUrl = new URL(url).href;
    } catch {
      // Keep URLs that cannot be parsed as they are.
    }
    return providedRestrictions[normalizedUrl] !== undefined;
  }
}

export interface IActorQuerySourceDereferenceLinkForceSparqlArgs extends IActorQuerySourceDereferenceLinkArgs {
  /**
   * The metadata accumulate mediator
   */
  mediatorMetadataAccumulate: MediatorRdfMetadataAccumulate;
  /**
   * The hypermedia resolve mediator
   */
  mediatorQuerySourceIdentifyHypermedia: MediatorQuerySourceIdentifyHypermedia;
  /**
   * If the service description of a single forced SPARQL source should still be fetched,
   * e.g. to discover the restrictions of the endpoint.
   * If enabled, this actor only handles endpoints whose restrictions are provided with endpointRestrictionsMode
   * provided-only, so that other actors fetch the service description.
   * @default {false}
   */
  fetchServiceDescription?: boolean;
}
