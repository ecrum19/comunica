# Comunica HTTP Limit Restrictions Actor

[![npm version](https://badge.fury.io/js/%40comunica%2Factor-http-limit-restrictions.svg)](https://www.npmjs.com/package/@comunica/actor-http-limit-restrictions)

An [HTTP](https://github.com/comunica/comunica/tree/master/packages/bus-http) actor that respects
the operational restrictions that endpoints advertise in their service descriptions,
such as those described using the [VoRD vocabulary](https://w3id.org/vord#)
(see [`@comunica/actor-rdf-metadata-extract-vord`](https://github.com/comunica/comunica/tree/master/packages/actor-rdf-metadata-extract-vord)).

This actor only acts on requests whose context contains endpoint restrictions (`KeysHttp.endpointRestrictions`),
which query sources such as SPARQL endpoints set for their own requests.
These are the restrictions that the endpoint advertises, or the ones that users provide in the `endpointRestrictions`
context entry (see [`@comunica/actor-context-preprocess-endpoint-restrictions`](https://github.com/comunica/comunica/tree/master/packages/actor-context-preprocess-endpoint-restrictions)).
Restrictions are tracked per host:

* **Rate and quota restrictions** limit the number of requests to `maxValue` within any `windowDuration`. If a `burstValue` is given, at most `burstValue` requests are sent within the time they would take at the steady rate. Requests that do not fit are delayed. The safety margin reduces the number of requests and extends the windows, so that requests sent at the edge of a window still arrive within the limit when request latencies vary.
* **Concurrent request restrictions** limit the number of requests whose response body is still being consumed to `maxValue`.
* **Response time restrictions** that reject requests set the request timeout (`httpTimeout`) to their `maxValue` seconds (extended by the safety margin), unless a timeout was already set.
* **Status codes and retry hints** of rate, quota and concurrent request restrictions are added to the retried status codes (`httpRetryStatusCodes`) and set the fallback retry delay (`httpRetryDelayFallback`), unless a fallback delay was already set. These only take effect if retries are enabled (`httpRetryCount`).

If an endpoint advertises multiple restrictions of the same kind (e.g. for different scopes), all of them are respected, so the most restrictive one applies.
Requests that are aborted while they wait (via `httpAbortSignal` or their own signal) are dropped, so they do not take up the time or slot of other requests.

This module is part of the [Comunica framework](https://github.com/comunica/comunica),
and should only be used by [developers that want to build their own query engine](https://comunica.dev/docs/modify/).

[Click here if you just want to query with Comunica](https://comunica.dev/docs/query/).

## Install

```bash
$ yarn add @comunica/actor-http-limit-restrictions
```

## Configure

After installing, this package can be added to your engine's configuration as follows:

```json
{
  "@context": [
    "https://linkedsoftwaredependencies.org/bundles/npm/@comunica/actor-http-limit-restrictions/^5.0.0/components/context.jsonld"
  ],
  "actors": [
    {
      "@id": "urn:comunica:default:http/actors#limit-restrictions",
      "@type": "ActorHttpLimitRestrictions",
      "mediatorHttp": { "@id": "urn:comunica:default:http/mediators#main" },
      "beforeActors": { "@id": "urn:comunica:default:http/actors#retry" }
    }
  ]
}
```

### Config Parameters

* `mediatorHttp`: A mediator over the [HTTP bus](https://github.com/comunica/comunica/tree/master/packages/bus-http).
* `httpInvalidator`: A mediator over the [HTTP invalidate bus](https://github.com/comunica/comunica/tree/master/packages/bus-http-invalidate).
* `safetyMargin`: The fraction of the advertised request limits that may be used, in range ]0.0, 1.0]. The number of requests per window is multiplied by it, and window durations are divided by it. Defaults to `0.9`.
* `applySoftRestrictions`: If restrictions that are not strictly enforced (`vord:hardRestriction false`) should also be respected. Defaults to `true`.
* `ignoredScopes`: IRIs of scopes for which restrictions should be ignored, e.g. when the engine is known to fall under a less restrictive scope. Defaults to none.
