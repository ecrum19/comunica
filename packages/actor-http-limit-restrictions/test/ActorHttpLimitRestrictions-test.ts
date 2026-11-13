import type { IActorHttpOutput, MediatorHttp } from '@comunica/bus-http';
import type { IActionHttpInvalidate } from '@comunica/bus-http-invalidate';
import { KeysHttp } from '@comunica/context-entries';
import { ActionContext, Bus } from '@comunica/core';
import type { IActionContext, IEndpointRestriction } from '@comunica/types';
import type { IHostData, IRequestWindow } from '../lib/ActorHttpLimitRestrictions';
import { ActorHttpLimitRestrictions } from '../lib/ActorHttpLimitRestrictions';
import '@comunica/utils-jest';

describe('ActorHttpLimitRestrictions', () => {
  let bus: any;
  let actor: ActorHttpLimitRestrictions;
  let mediatorHttp: MediatorHttp;
  let actorHostData: Map<string, IHostData>;
  let invalidateListeners: ((event: IActionHttpInvalidate) => void)[];

  const url = 'http://localhost:3000/sparql';
  const host = 'localhost:3000';

  const rateRestriction: IEndpointRestriction = {
    type: 'rate',
    maxValue: 60,
    burstValue: 15,
    windowDuration: 60_000,
    hardRestriction: true,
    returnsStatusCode: 429,
    retryAfterHint: 30_000,
  };
  const concurrencyRestriction: IEndpointRestriction = {
    type: 'concurrentRequests',
    maxValue: 1,
    hardRestriction: false,
    returnsStatusCode: 503,
  };
  const responseTimeRestriction: IEndpointRestriction = {
    type: 'responseTime',
    maxValue: 9,
    enforcement: 'reject',
  };

  function createActor(
    args: Partial<{ safetyMargin: number; applySoftRestrictions: boolean; ignoredScopes: string[] }>,
  ): ActorHttpLimitRestrictions {
    return new ActorHttpLimitRestrictions({
      bus,
      safetyMargin: 0.9,
      applySoftRestrictions: true,
      httpInvalidator: <any>{
        addInvalidateListener: jest.fn(listener => invalidateListeners.push(listener)),
      },
      mediatorHttp,
      name: 'actor',
      ...args,
    });
  }

  function hostDataWith(windows: IRequestWindow[]): IHostData {
    return {
      windows,
      maxWindowDuration: Math.max(...windows.map(window => window.duration)),
      requestTimestamps: [],
      concurrencyLimit: Number.POSITIVE_INFINITY,
      activeRequests: 0,
      pendingRequests: [],
    };
  }

  function contextWith(restrictions: IEndpointRestriction[]): IActionContext {
    return new ActionContext({ [KeysHttp.endpointRestrictions.name]: restrictions });
  }

  beforeEach(() => {
    jest.resetAllMocks();
    jest.restoreAllMocks();
    bus = new Bus({ name: 'bus' });
    invalidateListeners = [];
    mediatorHttp = <any>{
      mediate: jest.fn().mockRejectedValue(new Error('mediatorHttp.mediate')),
    };
    actor = createActor({});
    actorHostData = (<any>actor).hostData;
    jest.spyOn((<any>actor), 'logDebug').mockImplementation((...args) => (<() => unknown>args[2])());
  });

  describe('test', () => {
    it('should wrap requests to endpoints with restrictions', async() => {
      await expect(actor.test({ context: contextWith([ rateRestriction ]), input: url }))
        .resolves.toPassTest({ time: 0 });
    });

    it('should not wrap requests without restrictions', async() => {
      await expect(actor.test({ context: new ActionContext(), input: url }))
        .resolves.toFailTest(`${actor.name} can only wrap requests to endpoints with restrictions`);
    });

    it('should wrap requests only once', async() => {
      await expect(actor.test({
        context: contextWith([ rateRestriction ]).set((<any>ActorHttpLimitRestrictions).keyWrapped, true),
        input: url,
      })).resolves.toFailTest(`${actor.name} can only wrap a request once`);
    });
  });

  describe('getApplicableRestrictions', () => {
    const scoped: IEndpointRestriction = { type: 'rate', scope: 'https://example.org/IgnoredScope' };
    const otherScoped: IEndpointRestriction = { type: 'rate', scope: 'https://example.org/OtherScope' };

    it('should keep all restrictions by default', () => {
      expect(actor.getApplicableRestrictions([ rateRestriction, concurrencyRestriction, scoped ]))
        .toEqual([ rateRestriction, concurrencyRestriction, scoped ]);
    });

    it('should remove soft restrictions if configured', () => {
      actor = createActor({ applySoftRestrictions: false });
      expect(actor.getApplicableRestrictions([ rateRestriction, concurrencyRestriction, responseTimeRestriction ]))
        .toEqual([ rateRestriction, responseTimeRestriction ]);
    });

    it('should remove restrictions of ignored scopes', () => {
      actor = createActor({ ignoredScopes: [ scoped.scope! ]});
      expect(actor.getApplicableRestrictions([ rateRestriction, scoped, otherScoped ]))
        .toEqual([ rateRestriction, otherScoped ]);
    });
  });

  describe('createHostData', () => {
    it('should create windows for rate and quota restrictions', () => {
      expect(actor.createHostData([
        rateRestriction,
        { type: 'quota', maxValue: 1_000, windowDuration: 86_400_000 },
      ])).toEqual({
        windows: [
          { limit: 54, duration: 66_667 },
          { limit: 13, duration: 16_667 },
          { limit: 900, duration: 96_000_000 },
        ],
        maxWindowDuration: 96_000_000,
        requestTimestamps: [],
        concurrencyLimit: Number.POSITIVE_INFINITY,
        activeRequests: 0,
        pendingRequests: [],
      });
    });

    it('should allow at least one request per window', () => {
      expect(actor.createHostData([
        { type: 'rate', maxValue: 1, burstValue: 0, windowDuration: 1_000 },
      ]).windows).toEqual([{ limit: 1, duration: 1_112 }]);
    });

    it('should ignore burst values that are not lower than the max value', () => {
      expect(actor.createHostData([
        { type: 'rate', maxValue: 10, burstValue: 10, windowDuration: 1_000 },
      ]).windows).toEqual([{ limit: 9, duration: 1_112 }]);
    });

    it('should use the advertised limits without a safety margin', () => {
      expect(createActor({ safetyMargin: 1 }).createHostData([ rateRestriction ]).windows).toEqual([
        { limit: 60, duration: 60_000 },
        { limit: 15, duration: 15_000 },
      ]);
    });

    it('should leave time between bursts at window edges', () => {
      // The endpoint allows 10 requests per 6 seconds, and receives each burst after a varying latency.
      const hostData = actor.createHostData([{ type: 'rate', maxValue: 10, windowDuration: 6_000 }]);
      const delays = Array.from({ length: 10 }, () => ActorHttpLimitRestrictions.reserveRequestTime(hostData, 0));
      expect(delays).toEqual([ 0, 0, 0, 0, 0, 0, 0, 0, 0, 6_667 ]);
      // The second burst is sent 667ms after the endpoint's window, which tolerates that much latency difference.
    });

    it('should use the lowest concurrency limit', () => {
      expect(actor.createHostData([
        { type: 'concurrentRequests', maxValue: 5 },
        { type: 'concurrentRequests', maxValue: 3 },
      ]).concurrencyLimit).toBe(3);
    });

    it('should ignore restrictions without limits or windows', () => {
      expect(actor.createHostData([
        { type: 'rate', windowDuration: 1_000 },
        { type: 'rate', maxValue: -1, windowDuration: 1_000 },
        { type: 'rate', maxValue: 10 },
        { type: 'concurrentRequests' },
        responseTimeRestriction,
        { type: 'resultSize', maxValue: 10_000 },
      ])).toEqual({
        windows: [],
        maxWindowDuration: 0,
        requestTimestamps: [],
        concurrencyLimit: Number.POSITIVE_INFINITY,
        activeRequests: 0,
        pendingRequests: [],
      });
    });
  });

  describe('getRequestContext', () => {
    it('should not modify the context without relevant restrictions', () => {
      const context = new ActionContext();
      expect(actor.getRequestContext(context, [
        { type: 'resultSize', maxValue: 10_000 },
        { type: 'rate', maxValue: 10, windowDuration: 1_000 },
        { type: 'responseTime', maxValue: 10, enforcement: 'throttle' },
        { type: 'responseTime', enforcement: 'reject' },
        { type: 'responseTime', maxValue: 0, enforcement: 'reject' },
      ])).toBe(context);
    });

    it('should set the timeout, retry status codes and retry delay', () => {
      const context = actor.getRequestContext(new ActionContext(), [
        rateRestriction,
        concurrencyRestriction,
        { type: 'quota', returnsStatusCode: 429, retryAfterHint: 60_000 },
        responseTimeRestriction,
        { ...responseTimeRestriction, maxValue: 18 },
      ]);
      expect(context.get(KeysHttp.httpTimeout)).toBe(10_000);
      expect(context.get(KeysHttp.httpRetryStatusCodes)).toEqual([ 429, 503 ]);
      expect(context.get(KeysHttp.httpRetryDelayFallback)).toBe(60_000);
    });

    it('should not override an existing timeout and retry delay', () => {
      const context = actor.getRequestContext(new ActionContext({
        [KeysHttp.httpTimeout.name]: 1_000,
        [KeysHttp.httpRetryDelayFallback.name]: 2_000,
        [KeysHttp.httpRetryStatusCodes.name]: [ 500, 429 ],
      }), [ rateRestriction, responseTimeRestriction ]);
      expect(context.get(KeysHttp.httpTimeout)).toBe(1_000);
      expect(context.get(KeysHttp.httpRetryDelayFallback)).toBe(2_000);
      expect(context.get(KeysHttp.httpRetryStatusCodes)).toEqual([ 500, 429 ]);
    });
  });

  describe('reserveRequestTime', () => {
    it('should not delay requests without windows', () => {
      const hostData = actor.createHostData([]);
      expect(ActorHttpLimitRestrictions.reserveRequestTime(hostData, 0)).toBe(0);
      expect(ActorHttpLimitRestrictions.reserveRequestTime(hostData, 0)).toBe(0);
      expect(hostData.requestTimestamps).toEqual([]);
    });

    it('should delay requests that do not fit within a window', () => {
      const hostData = hostDataWith([{ limit: 2, duration: 1_000 }]);
      expect(ActorHttpLimitRestrictions.reserveRequestTime(hostData, 0)).toBe(0);
      expect(ActorHttpLimitRestrictions.reserveRequestTime(hostData, 0)).toBe(0);
      expect(ActorHttpLimitRestrictions.reserveRequestTime(hostData, 0)).toBe(1_000);
      expect(ActorHttpLimitRestrictions.reserveRequestTime(hostData, 500)).toBe(500);
      expect(ActorHttpLimitRestrictions.reserveRequestTime(hostData, 500)).toBe(1_500);
      expect(hostData.requestTimestamps).toEqual([ 0, 0, 1_000, 1_000, 2_000 ]);
    });

    it('should respect all windows', () => {
      const hostData = hostDataWith([{ limit: 4, duration: 4_000 }, { limit: 2, duration: 2_000 }]);
      expect(ActorHttpLimitRestrictions.reserveRequestTime(hostData, 0)).toBe(0);
      expect(ActorHttpLimitRestrictions.reserveRequestTime(hostData, 0)).toBe(0);
      expect(ActorHttpLimitRestrictions.reserveRequestTime(hostData, 0)).toBe(2_000);
      expect(ActorHttpLimitRestrictions.reserveRequestTime(hostData, 0)).toBe(2_000);
      expect(ActorHttpLimitRestrictions.reserveRequestTime(hostData, 0)).toBe(4_000);
    });

    it('should forget requests outside all windows', () => {
      const hostData = hostDataWith([{ limit: 2, duration: 1_000 }]);
      expect(ActorHttpLimitRestrictions.reserveRequestTime(hostData, 0)).toBe(0);
      expect(ActorHttpLimitRestrictions.reserveRequestTime(hostData, 500)).toBe(0);
      expect(ActorHttpLimitRestrictions.reserveRequestTime(hostData, 1_200)).toBe(0);
      expect(hostData.requestTimestamps).toEqual([ 500, 1_200 ]);
    });
  });

  describe('cancelRequestTime', () => {
    it('should free the reserved time for later requests', () => {
      const hostData = hostDataWith([{ limit: 1, duration: 1_000 }]);
      expect(ActorHttpLimitRestrictions.reserveRequestTime(hostData, 0)).toBe(0);
      expect(ActorHttpLimitRestrictions.reserveRequestTime(hostData, 0)).toBe(1_000);
      ActorHttpLimitRestrictions.cancelRequestTime(hostData, 1_000);
      expect(hostData.requestTimestamps).toEqual([ 0 ]);
      expect(ActorHttpLimitRestrictions.reserveRequestTime(hostData, 0)).toBe(1_000);
    });

    it('should ignore unknown request times', () => {
      const hostData = hostDataWith([{ limit: 1, duration: 1_000 }]);
      ActorHttpLimitRestrictions.reserveRequestTime(hostData, 0);
      ActorHttpLimitRestrictions.cancelRequestTime(hostData, 500);
      expect(hostData.requestTimestamps).toEqual([ 0 ]);
    });
  });

  describe('acquireSlot and releaseSlot', () => {
    it('should hand over slots to waiting requests', async() => {
      const hostData = actor.createHostData([ concurrencyRestriction ]);
      await ActorHttpLimitRestrictions.acquireSlot(hostData);
      expect(hostData.activeRequests).toBe(1);

      let acquired = false;
      const pending = ActorHttpLimitRestrictions.acquireSlot(hostData).then(() => {
        acquired = true;
      });
      await new Promise(setImmediate);
      expect(acquired).toBeFalsy();
      expect(hostData.pendingRequests).toHaveLength(1);

      ActorHttpLimitRestrictions.releaseSlot(hostData);
      await pending;
      expect(acquired).toBeTruthy();
      expect(hostData.activeRequests).toBe(1);

      ActorHttpLimitRestrictions.releaseSlot(hostData);
      expect(hostData.activeRequests).toBe(0);
    });

    it('should not acquire slots for aborted requests', async() => {
      const hostData = actor.createHostData([ concurrencyRestriction ]);
      await expect(ActorHttpLimitRestrictions.acquireSlot(hostData, AbortSignal.abort(new Error('aborted'))))
        .rejects.toThrow('aborted');
      expect(hostData.activeRequests).toBe(0);
    });

    it('should stop waiting for a slot when aborted', async() => {
      const hostData = actor.createHostData([ concurrencyRestriction ]);
      await ActorHttpLimitRestrictions.acquireSlot(hostData);
      const controller = new AbortController();
      const aborted = ActorHttpLimitRestrictions.acquireSlot(hostData, controller.signal);
      const waiting = ActorHttpLimitRestrictions.acquireSlot(hostData);
      expect(hostData.pendingRequests).toHaveLength(2);

      controller.abort(new Error('aborted'));
      await expect(aborted).rejects.toThrow('aborted');
      expect(hostData.pendingRequests).toHaveLength(1);

      ActorHttpLimitRestrictions.releaseSlot(hostData);
      await waiting;
      expect(hostData.activeRequests).toBe(1);
    });

    it('should not abort requests that already received a slot', async() => {
      const hostData = actor.createHostData([ concurrencyRestriction ]);
      await ActorHttpLimitRestrictions.acquireSlot(hostData);
      const controller = new AbortController();
      const pending = ActorHttpLimitRestrictions.acquireSlot(hostData, controller.signal);
      ActorHttpLimitRestrictions.releaseSlot(hostData);
      controller.abort(new Error('aborted'));
      await expect(pending).resolves.toBeUndefined();
      expect(hostData.activeRequests).toBe(1);
    });
  });

  describe('sleep', () => {
    it('should wait for the given time', async() => {
      await expect(ActorHttpLimitRestrictions.sleep(1)).resolves.toBeUndefined();
      await expect(ActorHttpLimitRestrictions.sleep(1, new AbortController().signal)).resolves.toBeUndefined();
    });

    it('should stop waiting when aborted', async() => {
      const controller = new AbortController();
      const sleep = ActorHttpLimitRestrictions.sleep(60_000, controller.signal);
      controller.abort(new Error('aborted'));
      await expect(sleep).rejects.toThrow('aborted');
    });
  });

  describe('getAbortSignal', () => {
    it('should return undefined without signals', () => {
      expect(ActorHttpLimitRestrictions.getAbortSignal({ context: new ActionContext(), input: url })).toBeUndefined();
    });

    it('should return the signal of the request or the context', () => {
      const signal = new AbortController().signal;
      expect(ActorHttpLimitRestrictions.getAbortSignal({ context: new ActionContext(), input: url, init: { signal }}))
        .toBe(signal);
      expect(ActorHttpLimitRestrictions.getAbortSignal({
        context: new ActionContext({ [KeysHttp.httpAbortSignal.name]: signal }),
        input: url,
      })).toBe(signal);
    });

    it('should combine the signals of the request and the context', () => {
      const controller = new AbortController();
      const signal = ActorHttpLimitRestrictions.getAbortSignal({
        context: new ActionContext({ [KeysHttp.httpAbortSignal.name]: controller.signal }),
        input: url,
        init: { signal: new AbortController().signal },
      })!;
      expect(signal.aborted).toBeFalsy();
      controller.abort();
      expect(signal.aborted).toBeTruthy();
    });
  });

  describe('releaseOnBodyEnd', () => {
    it('should release immediately for responses without body', () => {
      const release = jest.fn();
      const response = new Response(null, { status: 204 });
      expect(ActorHttpLimitRestrictions.releaseOnBodyEnd(response, release)).toBe(response);
      expect(release).toHaveBeenCalledTimes(1);
    });

    it('should release once the body has been consumed', async() => {
      const release = jest.fn();
      const response = <IActorHttpOutput> new Response('body', {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'text/plain' },
      });
      response.cachePolicy = <any> 'policy';
      response.fromCache = true;
      const wrapped = ActorHttpLimitRestrictions.releaseOnBodyEnd(response, release);
      expect(wrapped.status).toBe(200);
      expect(wrapped.statusText).toBe('OK');
      expect(wrapped.headers.get('content-type')).toBe('text/plain');
      expect(wrapped.cachePolicy).toBe('policy');
      expect(wrapped.fromCache).toBe(true);
      expect(release).not.toHaveBeenCalled();
      await expect(wrapped.text()).resolves.toBe('body');
      expect(release).toHaveBeenCalledWith();
    });

    it('should release once the body errors', async() => {
      const release = jest.fn();
      const body = new ReadableStream({
        start(controller) {
          controller.error(new Error('body error'));
        },
      });
      const wrapped = ActorHttpLimitRestrictions.releaseOnBodyEnd(new Response(body), release);
      await expect(wrapped.text()).rejects.toThrow('body error');
      expect(release).toHaveBeenCalledWith(new Error('body error'));
    });
  });

  describe('run', () => {
    beforeEach(() => {
      jest.spyOn(Date, 'now').mockReturnValue(0);
      jest.spyOn(globalThis, 'setTimeout').mockImplementation(<any> ((callback: any) => callback()));
    });

    it('should pass requests with the enriched context', async() => {
      const response = new Response('body');
      jest.spyOn(mediatorHttp, 'mediate').mockResolvedValue(response);
      const context = contextWith([ rateRestriction, responseTimeRestriction ]);
      await expect(actor.run({ context, input: url })).resolves.toBe(response);
      expect(mediatorHttp.mediate).toHaveBeenCalledWith({
        context: actor.getRequestContext(context, [ rateRestriction, responseTimeRestriction ])
          .set((<any>ActorHttpLimitRestrictions).keyWrapped, true),
        input: url,
      });
      expect(globalThis.setTimeout).not.toHaveBeenCalled();
      expect(actorHostData.get(host)!.requestTimestamps).toEqual([ 0 ]);
    });

    it('should delay requests that exceed the rate limit', async() => {
      jest.spyOn(mediatorHttp, 'mediate').mockImplementation(async() => new Response('body'));
      const context = contextWith([{ type: 'rate', maxValue: 1, windowDuration: 1_000 }]);
      await actor.run({ context, input: url });
      await actor.run({ context, input: url });
      expect(globalThis.setTimeout).toHaveBeenCalledTimes(1);
      expect(globalThis.setTimeout).toHaveBeenNthCalledWith(1, expect.any(Function), 1_112);
      expect(mediatorHttp.mediate).toHaveBeenCalledTimes(2);
      expect(actorHostData.get(host)!.requestTimestamps).toEqual([ 0, 1_112 ]);
    });

    it('should limit the number of concurrent requests until bodies are consumed', async() => {
      jest.spyOn(mediatorHttp, 'mediate').mockImplementation(async() => new Response('body'));
      const context = contextWith([ concurrencyRestriction ]);

      const response1 = await actor.run({ context, input: url });
      let response2: Response | undefined;
      const pending = actor.run({ context, input: url }).then((response) => {
        response2 = response;
      });
      await new Promise(setImmediate);
      expect(mediatorHttp.mediate).toHaveBeenCalledTimes(1);
      expect(response2).toBeUndefined();

      await expect(response1.text()).resolves.toBe('body');
      await pending;
      expect(mediatorHttp.mediate).toHaveBeenCalledTimes(2);
      await expect(response2!.text()).resolves.toBe('body');
      expect(actorHostData.get(host)!.activeRequests).toBe(0);
    });

    it('should not send or reserve time for aborted requests', async() => {
      const context = contextWith([ rateRestriction, concurrencyRestriction ]);
      await expect(actor.run({ context, input: url, init: { signal: AbortSignal.abort(new Error('aborted')) }}))
        .rejects.toThrow('aborted');
      expect(mediatorHttp.mediate).not.toHaveBeenCalled();
      expect(actorHostData.get(host)!.requestTimestamps).toEqual([]);
      expect(actorHostData.get(host)!.activeRequests).toBe(0);
    });

    it('should release the slot of requests that are aborted when they receive it', async() => {
      jest.spyOn(mediatorHttp, 'mediate').mockImplementation(async() => new Response('body'));
      const context = contextWith([ concurrencyRestriction ]);
      await actor.run({ context, input: url });
      const controller = new AbortController();
      const pending = actor.run({ context, input: url, init: { signal: controller.signal }});
      await new Promise(setImmediate);

      ActorHttpLimitRestrictions.releaseSlot(actorHostData.get(host)!);
      controller.abort(new Error('aborted'));
      await expect(pending).rejects.toThrow('aborted');
      expect(mediatorHttp.mediate).toHaveBeenCalledTimes(1);
      expect(actorHostData.get(host)!.activeRequests).toBe(0);
    });

    it('should cancel the reserved time of requests that are aborted while delayed', async() => {
      jest.spyOn(mediatorHttp, 'mediate').mockImplementation(async() => new Response('body'));
      const context = contextWith([{ type: 'rate', maxValue: 1, windowDuration: 1_000 }]);
      await actor.run({ context, input: url });
      jest.spyOn(globalThis, 'setTimeout').mockImplementation(<any> (() => 0));
      const controller = new AbortController();
      const pending = actor.run({ context, input: url, init: { signal: controller.signal }});
      await new Promise(setImmediate);
      expect(actorHostData.get(host)!.requestTimestamps).toEqual([ 0, 1_112 ]);

      controller.abort(new Error('aborted'));
      await expect(pending).rejects.toThrow('aborted');
      expect(mediatorHttp.mediate).toHaveBeenCalledTimes(1);
      expect(actorHostData.get(host)!.requestTimestamps).toEqual([ 0 ]);
    });

    it('should release slots of failed requests', async() => {
      const context = contextWith([ concurrencyRestriction ]);
      await expect(actor.run({ context, input: url })).rejects.toThrow('mediatorHttp.mediate');
      expect(actorHostData.get(host)!.activeRequests).toBe(0);
    });

    it('should reuse the data of a host', async() => {
      jest.spyOn(mediatorHttp, 'mediate').mockImplementation(async() => new Response('body'));
      await actor.run({ context: contextWith([ rateRestriction ]), input: url });
      const hostData = actorHostData.get(host);
      await actor.run({ context: contextWith([ concurrencyRestriction ]), input: `${url}?query=x` });
      expect(actorHostData.get(host)).toBe(hostData);
      expect(actorHostData.size).toBe(1);
    });
  });

  describe('handleHttpInvalidateEvent', () => {
    beforeEach(() => {
      actorHostData.set(host, actor.createHostData([]));
      actorHostData.set('example.org', actor.createHostData([]));
    });

    it('should remove the data of an invalidated host', () => {
      invalidateListeners[0]({ url, context: new ActionContext() });
      expect([ ...actorHostData.keys() ]).toEqual([ 'example.org' ]);
    });

    it('should remove the data of all hosts', () => {
      invalidateListeners[0]({ context: new ActionContext() });
      expect(actorHostData.size).toBe(0);
    });
  });
});
