import type { MediatorHttp } from '@comunica/bus-http';
import type { MediatorQuerySerialize } from '@comunica/bus-query-serialize';
import { KeysHttp, KeysInitQuery } from '@comunica/context-entries';
import { Actor } from '@comunica/core';
import type {
  Bindings,
  BindingsStream,
  ComunicaDataFactory,
  FragmentSelectorShape,
  IActionContext,
  IDataset,
  IEndpointRestriction,
  IPhysicalQueryPlanNode,
  IQueryBindingsOptions,
  IQuerySource,
  MetadataBindings,
  MetadataVariable,
  QueryResultCardinality,
} from '@comunica/types';
import type { AlgebraFactory } from '@comunica/utils-algebra';
import { Algebra, algebraUtils, isKnownOperation } from '@comunica/utils-algebra';
import type { BindingsFactory } from '@comunica/utils-bindings-factory';
import { MetadataValidationState } from '@comunica/utils-metadata';
import {
  estimateCardinality,
  getOperationEquivalentQueryString,
  getOriginalSparqlQueryString,
} from '@comunica/utils-query-operation';
import type * as RDF from '@rdfjs/types';
import type { AsyncIterator } from 'asynciterator';
import { BufferedIterator, TransformIterator, wrap } from 'asynciterator';
import type { ISparqlEndpointFetcherRequestOptions } from 'fetch-sparql-endpoint';
import { SparqlEndpointFetcher } from 'fetch-sparql-endpoint';
import { LRUCache } from 'lru-cache';
import { uniqTerms } from 'rdf-terms';
import type { BindMethod } from './ActorQuerySourceIdentifyHypermediaSparql';

export class QuerySourceSparql implements IQuerySource {
  /**
   * The query format that endpoints advertise via the `Accept-Query` header when they support HTTP QUERY (RFC 10008).
   */
  public static readonly MEDIATYPE_SPARQL_QUERY = 'application/sparql-query';

  public readonly referenceValue: string;
  private url: string;
  private readonly urlBackup: string;
  private readonly context: IActionContext;
  private readonly mediatorHttp: MediatorHttp;
  private readonly mediatorQuerySerialize: MediatorQuerySerialize;
  private readonly bindMethod: BindMethod;
  private readonly countTimeout: number;
  private readonly cardinalityCountQueries: boolean;
  private readonly cardinalityEstimateConstruction: boolean;
  private readonly defaultGraph?: string;
  private readonly unionDefaultGraph: boolean;
  private readonly propertyFeatures?: Set<string>;
  private readonly datasets?: IDataset[];
  public readonly extensionFunctions?: string[];
  private readonly dataFactory: ComunicaDataFactory;
  private readonly algebraFactory: AlgebraFactory;
  private readonly bindingsFactory: BindingsFactory;
  private readonly restrictions?: IEndpointRestriction[];
  private readonly resultLimit?: number;
  private readonly requestInterval?: number;

  private readonly endpointFetcher: SparqlEndpointFetcher;
  private readonly cache: LRUCache<string, QueryResultCardinality> | undefined;

  /**
   * The number of HTTP requests made for each physical query plan node.
   */
  private readonly httpRequestsByPlanNode = new WeakMap<IPhysicalQueryPlanNode, number>();
  private httpQueryMethodRejected = false;

  public constructor(
    url: string,
    urlBackup: string,
    context: IActionContext,
    mediatorHttp: MediatorHttp,
    mediatorQuerySerialize: MediatorQuerySerialize,
    bindMethod: BindMethod,
    dataFactory: ComunicaDataFactory,
    algebraFactory: AlgebraFactory,
    bindingsFactory: BindingsFactory,
    forceHttpGet: boolean,
    cacheSize: number,
    countTimeout: number,
    cardinalityCountQueries: boolean,
    cardinalityEstimateConstruction: boolean,
    forceGetIfUrlLengthBelow: number,
    parseUnsupportedVersions: boolean,
    metadata: Record<string, any>,
    restrictionAwarePlanning = true,
  ) {
    this.referenceValue = urlBackup;
    this.url = url;
    this.urlBackup = urlBackup;
    this.context = context;
    this.mediatorHttp = mediatorHttp;
    this.mediatorQuerySerialize = mediatorQuerySerialize;
    this.bindMethod = bindMethod;
    this.dataFactory = dataFactory;
    this.algebraFactory = algebraFactory;
    this.bindingsFactory = bindingsFactory;

    // Endpoints advertise support for the HTTP QUERY method (RFC 10008) via the Accept-Query header,
    // which lets us send the query in the request body without the side effects of a POST.
    let method: 'GET' | 'POST' | 'QUERY' = 'POST';
    if (forceHttpGet) {
      method = 'GET';
    } else if (metadata.queryAccepted?.includes(QuerySourceSparql.MEDIATYPE_SPARQL_QUERY)) {
      method = 'QUERY';
    }

    this.endpointFetcher = new SparqlEndpointFetcher({
      method,
      prefixVariableQuestionMark: true,
      dataFactory,
      forceGetIfUrlLengthBelow,
      directPost: metadata.postAccepted && !metadata.postAccepted.includes('application/x-www-form-urlencoded'),
      parseUnsupportedVersions,
    });
    this.cache = cacheSize > 0 ?
      new LRUCache<string, QueryResultCardinality>({ max: cacheSize }) :
      undefined;
    this.countTimeout = countTimeout;
    this.cardinalityCountQueries = cardinalityCountQueries;
    this.cardinalityEstimateConstruction = cardinalityEstimateConstruction;
    this.defaultGraph = metadata.defaultGraph;
    this.unionDefaultGraph = metadata.unionDefaultGraph ?? false;
    this.datasets = metadata.datasets;
    this.extensionFunctions = metadata.extensionFunctions;
    this.propertyFeatures = metadata.propertyFeatures ? new Set(metadata.propertyFeatures) : undefined;
    if (metadata.restrictions?.length > 0) {
      this.restrictions = metadata.restrictions;
      if (restrictionAwarePlanning) {
        this.resultLimit = QuerySourceSparql.getResultLimit(metadata.restrictions);
        this.requestInterval = QuerySourceSparql.getRequestInterval(metadata.restrictions);
      }
    }
  }

  /**
   * Determine the maximum number of results that the endpoint returns per request,
   * based on its result size restrictions.
   * @param restrictions The restrictions of the endpoint.
   * @return The maximum number of results, or undefined if unrestricted.
   */
  public static getResultLimit(restrictions: IEndpointRestriction[]): number | undefined {
    const limits = restrictions
      .filter(restriction => restriction.type === 'resultSize' && restriction.maxValue && restriction.maxValue > 0)
      .map(restriction => restriction.maxValue!);
    return limits.length > 0 ? Math.min(...limits) : undefined;
  }

  /**
   * Determine the minimal average interval between requests to the endpoint in milliseconds,
   * based on its rate and quota restrictions.
   * @param restrictions The restrictions of the endpoint.
   * @return The interval, or undefined if unrestricted.
   */
  public static getRequestInterval(restrictions: IEndpointRestriction[]): number | undefined {
    const intervals = restrictions
      .filter(restriction => (restriction.type === 'rate' || restriction.type === 'quota') &&
        restriction.maxValue && restriction.maxValue > 0 && restriction.windowDuration)
      .map(restriction => restriction.windowDuration! / restriction.maxValue!);
    return intervals.length > 0 ? Math.max(...intervals) : undefined;
  }

  /**
   * Create the options for requests to the endpoint on behalf of the given context,
   * so that each request is sent with the context of the query that issued it.
   * @param context The context of the query operation for which requests are sent.
   */
  protected getRequestOptions(context: IActionContext): ISparqlEndpointFetcherRequestOptions {
    return { fetch: (input: Request | string, init?: RequestInit) => this.fetch(input, init, context) };
  }

  /**
   * Send an HTTP request to the endpoint.
   * @param input The request input.
   * @param init The request options.
   * @param context The context of the query operation for which the request is sent.
   */
  protected async fetch(input: Request | string, init: RequestInit | undefined, context: IActionContext):
  Promise<Response> {
    // The advertisement may be stale, or an intermediary may not know the method,
    // in which case we permanently fall back to a direct POST, which carries an identical body.
    if (this.httpQueryMethodRejected && init?.method === 'QUERY') {
      init = { ...init, method: 'POST' };
    }

    // Pass the restrictions of the endpoint, so that they can be respected when sending requests.
    if (this.restrictions) {
      context = context.set(KeysHttp.endpointRestrictions, this.restrictions);
    }

    this.countHttpRequest(context);
    let response = await this.mediatorHttp.mediate({ input, init, context });
    // If we encounter a 404, try our backup URL.
    // After retrying the request with the new URL, we replace the URL for future requests.
    if (response.status === 404 && this.url !== this.urlBackup) {
      Actor.getContextLogger(this.context)?.warn(`Encountered a 404 when requesting ${this.url} according to the service description of ${this.urlBackup}. This is a server configuration issue. Retrying the current and modifying future requests to ${this.urlBackup} instead.`);
      input = (<string> input).replace(this.url, this.urlBackup);
      this.url = this.urlBackup;
      this.countHttpRequest(context);
      response = await this.mediatorHttp.mediate({ input, init, context });
    }

    if (init?.method === 'QUERY' && (response.status === 405 || response.status === 501)) {
      Actor.getContextLogger(this.context)?.warn(`Encountered a ${response.status} for an HTTP QUERY request to ${this.url}, even though it advertises support for it via the Accept-Query header. Retrying the current and modifying future requests to use POST instead.`);
      this.httpQueryMethodRejected = true;
      this.countHttpRequest(context);
      response = await this.mediatorHttp.mediate({ input, init: { ...init, method: 'POST' }, context });
    }

    return response;
  }

  public async getFilterFactor(): Promise<number> {
    return 1;
  }

  public async getSelectorShape(): Promise<FragmentSelectorShape> {
    const innerDisjunction: FragmentSelectorShape = {
      type: 'disjunction',
      children: [
        {
          type: 'operation',
          operation: { operationType: 'wildcard' },
          joinBindings: true,
        },
      ],
    };
    if (this.extensionFunctions) {
      innerDisjunction.children.push({
        type: 'operation',
        operation: {
          operationType: 'type',
          type: Algebra.Types.EXPRESSION,
          extensionFunctions: this.extensionFunctions,
        },
        joinBindings: true,
      });
    }
    return {
      type: 'conjunction',
      children: [
        innerDisjunction,
        {
          // DISTINCT CONSTRUCT is not allowed in SPARQL 1.1, so we explicitly disallowed it.
          type: 'negation',
          child: {
            type: 'operation',
            operation: { operationType: 'type', type: Algebra.Types.DISTINCT },
            children: [
              {
                type: 'operation',
                operation: { operationType: 'type', type: Algebra.Types.CONSTRUCT },
                children: [
                  {
                    type: 'operation',
                    operation: { operationType: 'wildcard' },
                    joinBindings: true,
                  },
                ],
              },
            ],
          },
        },
      ],
    };
  }

  /**
   * Report the query that is sent to the endpoint to the physical query plan, if one is being logged.
   * @param context The context of the current operation.
   * @param query The query that is sent to the endpoint.
   */
  protected reportSourceQuery(context: IActionContext, query: string): void {
    context.get(KeysInitQuery.physicalQueryPlanNode)?.appendMetadata({ sourceQuery: query });
  }

  /**
   * Count an HTTP request against the physical query plan node of the operation it is made on behalf of.
   * @param context The context of the operation for which the request is sent.
   */
  protected countHttpRequest(context: IActionContext): void {
    const planNode = context.get(KeysInitQuery.physicalQueryPlanNode);
    if (planNode) {
      const httpRequests = (this.httpRequestsByPlanNode.get(planNode) ?? 0) + 1;
      this.httpRequestsByPlanNode.set(planNode, httpRequests);
      planNode.appendMetadata({ httpRequests });
    }
  }

  public queryBindings(
    operationIn: Algebra.Operation,
    context: IActionContext,
    options?: IQueryBindingsOptions,
  ): BindingsStream {
    // If bindings are passed, modify the operations
    let operationPromise: Promise<Algebra.Operation>;
    if (options?.joinBindings) {
      operationPromise = QuerySourceSparql.addBindingsToOperation(
        this.algebraFactory,
        this.bindMethod,
        operationIn,
        options.joinBindings,
      );
    } else {
      operationPromise = Promise.resolve(operationIn);
    }

    const bindings: BindingsStream = new TransformIterator(async() => {
      // Prepare queries
      const operation = await operationPromise;
      const variables: RDF.Variable[] = algebraUtils.inScopeVariables(operation);
      const undefVariables = QuerySourceSparql.getOperationUndefs(operation);

      // Request results in pages if the endpoint would otherwise truncate them.
      if (this.resultLimit !== undefined && !QuerySourceSparql.isLimitedTo(operation, this.resultLimit)) {
        return this.queryBindingsPaged(operation, variables, context, undefVariables, this.resultLimit);
      }

      // Join bindings modify the operation, so it is no longer equivalent to the original query string.
      const queryString = options?.joinBindings ? undefined : QuerySourceSparql.getQueryStringAsIs(operation, context);
      const selectQuery: string = queryString ??
        await this.operationToSelectQuery(this.algebraFactory, operation, variables);

      this.reportSourceQuery(context, selectQuery);
      return this.queryBindingsRemote(this.url, selectQuery, variables, context, undefVariables);
    }, { autoStart: false });
    this.attachMetadata(bindings, context, operationPromise);

    return bindings;
  }

  /**
   * Query the bindings of an operation in pages of the given size, using LIMIT and OFFSET,
   * so that results are not truncated by endpoints that restrict their result size.
   * Pages are requested in sequence, until a page contains fewer results than the page size.
   * As with any OFFSET-based paging, pages are only guaranteed to be consistent for ordered results.
   * @param operation The operation to query.
   * @param variables The variables in scope for the operation.
   * @param context The context of the operation.
   * @param undefVariables Variables that may have undefs.
   * @param pageSize The number of results per page.
   */
  protected queryBindingsPaged(
    operation: Algebra.Operation,
    variables: RDF.Variable[],
    context: IActionContext,
    undefVariables: RDF.Variable[],
    pageSize: number,
  ): BindingsStream {
    const projection = isKnownOperation(operation, Algebra.Types.PROJECT) ?
      operation :
      this.algebraFactory.createProject(operation, variables);
    return new PagedBindingsIterator(pageSize, async(offset) => {
      const pageQuery = await this.operationToQuery(this.algebraFactory.createSlice(projection, offset, pageSize));
      this.reportSourceQuery(context, pageQuery);
      return this.queryBindingsRemote(this.url, pageQuery, variables, context, undefVariables);
    });
  }

  /**
   * Check if the given operation produces at most the given number of results due to its own LIMIT.
   * @param operation A query operation.
   * @param limit A number of results.
   */
  public static isLimitedTo(operation: Algebra.Operation, limit: number): boolean {
    return isKnownOperation(operation, Algebra.Types.SLICE) && operation.length !== undefined &&
      operation.length <= limit;
  }

  public queryQuads(operation: Algebra.Operation, context: IActionContext): AsyncIterator<RDF.Quad> {
    const quads = wrap<any>((async() => {
      const query: string = QuerySourceSparql.getQueryStringAsIs(operation, context) ??
        await this.operationToQuery(operation);
      this.reportSourceQuery(context, query);
      const rawStream = await this.endpointFetcher.fetchTriples(this.url, query, this.getRequestOptions(context));
      return rawStream;
    })(), { autoStart: false, maxBufferSize: Number.POSITIVE_INFINITY });
    this.attachMetadata(quads, context, Promise.resolve((<Algebra.Operation & { input: any }>operation).input));
    return quads;
  }

  public async queryBoolean(operation: Algebra.Ask, context: IActionContext): Promise<boolean> {
    // Shortcut the ASK query to return true when supported propertyFeature predicates are used in it.
    if (this.operationUsesPropertyFeatures(operation)) {
      return true;
    }
    // Without propertyFeature overlap, perform the actual ASK query.
    const query: string = QuerySourceSparql.getQueryStringAsIs(operation, context) ??
      await this.operationToQuery(operation);
    this.reportSourceQuery(context, query);
    const promise = this.endpointFetcher.fetchAsk(this.url, query, this.getRequestOptions(context));
    return promise;
  }

  public async queryVoid(operation: Algebra.Operation, context: IActionContext): Promise<void> {
    const query: string = QuerySourceSparql.getQueryStringAsIs(operation, context) ??
      await this.operationToQuery(operation);
    this.reportSourceQuery(context, query);
    const promise = this.endpointFetcher.fetchUpdate(this.url, query, this.getRequestOptions(context));
    return promise;
  }

  protected attachMetadata(
    target: AsyncIterator<any>,
    context: IActionContext,
    operationPromise: Promise<Algebra.Operation>,
  ): void {
    // Emit metadata containing the estimated count
    let variablesCount: MetadataVariable[] = [];
    // eslint-disable-next-line no-async-promise-executor,ts/no-misused-promises
    new Promise<QueryResultCardinality>(async(resolve, reject) => {
      try {
        const operation = await operationPromise;
        const variablesScoped = algebraUtils.inScopeVariables(operation);
        const countQuery = await this.operationToNormalizedCountQuery(operation);

        const undefVariables = QuerySourceSparql.getOperationUndefs(operation);
        variablesCount = variablesScoped.map(variable => ({
          variable,
          canBeUndef: undefVariables.some(undefVariable => undefVariable.equals(variable)),
        }));

        const cachedCardinality = this.cache?.get(countQuery);
        if (cachedCardinality) {
          return resolve(cachedCardinality);
        }

        // Attempt to estimate locally prior to sending a COUNT request, as this should be much faster.
        // The estimates may be off by varying amounts, so this is set behind a configuration flag.
        if (this.cardinalityEstimateConstruction) {
          const localEstimate = await this.estimateOperationCardinality(operation);
          if (Number.isFinite(localEstimate.value)) {
            this.cache?.set(countQuery, localEstimate);
            return resolve(localEstimate);
          }
        }

        // Don't send count queries if disabled,
        // or if the rate limit of the endpoint would on average delay them beyond the count timeout.
        if (!this.cardinalityCountQueries ||
          (this.requestInterval !== undefined && this.requestInterval > this.countTimeout)) {
          return resolve({ type: 'estimate', value: Number.POSITIVE_INFINITY, dataset: this.url });
        }

        // Abort the count request on timeout, so that it does not keep occupying the endpoint.
        let countContext: IActionContext;
        let timeoutHandler: NodeJS.Timeout | undefined;
        if (this.restrictions) {
          // Requests to endpoints with restrictions may be delayed to respect them,
          // so the timeout of the count request only starts once it is sent.
          const httpTimeout = context.get(KeysHttp.httpTimeout) ?? this.countTimeout;
          countContext = context
            .set(KeysHttp.httpTimeout, Math.min(httpTimeout, this.countTimeout))
            .set(KeysHttp.httpBodyTimeout, true);
        } else {
          const abortController = new AbortController();
          const existingAbortSignal = context.get(KeysHttp.httpAbortSignal);
          countContext = context.set(
            KeysHttp.httpAbortSignal,
            existingAbortSignal ?
              AbortSignal.any([ existingAbortSignal, abortController.signal ]) :
              abortController.signal,
          );
          timeoutHandler = setTimeout(() => {
            resolve({
              type: 'estimate',
              value: Number.POSITIVE_INFINITY,
              dataset: this.url,
            });
            abortController.abort();
          }, this.countTimeout);
        }
        const varCount = this.dataFactory.variable('count');
        const bindingsStream: BindingsStream = await this
          .queryBindingsRemote(this.url, countQuery, [ varCount ], countContext, []);
        bindingsStream
          .on('data', (bindings: Bindings) => {
            clearTimeout(timeoutHandler);
            const count = bindings.get(varCount);
            const cardinality: QueryResultCardinality = {
              type: 'estimate',
              value: Number.POSITIVE_INFINITY,
              dataset: this.url,
            };
            if (count) {
              const cardinalityValue: number = Number.parseInt(count.value, 10);
              if (!Number.isNaN(cardinalityValue)) {
                cardinality.type = 'exact';
                cardinality.value = cardinalityValue;
                this.cache?.set(countQuery, cardinality);
              }
            }
            return resolve(cardinality);
          })
          .on('error', () => {
            clearTimeout(timeoutHandler);
            resolve({ type: 'estimate', value: Number.POSITIVE_INFINITY, dataset: this.url });
          })
          .on('end', () => {
            clearTimeout(timeoutHandler);
            resolve({ type: 'estimate', value: Number.POSITIVE_INFINITY, dataset: this.url });
          });
      } catch (error: unknown) {
        reject(error);
      }
    })
      .then(cardinality => target.setProperty('metadata', {
        state: new MetadataValidationState(),
        cardinality,
        ...this.getRequestTimeMetadata(),
        variables: variablesCount,
      }))
      .catch(() => target.setProperty('metadata', {
        state: new MetadataValidationState(),
        cardinality: { type: 'estimate', value: Number.POSITIVE_INFINITY, dataset: this.url },
        ...this.getRequestTimeMetadata(),
        variables: variablesCount,
      }));
  }

  /**
   * Obtain the metadata entry for the time per request, if the requests to the endpoint are rate-limited.
   * This lets join actors take into account the number of requests that their join method requires.
   */
  protected getRequestTimeMetadata(): { requestTime?: number } {
    return this.requestInterval === undefined ? {} : { requestTime: this.requestInterval };
  }

  /**
   * Convert an algebra operation into a query string, and if the operation is a simple triple pattern,
   * then also replace any variables with s, p, and o to increase the chance of cache hits.
   * @param {Algebra.Operation} operation The operation to convert into a query string.
   * @returns {string} Query string for a COUNT query over the operation.
   */
  public async operationToNormalizedCountQuery(operation: Algebra.Operation): Promise<string> {
    const normalizedOperation = isKnownOperation(operation, Algebra.Types.PATTERN) ?
      this.algebraFactory.createPattern(
        operation.subject.termType === 'Variable' ? this.dataFactory.variable('s') : operation.subject,
        operation.predicate.termType === 'Variable' ? this.dataFactory.variable('p') : operation.predicate,
        operation.object.termType === 'Variable' ? this.dataFactory.variable('o') : operation.object,
      ) :
      operation;
    return await this.operationToCountQuery(
      this.dataFactory,
      this.algebraFactory,
      normalizedOperation,
    );
  }

  /**
   * Performs local cardinality estimation for the specified SPARQL algebra operation, which should
   * result in better estimation performance at the expense of accuracy.
   * @param {Algebra.Operation} operation A query operation.
   */
  public async estimateOperationCardinality(operation: Algebra.Operation): Promise<QueryResultCardinality> {
    if (this.operationUsesPropertyFeatures(operation)) {
      return { type: 'estimate', value: 1, dataset: this.url };
    }

    const dataset: IDataset = {
      getCardinality: async(operation: Algebra.Operation): Promise<QueryResultCardinality | undefined> => {
        const queryString = await this.operationToNormalizedCountQuery(operation);

        const cachedCardinality = this.cache?.get(queryString);
        if (cachedCardinality) {
          return cachedCardinality;
        }

        if (this.datasets) {
          const cardinalities = await Promise.all(this.datasets
            .filter(ds => this.unionDefaultGraph || (this.defaultGraph && ds.uri.endsWith(this.defaultGraph)))
            .map(ds => estimateCardinality(operation, ds)));

          const cardinality: QueryResultCardinality = {
            type: cardinalities.some(card => card.type === 'estimate') ? 'estimate' : 'exact',
            value: cardinalities.length > 0 ? cardinalities.reduce((acc, card) => acc + card.value, 0) : 0,
            dataset: this.url,
          };

          return cardinality;
        }
      },
      source: this.url,
      uri: this.url,
    };

    return estimateCardinality(operation, dataset);
  }

  /**
   * Checks whether the provided operation makes use of this endpoint's property features,
   * if the endpoint has property features detected.
   * @param {Algebra.Operation} operation The operation to check.
   * @returns {boolean} Whether the operation makes use of property features.
   */
  public operationUsesPropertyFeatures(operation: Algebra.Operation): boolean {
    let propertyFeaturesUsed = false;
    if (this.propertyFeatures) {
      algebraUtils.visitOperation(operation, {
        [Algebra.Types.PATTERN]: {
          visitor: (subOp) => {
            if (subOp.predicate.termType === 'NamedNode' && this.propertyFeatures!.has(subOp.predicate.value)) {
              propertyFeaturesUsed = true;
            }
            return false;
          },
        },
        [Algebra.Types.LINK]: {
          visitor: (subOp) => {
            if (this.propertyFeatures!.has(subOp.iri.value)) {
              propertyFeaturesUsed = true;
            }
            return false;
          },
        },
        [Algebra.Types.NPS]: {
          visitor: (subOp) => {
            if (subOp.iris.some(iri => this.propertyFeatures!.has(iri.value))) {
              propertyFeaturesUsed = true;
            }
            return false;
          },
        },
      });
    }
    return propertyFeaturesUsed;
  }

  /**
   * Create an operation that includes the bindings from the given bindings stream.
   * @param algebraFactory The algebra factory.
   * @param bindMethod A method for adding bindings to an operation.
   * @param operation The operation to bind to.
   * @param addBindings The bindings to add.
   * @param addBindings.bindings The bindings stream.
   * @param addBindings.metadata The bindings metadata.
   */
  public static async addBindingsToOperation(
    algebraFactory: AlgebraFactory,
    bindMethod: BindMethod,
    operation: Algebra.Operation,
    addBindings: { bindings: BindingsStream; metadata: MetadataBindings },
  ): Promise<Algebra.Operation> {
    const bindings = await addBindings.bindings.toArray();

    switch (bindMethod) {
      case 'values':
        return algebraFactory.createJoin([
          algebraFactory.createValues(
            addBindings.metadata.variables.map(v => v.variable),
            bindings.map(binding => Object.fromEntries([ ...binding ]
              .map(([ key, value ]) => [ key.value, <RDF.Literal | RDF.NamedNode> value ]))),
          ),
          operation,
        ], false);
      case 'union': { throw new Error('Not implemented yet: "union" case'); }
      case 'filter': { throw new Error('Not implemented yet: "filter" case'); }
    }
  }

  /**
   * Convert an operation to a select query for this pattern.
   * @param algebraFactory The algebra factory.
   * @param {Algebra.Operation} operation A query operation.
   * @param {RDF.Variable[]} variables The variables in scope for the operation.
   * @return {string} A select query string.
   */
  public operationToSelectQuery(
    algebraFactory: AlgebraFactory,
    operation: Algebra.Operation,
    variables: RDF.Variable[],
  ): Promise<string> {
    return this.operationToQuery(algebraFactory.createProject(operation, variables));
  }

  /**
   * Convert an operation to a count query for the number of matching triples for this pattern.
   * @param dataFactory The data factory.
   * @param algebraFactory The algebra factory.
   * @param {Algebra.Operation} operation A query operation.
   * @return {string} A count query string.
   */
  public operationToCountQuery(
    dataFactory: ComunicaDataFactory,
    algebraFactory: AlgebraFactory,
    operation: Algebra.Operation,
  ): Promise<string> {
    return this.operationToQuery(algebraFactory.createProject(
      algebraFactory.createExtend(
        algebraFactory.createGroup(
          operation,
          [],
          [ algebraFactory.createBoundAggregate(
            dataFactory.variable('var0'),
            'count',
            algebraFactory.createWildcardExpression(),
            false,
          ) ],
        ),
        dataFactory.variable('count'),
        algebraFactory.createTermExpression(dataFactory.variable('var0')),
      ),
      [ dataFactory.variable('count') ],
    ));
  }

  /**
   * Convert an operation to a query for this pattern.
   * @param {Algebra.Operation} operation A query operation.
   * @return {string} A query string.
   */
  public async operationToQuery(operation: Algebra.Operation): Promise<string> {
    return (await this.mediatorQuerySerialize.mediate({
      queryFormat: { language: 'sparql', version: '1.2' },
      operation,
      newlines: false,
      indentWidth: 0,
      context: this.context,
    })).query;
  }

  /**
   * Obtain the SPARQL query string that may be sent as-is for the given operation.
   * @param operation A query operation.
   * @param context The action context.
   * @return The query string to send as-is, or undefined if the operation must be serialized.
   */
  public static getQueryStringAsIs(operation: Algebra.Operation, context: IActionContext): string | undefined {
    // TODO: next/major - remove the fallback to the original query string, see KeysInitQuery.queryString.
    return getOperationEquivalentQueryString(operation) ?? getOriginalSparqlQueryString(context);
  }

  /**
   * Check if the given operation may produce undefined values.
   * @param operation
   */
  public static getOperationUndefs(operation: Algebra.Operation): RDF.Variable[] {
    const variables: RDF.Variable[] = [];
    algebraUtils.visitOperation(operation, {
      [Algebra.Types.LEFT_JOIN]: { preVisitor: (subOperation) => {
        const left = algebraUtils.inScopeVariables(subOperation.input[0]);
        const right = algebraUtils.inScopeVariables(subOperation.input[1]);
        for (const varRight of right) {
          if (!left.some(varLeft => varLeft.equals(varRight))) {
            variables.push(varRight);
          }
        }
        return { continue: false };
      } },
      [Algebra.Types.VALUES]: { preVisitor: (values) => {
        for (const variable of values.variables) {
          if (values.bindings.some(bindings => !(variable.value in bindings))) {
            variables.push(variable);
          }
        }
        return { continue: false };
      } },
      [Algebra.Types.UNION]: { preVisitor: (union) => {
        // Determine variables in scope of the union branches that are not occurring in every branch
        const scopedVariables = union.input.map(op => algebraUtils.inScopeVariables(op));
        for (const variable of uniqTerms(scopedVariables.flat())) {
          if (!scopedVariables.every(input => input.some(inputVar => inputVar.equals(variable)))) {
            variables.push(variable);
          }
        }
        return {};
      } },
    });
    return uniqTerms(variables);
  }

  /**
   * Send a SPARQL query to a SPARQL endpoint and retrieve its bindings as a stream.
   * @param {string} endpoint A SPARQL endpoint URL.
   * @param {string} query A SPARQL query string.
   * @param {RDF.Variable[]} variables The expected variables.
   * @param {IActionContext} context The source context.
   * @param undefVariables Variables that may have undefs.
   * @return {BindingsStream} A stream of bindings.
   */
  public async queryBindingsRemote(
    endpoint: string,
    query: string,
    variables: RDF.Variable[],
    context: IActionContext,
    undefVariables: RDF.Variable[],
  ): Promise<BindingsStream> {
    // Index undef variables
    const undefVariablesSet = new Set(undefVariables.map(v => v.value));

    const rawStream = await this.endpointFetcher.fetchBindings(endpoint, query, this.getRequestOptions(context));

    const wrapped = wrap<any>(rawStream, { autoStart: false, maxBufferSize: Number.POSITIVE_INFINITY });
    return wrapped.map<RDF.Bindings>((rawData: Record<string, RDF.Term>) => {
      const bindings = variables.map((variable) => {
        const value = rawData[`?${variable.value}`];
        if (!undefVariablesSet.has(variable.value) && !value) {
          Actor.getContextLogger(this.context)?.warn(`The endpoint ${endpoint} failed to provide a binding for ${variable.value}.`);
        }
        return <[RDF.Variable, RDF.Term]>[ variable, value ];
      }).filter(([ _, v ]) => Boolean(v));
      return this.bindingsFactory.bindings(bindings);
    });
  }

  public toString(): string {
    return `QuerySourceSparql(${this.url})`;
  }
}

/**
 * An iterator over results that are requested in pages of a fixed size, one page after the other,
 * until a page contains fewer results than the page size.
 * All pages are read through this one iterator, so that the number of iterators
 * that each result passes through does not grow with the number of pages.
 */
class PagedBindingsIterator extends BufferedIterator<RDF.Bindings> {
  private readonly pageSize: number;
  private readonly requestPage: (offset: number) => Promise<BindingsStream>;
  private page: BindingsStream | undefined;
  private pageResults = 0;
  private offset = 0;

  /**
   * @param pageSize The number of results per page.
   * @param requestPage A function that requests the page of results at the given offset.
   */
  public constructor(pageSize: number, requestPage: (offset: number) => Promise<BindingsStream>) {
    super({ autoStart: false });
    this.pageSize = pageSize;
    this.requestPage = requestPage;
  }

  protected override _read(count: number, done: () => void): void {
    if (!this.page) {
      this.startPage(count, done);
      return;
    }

    while (count > 0) {
      const item = this.page.read();
      if (item === null) {
        break;
      }
      this.pageResults++;
      this._push(item);
      count--;
    }

    if (this.page.done) {
      // Only a full page can be followed by more results.
      if (this.pageResults === this.pageSize) {
        this.offset += this.pageSize;
        this.page = undefined;
        this.pageResults = 0;
        this.startPage(count, done);
        return;
      }
      this.close();
    }
    done();
  }

  /**
   * Request the page at the current offset, and read from it once it is available.
   * @param count The number of results to read.
   * @param done To be called when reading is complete.
   */
  protected startPage(count: number, done: () => void): void {
    this.requestPage(this.offset).then((page) => {
      // Discard the page if this iterator was closed or destroyed in the meantime.
      if (this.closed) {
        page.destroy();
        return done();
      }
      this.page = page;
      // The buffer is refilled when this iterator is read after becoming readable,
      // which also lets the next page be requested once this page ends.
      page.on('readable', () => {
        this.readable = true;
      });
      page.on('end', () => {
        this.readable = true;
      });
      page.on('error', (error: Error) => this.destroy(error));
      this._read(count, done);
    }, (error: Error) => {
      this.destroy(error);
      done();
    });
  }

  protected override _end(destroy?: boolean): void {
    super._end(destroy);
    this.page?.destroy();
  }
}
