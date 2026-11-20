import type { IActionHttp, IActorHttpOutput, IActorHttpArgs, MediatorHttp } from '@comunica/bus-http';
import { ActorHttp } from '@comunica/bus-http';
import type { ActorHttpInvalidateListenable, IActionHttpInvalidate } from '@comunica/bus-http-invalidate';
import { KeysHttp } from '@comunica/context-entries';
import type { TestResult } from '@comunica/core';
import { ActionContextKey, failTest, passTest } from '@comunica/core';
import type { IMediatorTypeTime } from '@comunica/mediatortype-time';
import type { IActionContext, IClientContact, IEndpointRestriction } from '@comunica/types';

// eslint-disable-next-line import/extensions
import { version as actorVersion } from '../package.json';

/**
 * A comunica HTTP actor that respects the operational restrictions of endpoints,
 * such as rate limits, concurrent request limits, usage budgets and identification requirements,
 * as advertised in their service descriptions.
 *
 * It only acts on requests that carry endpoint restrictions in their context (KeysHttp.endpointRestrictions).
 */
export class ActorHttpLimitRestrictions extends ActorHttp {
  /**
   * The product identifier that is sent with contact information to endpoints that require it in the User-Agent.
   * It is undefined in browsers, which do not allow setting the User-Agent.
   */
  public static userAgent = ActorHttp.createUserAgent('ActorHttpLimitRestrictions', actorVersion);

  private readonly hostData: Map<string, IHostData>;
  private readonly safetyMargin: number;
  private readonly applySoftRestrictions: boolean;
  private readonly ignoredScopes: Set<string>;
  private readonly httpInvalidator: ActorHttpInvalidateListenable;
  private readonly mediatorHttp: MediatorHttp;

  // Context key to indicate that the actor has already wrapped the given request
  private static readonly keyWrapped = new ActionContextKey<boolean>(
    'urn:comunica:actor-http-limit-restrictions#wrapped',
  );

  public constructor(args: IActorHttpLimitRestrictionsArgs) {
    super(args);
    this.mediatorHttp = args.mediatorHttp;
    this.httpInvalidator = args.httpInvalidator;
    this.httpInvalidator.addInvalidateListener(action => this.handleHttpInvalidateEvent(action));
    this.safetyMargin = args.safetyMargin;
    this.applySoftRestrictions = args.applySoftRestrictions;
    this.ignoredScopes = new Set(args.ignoredScopes ?? []);
    this.hostData = new Map();
  }

  public async test(action: IActionHttp): Promise<TestResult<IMediatorTypeTime>> {
    if (action.context.has(ActorHttpLimitRestrictions.keyWrapped)) {
      return failTest(`${this.name} can only wrap a request once`);
    }
    if (!action.context.has(KeysHttp.endpointRestrictions)) {
      return failTest(`${this.name} can only wrap requests to endpoints with restrictions`);
    }
    return passTest({ time: 0 });
  }

  public async run(action: IActionHttp): Promise<IActorHttpOutput> {
    const requestUrl = ActorHttp.getInputUrl(action.input);
    const restrictions = this.getApplicableRestrictions(action.context.getSafe(KeysHttp.endpointRestrictions));

    let hostData = this.hostData.get(requestUrl.host);
    if (!hostData) {
      hostData = this.createHostData(restrictions);
      this.hostData.set(requestUrl.host, hostData);
    }

    // Requests that are aborted while waiting are dropped, so that they do not occupy a slot or request time.
    const signal = ActorHttpLimitRestrictions.getAbortSignal(action);

    // Wait for a free slot if the number of concurrent requests is limited.
    await ActorHttpLimitRestrictions.acquireSlot(hostData, signal);
    let released = false;
    const release = (): void => {
      if (!released) {
        released = true;
        ActorHttpLimitRestrictions.releaseSlot(hostData);
      }
    };

    try {
      signal?.throwIfAborted();

      // Wait until the usage budget can pay for the request, and the request fits within all request windows.
      const now = Date.now();
      const budgetDelay = hostData.budget ? ActorHttpLimitRestrictions.reserveBudget(hostData.budget, now) : 0;
      const requestTime = now + budgetDelay +
        ActorHttpLimitRestrictions.reserveRequestTime(hostData, now + budgetDelay);
      const delay = requestTime - now;
      if (delay > 0) {
        this.logDebug(action.context, 'Delaying request to respect endpoint restrictions', () => ({
          url: requestUrl.href,
          delay,
        }));
        try {
          await ActorHttpLimitRestrictions.sleep(delay, signal);
        } catch (error: unknown) {
          ActorHttpLimitRestrictions.cancelRequestTime(hostData, requestTime);
          if (hostData.budget) {
            ActorHttpLimitRestrictions.cancelBudget(hostData.budget);
          }
          throw error;
        }
      }
      if (hostData.budget) {
        // The reserved unit is now spent by a request that is sent.
        hostData.budget.reservedUnits--;
      }

      const headers = this.getIdentificationHeaders(action, restrictions, hostData);
      const response = await this.mediatorHttp.mediate({
        ...action,
        ...headers ? { init: { ...action.init, headers }} : {},
        context: this.getRequestContext(action.context, restrictions)
          .set(ActorHttpLimitRestrictions.keyWrapped, true),
      });
      if (hostData.budget) {
        ActorHttpLimitRestrictions.updateBudget(hostData.budget, response, Date.now());
      }

      // Requests only occupy a slot until their body has been consumed.
      if (Number.isFinite(hostData.concurrencyLimit)) {
        return ActorHttpLimitRestrictions.releaseOnBodyEnd(response, release);
      }
      release();
      return response;
    } catch (error: unknown) {
      release();
      throw error;
    }
  }

  /**
   * Filter the restrictions that should be respected by this actor,
   * based on their hardness and scope.
   * @param restrictions The restrictions of an endpoint.
   */
  public getApplicableRestrictions(restrictions: IEndpointRestriction[]): IEndpointRestriction[] {
    return restrictions.filter(restriction => (this.applySoftRestrictions || restriction.hardRestriction !== false) &&
      !(restriction.scope && this.ignoredScopes.has(restriction.scope)));
  }

  /**
   * Create the request windows and concurrency limit for a host.
   * Each rate or quota restriction leads to a sliding window that allows at most maxValue requests
   * per windowDuration.
   * If a burst value is given, an additional window limits bursts to burstValue requests
   * within the time those requests would take at the steady rate.
   * The safety margin reduces the number of requests per window and extends the duration of each window.
   * The latter is needed because endpoints count requests when they arrive:
   * a burst sent exactly one window after the previous one could otherwise arrive within the endpoint's window
   * if it travels faster than the previous burst did.
   * @param restrictions The applicable restrictions of an endpoint on the host.
   */
  public createHostData(restrictions: IEndpointRestriction[]): IHostData {
    const windows: IRequestWindow[] = [];
    let concurrencyLimit = Number.POSITIVE_INFINITY;
    let budget: IUsageBudget | undefined;
    for (const restriction of restrictions) {
      if (!restriction.maxValue || restriction.maxValue <= 0) {
        continue;
      }
      if (restriction.type === 'costModel' && restriction.windowDuration) {
        // A usage budget of cost units per window; the most restrictive one is used.
        const candidate = this.createBudget(restriction);
        if (!budget || candidate.refillPerMs < budget.refillPerMs) {
          budget = candidate;
        }
      } else if ((restriction.type === 'rate' || restriction.type === 'quota') && restriction.windowDuration) {
        windows.push(this.createWindow(restriction.maxValue, restriction.windowDuration));
        if (restriction.burstValue && restriction.burstValue > 0 && restriction.burstValue < restriction.maxValue) {
          windows.push(this.createWindow(
            restriction.burstValue,
            restriction.windowDuration * restriction.burstValue / restriction.maxValue,
          ));
        }
      } else if (restriction.type === 'concurrentRequests') {
        concurrencyLimit = Math.min(concurrencyLimit, restriction.maxValue);
      }
    }
    return {
      windows,
      maxWindowDuration: Math.max(0, ...windows.map(window => window.duration)),
      requestTimestamps: [],
      concurrencyLimit,
      activeRequests: 0,
      pendingRequests: [],
      ...budget ? { budget } : {},
    };
  }

  /**
   * Create the client-side view of a usage budget: maxValue cost units per windowDuration,
   * of which at most burstValue (or else maxValue) can be spent at once.
   * The safety margin reduces both the capacity and the rate at which it is restored.
   * @param restriction A cost model restriction with a window and a maximum value.
   */
  public createBudget(restriction: IEndpointRestriction): IUsageBudget {
    const capacity = Math.max(1, Math.floor((restriction.burstValue ?? restriction.maxValue!) * this.safetyMargin));
    return {
      capacity,
      refillPerMs: restriction.maxValue! * this.safetyMargin / restriction.windowDuration!,
      units: capacity,
      updatedAt: Date.now(),
      reservedUnits: 0,
      remainingHeader: restriction.httpSignalHeader,
      statusCode: restriction.returnsStatusCode,
    };
  }

  /**
   * Restore the units of a usage budget for the time that has passed.
   * Units that are reserved by requests that were not sent yet do not count towards the capacity.
   * @param budget A usage budget.
   * @param now The current timestamp.
   */
  public static refillBudget(budget: IUsageBudget, now: number): void {
    budget.units = Math.min(
      budget.capacity - budget.reservedUnits,
      budget.units + (Math.max(0, now - budget.updatedAt) * budget.refillPerMs),
    );
    budget.updatedAt = Math.max(budget.updatedAt, now);
  }

  /**
   * Reserve the minimum cost of one unit of a usage budget for a request,
   * and determine how long the request must wait until the budget can pay for it.
   * Requests often cost more than one unit; the remaining budget that the endpoint reports corrects this
   * (see updateBudget).
   * @param budget A usage budget.
   * @param now The current timestamp.
   * @return The number of milliseconds to wait before sending the request.
   */
  public static reserveBudget(budget: IUsageBudget, now: number): number {
    ActorHttpLimitRestrictions.refillBudget(budget, now);
    budget.units--;
    budget.reservedUnits++;
    return budget.units >= 0 ? 0 : Math.ceil(-budget.units / budget.refillPerMs);
  }

  /**
   * Cancel the reservation of a request that was not sent.
   * @param budget A usage budget.
   */
  public static cancelBudget(budget: IUsageBudget): void {
    budget.units++;
    budget.reservedUnits--;
  }

  /**
   * Correct a usage budget with the remaining budget that the endpoint reports in a response,
   * or with an empty budget if the endpoint rejected the request because the budget was spent.
   * Only lower values are taken over, so that responses that arrive out of order cannot overspend the budget.
   * @param budget A usage budget.
   * @param response The response to a request that was paid from the budget.
   * @param now The current timestamp.
   */
  public static updateBudget(budget: IUsageBudget, response: Response, now: number): void {
    let remaining: number | undefined;
    const header = budget.remainingHeader ? response.headers.get(budget.remainingHeader) : null;
    if (header !== null && Number.isFinite(Number.parseFloat(header))) {
      remaining = Number.parseFloat(header);
    } else if (response.status === budget.statusCode) {
      remaining = 0;
    }
    if (remaining !== undefined) {
      ActorHttpLimitRestrictions.refillBudget(budget, now);
      budget.units = Math.min(budget.units, remaining - budget.reservedUnits);
    }
  }

  /**
   * Determine the headers with which a request identifies the engine to an endpoint that requires identification.
   * Contact information is only sent to endpoints whose restrictions require it.
   * @param action An HTTP action.
   * @param restrictions The applicable restrictions of the endpoint.
   * @param hostData The data of the endpoint's host.
   * @return The headers of the request with the identification, or undefined if no identification is required.
   */
  public getIdentificationHeaders(
    action: IActionHttp,
    restrictions: IEndpointRestriction[],
    hostData: IHostData,
  ): Headers | undefined {
    const required = restrictions.filter(restriction => restriction.type === 'identification' &&
      restriction.identificationHeader);
    if (required.length === 0) {
      return undefined;
    }
    const contact = action.context.get(KeysHttp.clientContact);
    const headers = new Headers(action.init?.headers);
    for (const restriction of required) {
      const value = ActorHttpLimitRestrictions
        .getIdentification(restriction, contact, headers.get(restriction.identificationHeader!));
      if (value) {
        headers.set(restriction.identificationHeader!, value);
      } else if (!hostData.identificationWarned) {
        hostData.identificationWarned = true;
        const message = 'An endpoint requires identification that the client contact cannot provide';
        this.logWarn(action.context, message, () => ({
          url: ActorHttp.getInputUrl(action.input).href,
          header: restriction.identificationHeader,
          format: restriction.identificationFormat,
          contact: `Set ${KeysHttp.clientContact.name} with an email address and, optionally, a URL`,
        }));
      }
    }
    return headers;
  }

  /**
   * Determine the value of an identification header.
   * @param restriction An identification restriction.
   * @param contact The contact information of the engine, if any.
   * @param current The current value of the header, if any, such as a User-Agent set by the user.
   * @return The value, or undefined if the contact information cannot provide it.
   */
  public static getIdentification(
    restriction: IEndpointRestriction,
    contact: IClientContact | undefined,
    current: string | null,
  ): string | undefined {
    if (restriction.identificationFormat === 'email') {
      return contact?.email;
    }
    if (restriction.identificationFormat === 'productWithContact') {
      const details = [ contact?.url, contact?.email ].filter(Boolean);
      const product = current ?? ActorHttpLimitRestrictions.userAgent;
      return details.length > 0 && product ? `${product} (${details.join('; ')})` : undefined;
    }
    return undefined;
  }

  /**
   * Create a request window with the safety margin applied to an advertised limit.
   * @param limit The advertised maximum number of requests within the window.
   * @param duration The advertised duration of the window in milliseconds.
   */
  public createWindow(limit: number, duration: number): IRequestWindow {
    return {
      limit: Math.max(1, Math.floor(limit * this.safetyMargin)),
      duration: Math.ceil(duration / this.safetyMargin),
    };
  }

  /**
   * Determine the context for the wrapped request, based on the endpoint restrictions.
   * - Response time restrictions that reject requests set the request timeout, unless a timeout was already set.
   * - Status codes of rate, quota, concurrency, and usage budget restrictions are added to the status codes
   *   that are retried, unless the endpoint blocks the client at the first violation (penaltyThreshold 1).
   * - Retry hints of rate, quota, concurrency, and usage budget restrictions set the fallback retry delay,
   *   unless a fallback delay was already set.
   * @param context The context of the request.
   * @param restrictions The applicable restrictions of the endpoint.
   */
  public getRequestContext(context: IActionContext, restrictions: IEndpointRestriction[]): IActionContext {
    const maxEvaluationTimes: number[] = [];
    const retryStatusCodes: number[] = [];
    const retryAfterHints: number[] = [];
    for (const restriction of restrictions) {
      if (restriction.type === 'responseTime') {
        if (restriction.enforcement === 'reject' && restriction.maxValue && restriction.maxValue > 0) {
          maxEvaluationTimes.push(restriction.maxValue);
        }
      } else if (restriction.type === 'rate' || restriction.type === 'quota' ||
        restriction.type === 'concurrentRequests' ||
        (restriction.type === 'costModel' && restriction.windowDuration !== undefined)) {
        // Retrying is pointless when the endpoint blocks the client at the first violation.
        if (restriction.returnsStatusCode && restriction.penaltyThreshold !== 1) {
          retryStatusCodes.push(restriction.returnsStatusCode);
        }
        if (restriction.retryAfterHint) {
          retryAfterHints.push(restriction.retryAfterHint);
        }
      }
    }

    if (maxEvaluationTimes.length > 0 && !context.has(KeysHttp.httpTimeout)) {
      // Evaluation times are expressed in seconds, and the margin gives the response time to arrive.
      context = context.set(
        KeysHttp.httpTimeout,
        Math.ceil(Math.min(...maxEvaluationTimes) * 1_000 / this.safetyMargin),
      );
    }
    if (retryStatusCodes.length > 0) {
      const existingStatusCodes = context.get(KeysHttp.httpRetryStatusCodes) ?? [];
      context = context.set(
        KeysHttp.httpRetryStatusCodes,
        [ ...new Set([ ...existingStatusCodes, ...retryStatusCodes ]) ],
      );
    }
    if (retryAfterHints.length > 0 && !context.has(KeysHttp.httpRetryDelayFallback)) {
      context = context.set(KeysHttp.httpRetryDelayFallback, Math.max(...retryAfterHints));
    }
    return context;
  }

  /**
   * Reserve the earliest time at which a new request fits within all request windows of a host.
   * Requests are reserved in order, so that waiting requests are sent first-come-first-served.
   * @param hostData The data of a host.
   * @param now The current timestamp.
   * @return The number of milliseconds to wait before sending the request.
   */
  public static reserveRequestTime(hostData: IHostData, now: number): number {
    const timestamps = hostData.requestTimestamps;

    // Remove timestamps that can no longer influence any window.
    let expired = 0;
    while (expired < timestamps.length && timestamps[expired] <= now - hostData.maxWindowDuration) {
      expired++;
    }
    timestamps.splice(0, expired);

    let requestTime = Math.max(now, timestamps.at(-1) ?? now);
    for (const window of hostData.windows) {
      if (timestamps.length >= window.limit) {
        requestTime = Math.max(requestTime, timestamps[timestamps.length - window.limit] + window.duration);
      }
    }
    if (hostData.windows.length > 0) {
      timestamps.push(requestTime);
    }
    return requestTime - now;
  }

  /**
   * Cancel a reserved request time, so that it no longer counts towards the request windows of a host.
   * Removing a request never makes the requests that were reserved after it exceed a window.
   * @param hostData The data of a host.
   * @param requestTime The reserved request time.
   */
  public static cancelRequestTime(hostData: IHostData, requestTime: number): void {
    const index = hostData.requestTimestamps.lastIndexOf(requestTime);
    if (index >= 0) {
      hostData.requestTimestamps.splice(index, 1);
    }
  }

  /**
   * Wait until a request slot is available for the given host.
   * @param hostData The data of a host.
   * @param signal An optional signal that aborts the wait, and removes the request from the waiting requests.
   */
  public static async acquireSlot(hostData: IHostData, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (hostData.activeRequests < hostData.concurrencyLimit) {
      hostData.activeRequests++;
      return;
    }
    // The slot is handed over directly by the request that releases it.
    await new Promise<void>((resolve, reject) => {
      let onAbort: (() => void) | undefined;
      const handOver = (): void => {
        signal?.removeEventListener('abort', onAbort!);
        resolve();
      };
      hostData.pendingRequests.push(handOver);
      if (signal) {
        onAbort = () => {
          hostData.pendingRequests.splice(hostData.pendingRequests.indexOf(handOver), 1);
          reject(signal.reason);
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  /**
   * Release a request slot of the given host, and hand it over to the next waiting request.
   * @param hostData The data of a host.
   */
  public static releaseSlot(hostData: IHostData): void {
    const next = hostData.pendingRequests.shift();
    if (next) {
      next();
    } else {
      hostData.activeRequests--;
    }
  }

  /**
   * Wait for the given time, unless the given signal aborts first.
   * @param ms The number of milliseconds to wait.
   * @param signal An optional signal that aborts the wait.
   */
  public static async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let onAbort: (() => void) | undefined;
      const timeout = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort!);
        resolve();
      }, ms);
      if (signal) {
        onAbort = () => {
          clearTimeout(timeout);
          reject(signal.reason);
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  /**
   * Get the signal with which the caller can abort the given request, if any.
   * @param action An HTTP action.
   */
  public static getAbortSignal(action: IActionHttp): AbortSignal | undefined {
    const requestSignal = action.init?.signal ?? undefined;
    const contextSignal = action.context.get(KeysHttp.httpAbortSignal);
    if (requestSignal && contextSignal) {
      return AbortSignal.any([ requestSignal, contextSignal ]);
    }
    return requestSignal ?? contextSignal;
  }

  /**
   * Invoke the release callback once the body of the given response has been consumed, has errored, or was closed.
   * @param response An HTTP response.
   * @param release The callback to invoke.
   */
  public static releaseOnBodyEnd(response: IActorHttpOutput, release: () => void): IActorHttpOutput {
    if (!response.body) {
      release();
      return response;
    }
    const body = ActorHttp.toNodeReadable(response.body);
    body.on('end', release);
    body.on('error', release);
    body.on('close', release);
    const wrappedResponse = <IActorHttpOutput> new Response(ActorHttp.toWebReadableStream(body), {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
    wrappedResponse.cachePolicy = response.cachePolicy;
    wrappedResponse.fromCache = response.fromCache;
    return wrappedResponse;
  }

  /**
   * Handles HTTP cache invalidation events.
   * @param {IActionHttpInvalidate} action The invalidation action
   */
  public handleHttpInvalidateEvent(action: IActionHttpInvalidate): void {
    if (action.url) {
      const invalidatedHost = new URL(action.url).host;
      this.hostData.delete(invalidatedHost);
    } else {
      this.hostData.clear();
    }
  }
}

export interface IRequestWindow {
  /**
   * The maximum number of requests within the window.
   */
  limit: number;
  /**
   * The duration of the window in milliseconds.
   */
  duration: number;
}

export interface IHostData {
  /**
   * The sliding windows in which the number of requests is limited.
   */
  windows: IRequestWindow[];
  /**
   * The duration of the longest window in milliseconds.
   */
  maxWindowDuration: number;
  /**
   * The ordered (reserved) timestamps of requests within the longest window.
   */
  requestTimestamps: number[];
  /**
   * The maximum number of concurrent requests.
   */
  concurrencyLimit: number;
  /**
   * The number of requests that are currently occupying a slot.
   */
  activeRequests: number;
  /**
   * Callbacks of requests that are waiting for a slot.
   */
  pendingRequests: (() => void)[];
  /**
   * The usage budget of cost units, if the endpoint has one.
   */
  budget?: IUsageBudget;
  /**
   * If a warning was logged that the engine cannot identify itself to this host.
   */
  identificationWarned?: boolean;
}

export interface IUsageBudget {
  /**
   * The maximum number of units that can be spent at once, with the safety margin applied.
   */
  capacity: number;
  /**
   * The number of units that are restored per millisecond, with the safety margin applied.
   */
  refillPerMs: number;
  /**
   * The units that are available at updatedAt, minus the units reserved by requests that are waiting.
   * It is negative while requests wait for the budget to be restored.
   */
  units: number;
  /**
   * The timestamp at which units was determined.
   */
  updatedAt: number;
  /**
   * The number of units reserved by requests that are waiting to be sent.
   */
  reservedUnits: number;
  /**
   * The (lowercase) name of the header in which the endpoint reports the remaining budget, if any.
   */
  remainingHeader?: string;
  /**
   * The status code with which the endpoint rejects requests when the budget is spent, if known.
   */
  statusCode?: number;
}

export interface IActorHttpLimitRestrictionsArgs extends IActorHttpArgs {
  /**
   * The HTTP mediator.
   */
  mediatorHttp: MediatorHttp;
  /* eslint-disable max-len */
  /**
   * An actor that listens to HTTP invalidation events
   * @default {<default_invalidator> a <npmd:@comunica/bus-http-invalidate/^5.0.0/components/ActorHttpInvalidateListenable.jsonld#ActorHttpInvalidateListenable>}
   */
  httpInvalidator: ActorHttpInvalidateListenable;
  /* eslint-enable max-len */
  /**
   * The fraction of the advertised request limits that may be used, in range ]0.0, 1.0].
   * The number of requests per window is multiplied by it, and the window duration is divided by it.
   * This compensates for varying request latencies, clock differences, and requests that are not sent by this engine.
   * @range {float}
   * @default {0.9}
   */
  safetyMargin: number;
  /**
   * If restrictions that are not strictly enforced (vord:hardRestriction false) should also be respected.
   * @range {boolean}
   * @default {true}
   */
  applySoftRestrictions: boolean;
  /**
   * IRIs of scopes for which restrictions should be ignored,
   * e.g. when the engine is known to fall under a less restrictive scope.
   */
  ignoredScopes?: string[];
}
