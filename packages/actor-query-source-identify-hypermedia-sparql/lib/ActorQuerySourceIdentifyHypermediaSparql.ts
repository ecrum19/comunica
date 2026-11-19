import type { MediatorHttp } from '@comunica/bus-http';
import type { MediatorMergeBindingsContext } from '@comunica/bus-merge-bindings-context';
import type { MediatorQuerySerialize } from '@comunica/bus-query-serialize';
import type {
  IActionQuerySourceIdentifyHypermedia,
  IActorQuerySourceIdentifyHypermediaOutput,
  IActorQuerySourceIdentifyHypermediaArgs,
  IActorQuerySourceIdentifyHypermediaTest,
} from '@comunica/bus-query-source-identify-hypermedia';
import {
  ActorQuerySourceIdentifyHypermedia,
} from '@comunica/bus-query-source-identify-hypermedia';
import { KeysInitQuery, KeysQueryOperation, KeysQuerySourceIdentify } from '@comunica/context-entries';
import type { TestResult } from '@comunica/core';
import { failTest, passTest } from '@comunica/core';
import type { ComunicaDataFactory, IActionContext, IEndpointRestriction } from '@comunica/types';
import { AlgebraFactory } from '@comunica/utils-algebra';
import { BindingsFactory } from '@comunica/utils-bindings-factory';
import { compareEndpointRestrictions, describeEndpointRestrictionComparison } from './EndpointRestrictionComparison';
import { QuerySourceSparql } from './QuerySourceSparql';

/**
 * A comunica SPARQL Query Source Identify Hypermedia Actor.
 */
export class ActorQuerySourceIdentifyHypermediaSparql extends ActorQuerySourceIdentifyHypermedia {
  public readonly mediatorHttp: MediatorHttp;
  public readonly mediatorMergeBindingsContext: MediatorMergeBindingsContext;
  public readonly mediatorQuerySerialize: MediatorQuerySerialize;
  public readonly checkUrlSuffix: boolean;
  public readonly forceHttpGet: boolean;
  public readonly cacheSize: number;
  public readonly forceSourceType: boolean;
  public readonly bindMethod: BindMethod;
  public readonly countTimeout: number;
  public readonly cardinalityCountQueries: boolean;
  public readonly cardinalityEstimateConstruction: boolean;
  public readonly forceGetIfUrlLengthBelow: number;
  public readonly sparqlServerSoftwarePatterns: RegExp[];
  public readonly restrictionAwarePlanning: boolean;

  public constructor(args: IActorQuerySourceIdentifyHypermediaSparqlArgs) {
    super(args, 'sparql');
    this.mediatorHttp = args.mediatorHttp;
    this.mediatorMergeBindingsContext = args.mediatorMergeBindingsContext;
    this.mediatorQuerySerialize = args.mediatorQuerySerialize;
    this.checkUrlSuffix = args.checkUrlSuffix;
    this.forceHttpGet = args.forceHttpGet;
    this.cacheSize = args.cacheSize;
    this.forceSourceType = Boolean(args.forceSourceType);
    this.bindMethod = args.bindMethod;
    this.countTimeout = args.countTimeout;
    this.cardinalityCountQueries = args.cardinalityCountQueries;
    this.cardinalityEstimateConstruction = args.cardinalityEstimateConstruction;
    this.forceGetIfUrlLengthBelow = args.forceGetIfUrlLengthBelow;
    this.sparqlServerSoftwarePatterns = (
      args.sparqlServerSoftwarePatterns ?? []
    ).map(pattern => new RegExp(pattern, 'u'));
    this.restrictionAwarePlanning = args.restrictionAwarePlanning;
  }

  public checkServerSoftware(serverSoftware?: string): boolean {
    if (!serverSoftware) {
      return false;
    }
    for (const regex of this.sparqlServerSoftwarePatterns) {
      if (regex.test(serverSoftware)) {
        return true;
      }
    }
    return false;
  }

  public async testMetadata(
    action: IActionQuerySourceIdentifyHypermedia,
  ): Promise<TestResult<IActorQuerySourceIdentifyHypermediaTest>> {
    if (!action.forceSourceType && !this.forceSourceType && !action.metadata.sparqlService &&
      !(this.checkUrlSuffix && (action.url.endsWith('/sparql') || action.url.endsWith('/sparql/'))) &&
        !this.checkServerSoftware(action.metadata.serverSoftware)) {
      return failTest(`Actor ${this.name} could not detect a SPARQL service description or URL ending on /sparql.`);
    }
    return passTest({ filterFactor: 1 });
  }

  public async run(action: IActionQuerySourceIdentifyHypermedia): Promise<IActorQuerySourceIdentifyHypermediaOutput> {
    this.logInfo(action.context, `Identified ${action.url} as sparql source with service URL: ${action.metadata.sparqlService || action.url}`);

    const dataFactory: ComunicaDataFactory = action.context.getSafe(KeysInitQuery.dataFactory);
    const algebraFactory = new AlgebraFactory(dataFactory);
    const isSingularSource = action.context.get(KeysQueryOperation.querySources)?.length === 1;
    const url = (action.forceSourceType ?? this.forceSourceType) ?
      action.url :
      action.metadata.sparqlService || action.url;

    // Restrictions that users provide for the endpoint replace the ones it advertises.
    let metadata = action.metadata;
    const providedRestrictions = ActorQuerySourceIdentifyHypermediaSparql
      .getProvidedRestrictions(action.context, [ url, action.url ]);
    if (providedRestrictions) {
      if (action.context.get(KeysQuerySourceIdentify.endpointRestrictionsMode) === 'compare') {
        this.logRestrictionComparison(action.context, url, providedRestrictions, action.metadata);
      }
      this.logInfo(action.context, `Using the restrictions provided for ${url} instead of the advertised ones`, () => ({
        restrictions: providedRestrictions,
      }));
      metadata = { ...metadata, restrictions: providedRestrictions };
    }

    const source = new QuerySourceSparql(
      url,
      // Pass the original URL as backup, as some endpoints misconfigure their endpoint URL in the service description.
      action.url,
      action.context,
      this.mediatorHttp,
      this.mediatorQuerySerialize,
      this.bindMethod,
      dataFactory,
      algebraFactory,
      await BindingsFactory.create(this.mediatorMergeBindingsContext, action.context, dataFactory),
      this.forceHttpGet,
      this.cacheSize,
      this.countTimeout,
      // Cardinalities can be infinity when we're querying just a single source.
      this.cardinalityCountQueries && !isSingularSource,
      this.cardinalityEstimateConstruction,
      this.forceGetIfUrlLengthBelow,
      Boolean(action.context.get(KeysInitQuery.parseUnsupportedVersions)),
      metadata,
      this.restrictionAwarePlanning,
    );
    return { source };
  }

  /**
   * Compare the restrictions that users provided for an endpoint with the ones it advertises,
   * and log whether they match (as info), or partially match or do not match (as warnings).
   * @param context The context.
   * @param url The URL of the endpoint.
   * @param providedRestrictions The provided restrictions.
   * @param metadata The metadata of the endpoint's service description, with the advertised restrictions.
   */
  public logRestrictionComparison(
    context: IActionContext,
    url: string,
    providedRestrictions: IEndpointRestriction[],
    metadata: Record<string, any>,
  ): void {
    // The request time is only known if the service description was read.
    if (!('requestTime' in metadata)) {
      this.logWarn(context, `The restrictions provided for ${url} could not be compared with the ones it advertises, because its service description could not be read`);
      return;
    }
    const comparison = compareEndpointRestrictions(providedRestrictions, metadata.restrictions ?? []);
    const message = describeEndpointRestrictionComparison(url, comparison);
    if (comparison.result === 'match') {
      this.logInfo(context, message, () => ({ comparison }));
    } else {
      this.logWarn(context, message, () => ({ comparison }));
    }
  }

  /**
   * Determine the restrictions that users provided for an endpoint in the endpointRestrictions context entry.
   * @param context The context.
   * @param urls The URLs by which the endpoint may be identified, in order of preference.
   * @return The provided restrictions, or undefined if none were provided for the endpoint.
   */
  public static getProvidedRestrictions(context: IActionContext, urls: string[]): IEndpointRestriction[] | undefined {
    const providedRestrictions = context.get(KeysQuerySourceIdentify.endpointRestrictionsResolved);
    if (providedRestrictions) {
      for (const url of urls) {
        const restrictions = providedRestrictions[ActorQuerySourceIdentifyHypermediaSparql.normalizeUrl(url)];
        if (restrictions) {
          return restrictions;
        }
      }
    }
    return undefined;
  }

  /**
   * Normalize a URL, so that equivalent URLs of the same endpoint match.
   * @param url A URL.
   */
  public static normalizeUrl(url: string): string {
    try {
      return new URL(url).href;
    } catch {
      return url;
    }
  }
}

export interface IActorQuerySourceIdentifyHypermediaSparqlArgs extends IActorQuerySourceIdentifyHypermediaArgs {
  /**
   * The HTTP mediator
   */
  mediatorHttp: MediatorHttp;
  /**
   * A mediator for creating binding context merge handlers
   */
  mediatorMergeBindingsContext: MediatorMergeBindingsContext;
  /**
   * Mediator for serializing queries.
   */
  mediatorQuerySerialize: MediatorQuerySerialize;
  /**
   * If URLs ending with '/sparql' should also be considered SPARQL endpoints.
   * @default {true}
   */
  checkUrlSuffix: boolean;
  /**
   * If non-update queries should be sent via HTTP GET instead of POST
   * @default {false}
   */
  forceHttpGet: boolean;
  /**
   * The cache size for COUNT queries.
   * @range {integer}
   * @default {1024}
   */
  cacheSize: number;
  /**
   * If provided, forces the source type of a source.
   * @default {false}
   */
  forceSourceType?: boolean;
  /**
   * The query operation for communicating bindings.
   * @default {values}
   */
  bindMethod: BindMethod;
  /**
   * Timeout in ms of how long count queries are allowed to take.
   * If the timeout is reached, an infinity cardinality is returned.
   * @default {3000}
   */
  countTimeout: number;
  /**
   * If count queries should be sent to obtain the cardinality of (sub)queries.
   * If set to false, resulting cardinalities will always be considered infinity.
   * @default {true}
   */
  cardinalityCountQueries: boolean;
  /**
   * If estimates for queries should be constructed locally from sub-query cardinalities.
   * If set to false, count queries will used for cardinality estimation at all levels.
   * @default {false}
   */
  cardinalityEstimateConstruction: boolean;
  /**
   * Force an HTTP GET instead of default POST (when forceHttpGet is false)
   * when the url length (including encoded query) is below this number.
   * @default {600}
   */
  forceGetIfUrlLengthBelow: number;
  /**
   * Regexes to match against the server header to identify SPARQL endpoints.
   */
  sparqlServerSoftwarePatterns?: string[];
  /**
   * If the restrictions that the endpoint advertises in its service description should be taken into account
   * when querying it: results are requested in pages if they would be truncated,
   * the minimal time between requests is exposed to the query planner,
   * and count queries are skipped if the rate limit would delay them beyond the count timeout.
   * @default {true}
   */
  restrictionAwarePlanning: boolean;
}

export type BindMethod = 'values' | 'union' | 'filter';
