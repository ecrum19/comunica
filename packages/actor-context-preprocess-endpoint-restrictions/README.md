# Comunica Endpoint Restrictions Context Preprocess Actor

[![npm version](https://badge.fury.io/js/%40comunica%2Factor-context-preprocess-endpoint-restrictions.svg)](https://www.npmjs.com/package/@comunica/actor-context-preprocess-endpoint-restrictions)

A [Context Preprocess](https://github.com/comunica/comunica/tree/master/packages/bus-context-preprocess) actor
that reads restrictions of SPARQL endpoints, such as rate limits and maximum result sizes, that users provide in the
`endpointRestrictions` context entry.

Endpoints can advertise their restrictions in their [SPARQL Service Description](https://www.w3.org/TR/sparql11-service-description/)
using the [VoRD vocabulary](https://w3id.org/vord#)
(see [`@comunica/actor-rdf-metadata-extract-vord`](https://github.com/comunica/comunica/tree/master/packages/actor-rdf-metadata-extract-vord)).
For endpoints whose restrictions are known but not advertised, or advertised incorrectly,
users can provide the restrictions themselves, either as objects or as an RDF document that describes them with VoRD.
SPARQL sources then treat them in the same way as advertised restrictions.

This module is part of the [Comunica framework](https://github.com/comunica/comunica),
and should only be used by [developers that want to build their own query engine](https://comunica.dev/docs/modify/).

[Click here if you just want to query with Comunica](https://comunica.dev/docs/query/).

## Usage

The `endpointRestrictions` context entry maps endpoint URLs to their restrictions.
Each value is either a list of restriction objects, or the path or URL of a VoRD description:

```javascript
const bindingsStream = await engine.queryBindings(`SELECT * WHERE { ?s ?p ?o } LIMIT 100`, {
  sources: [ 'https://query.wikidata.org/sparql', 'https://dbpedia.org/sparql' ],
  endpointRestrictions: {
    // At most 60 requests per minute, rejected with 429 beyond that, and at most 60 seconds per query.
    'https://query.wikidata.org/sparql': [
      { type: 'rate', maxValue: 60, windowDuration: 'PT1M', returnsStatusCode: 429 },
      { type: 'responseTime', maxValue: 60, enforcement: 'reject' },
    ],
    // The restrictions described in a VoRD document.
    'https://dbpedia.org/sparql': 'https://example.org/dbpedia-restrictions.ttl',
  },
});
```

On the command line, the entry is passed in the context, as a JSON string or as the path of a JSON file:

```bash
comunica-sparql https://query.wikidata.org/sparql \
  -q 'SELECT * WHERE { ?s ?p ?o } LIMIT 100' \
  -c '{ "endpointRestrictions": { "https://query.wikidata.org/sparql": [ { "type": "rate", "maxValue": 60, "windowDuration": "PT1M" } ] } }'
```

```bash
comunica-sparql-file https://query.wikidata.org/sparql \
  -q 'SELECT * WHERE { ?s ?p ?o } LIMIT 100' \
  -c '{ "endpointRestrictions": { "https://query.wikidata.org/sparql": "wikidata-restrictions.ttl" } }'
```

### Endpoints

Each key is the URL of a SPARQL endpoint:
either the URL by which it is queried (as a source or in a `SERVICE` clause),
or the `sd:endpoint` of its service description, if the endpoint has one.
URLs are compared after normalization, so the scheme and host are case-insensitive,
and `https://example.org` matches `https://example.org/`. Paths must match exactly.

The restrictions given for an endpoint **replace** the ones that it advertises, if any.
To add restrictions to the advertised ones, list the advertised ones as well.
An empty list (`[]`) makes Comunica ignore the advertised restrictions.

Restrictions are tracked per host by `@comunica/actor-http-limit-restrictions`,
so endpoints on the same host should be given the same restrictions.

### Modes

The `endpointRestrictionsMode` context entry determines what happens with the restrictions that an endpoint advertises
when restrictions are provided for it. It applies to all endpoints in `endpointRestrictions`:

| Mode | Service description | Restrictions used | Comparison |
|---|---|---|---|
| `replace` (default) | Fetched as for any source | The provided ones | No |
| `compare` | Always fetched, also for a single source of type `sparql` (whose service description is otherwise not fetched) | The provided ones | Yes: Comunica logs whether the provided restrictions match, partially match, or do not match the advertised ones |
| `provided-only` | Not fetched | The provided ones | No |

```javascript
const bindingsStream = await engine.queryBindings(`SELECT * WHERE { ?s ?p ?o } LIMIT 100`, {
  sources: [ 'https://query.wikidata.org/sparql' ],
  endpointRestrictions: {
    'https://query.wikidata.org/sparql': [ { type: 'rate', maxValue: 60, windowDuration: 'PT1M' } ],
  },
  endpointRestrictionsMode: 'compare',
});
```

```bash
comunica-sparql https://query.wikidata.org/sparql -l info \
  -q 'SELECT * WHERE { ?s ?p ?o } LIMIT 100' \
  -c '{ "endpointRestrictions": { "https://query.wikidata.org/sparql": [ { "type": "rate", "maxValue": 60, "windowDuration": "PT1M" } ] }, "endpointRestrictionsMode": "compare" }'
```

**`compare`** pairs every provided restriction with an advertised restriction of the same type.
Two restrictions agree if every field that both of them specify has the same value
(a field that only one of them specifies does not count as a difference, and restrictions are strictly enforced unless `hardRestriction` is `false`).
The result is logged once per endpoint and query:
* **match** (logged as info, so shown with `-l info`): every provided restriction agrees with an advertised one, and vice versa.
  For example: `The restrictions provided for https://query.wikidata.org/sparql match the ones it advertises (1 restriction)`.
* **partial match** (logged as a warning): some restrictions agree.
  The message lists the fields that differ, the provided restrictions that are not advertised, and the advertised ones that are not provided.
  For example: `The restrictions provided for … partially match the ones it advertises: 1 of 2 match; resultSize differs in maxValue (provided 1000, advertised 10000)`.
* **no match** (logged as a warning): no restriction agrees, or the endpoint advertises no restrictions.
  For example: `The restrictions provided for … do not match the ones it advertises: it advertises no restrictions`.

If the service description cannot be read, a warning says that the restrictions could not be compared.
The full comparison is attached to the log entry as `comparison`, for loggers that keep structured data.

**`provided-only`** treats every source whose URL has provided restrictions as a SPARQL endpoint, and queries it at that URL
without requesting its service description, also within a federation of several sources.
So any other information in the service description, such as VoID statistics or a different `sd:endpoint`, is not used either.
This only works if the restrictions are provided for the URL by which the endpoint is queried:
if they are provided for its `sd:endpoint` instead, the service description is fetched to find that URL,
and only the provided restrictions are used.

### Restriction objects

Each object describes one restriction.
The fields correspond to the properties of `vord:Restriction` in the VoRD vocabulary:

| Field | Value | VoRD property |
|---|---|---|
| `type` | `rate`, `quota`, `resultSize`, `concurrentRequests`, `responseTime`, `costModel`, `serverLoad` or `other`, or a VoRD restriction class such as `vord:RateRestriction`. May be omitted if it follows from the `metric`. | `rdf:type` |
| `maxValue` | The limit, a number. See below for its meaning per type. | `vord:maxValue` |
| `windowDuration` | The window in which a rate or quota is counted: a number of milliseconds, or an [xsd:duration](https://www.w3.org/TR/xmlschema11-2/#duration) such as `'PT1M'` (one minute) or `'P1D'` (one day). | `vord:windowDuration` |
| `burstValue` | For rate and quota restrictions: the number of requests that may be sent in a short burst. | `vord:burstValue` |
| `minValue` | A minimum threshold, a number. | `vord:minValue` |
| `metric` | The measured metric, an IRI: `vord:requestsPerWindow`, `vord:requestsPerDay`, `vord:resultBindings`, `vord:evaluationTime` or `vord:estimatedCostUnits`. | `vord:metric` |
| `unit` | The unit of the threshold values, an IRI. | `vord:unit` |
| `returnsStatusCode` | The HTTP status code that the endpoint returns when the restriction is exceeded, such as `429`. | `vord:returnsStatusCode` |
| `retryAfterHint` | How long to wait before retrying: milliseconds, or an xsd:duration. | `vord:retryAfterHint` |
| `httpSignalHeader` | The name of the HTTP header that signals the status of the restriction, such as `'Retry-After'`. | `vord:httpSignalHeader` |
| `scope` | The scope in which the restriction is counted, an IRI such as `vord:PerClientIP`. | `vord:hasScope` |
| `enforcement` | What the endpoint does when the restriction is reached: `reject`, `truncate`, `queue`, `throttle`, `degrade` or `other`, or a VoRD enforcement mode such as `vord:RejectRequest`. | `vord:enforcement` |
| `hardRestriction` | `true` if the restriction is strictly enforced, `false` if it is advisory. Defaults to strictly enforced. | `vord:hardRestriction` |
| `costModel` | The cost model of a cost model restriction, an IRI. | `vord:costModel` |

IRIs may use the `vord:` prefix (`https://w3id.org/vord#`).

Comunica acts on these types of restrictions:

| `type` | Meaning of `maxValue` | What Comunica does |
|---|---|---|
| `rate` | Requests per `windowDuration` | Spaces out requests, so that at most `maxValue` requests are sent within any `windowDuration`. With a `burstValue`, at most `burstValue` requests are sent within `windowDuration × burstValue / maxValue`. Join planning takes the time between requests (`windowDuration / maxValue`) into account, and count queries are skipped if that time is longer than the count timeout. |
| `quota` | Requests per `windowDuration` | The same as `rate`, typically with a window of a day. |
| `concurrentRequests` | Concurrent requests | Sends at most `maxValue` requests at the same time. |
| `resultSize` | Results per response | Requests results in pages of `maxValue` results (with `LIMIT` and `OFFSET`), so that they are not truncated. |
| `responseTime` | Evaluation time in **seconds** | If `enforcement` is `reject`, requests time out after this time. |
| `costModel`, `serverLoad`, `other` | | Nothing; they are only informative. |

For `rate`, `quota` and `concurrentRequests` restrictions, `returnsStatusCode` is added to the status codes that are retried,
and `retryAfterHint` sets the delay before a retry, unless the context sets `httpRetryDelayFallback`.
Retries only happen if the context sets `httpRetryCount`.
By default, Comunica sends fewer requests than the limits allow, as a safety margin.
How restrictions are enforced, and whether advisory restrictions and certain scopes are ignored, can be configured in
[`@comunica/actor-http-limit-restrictions`](https://github.com/comunica/comunica/tree/master/packages/actor-http-limit-restrictions)
and [`@comunica/actor-query-source-identify-hypermedia-sparql`](https://github.com/comunica/comunica/tree/master/packages/actor-query-source-identify-hypermedia-sparql).

Restriction objects are checked before the query is executed, and the query fails with an error if:
* a field is unknown (e.g. a typo such as `windowduration`), or its value has the wrong type;
* the `type` is missing and does not follow from the `metric`;
* a `rate`, `quota`, `concurrentRequests`, `resultSize` or `responseTime` restriction has no `maxValue` above 0;
* a `rate` or `quota` restriction has no `windowDuration`.
  A restriction with metric `vord:requestsPerDay` and no window gets a window of one day.

### VoRD descriptions

Instead of objects, the restrictions of an endpoint can be read from an RDF document,
which is written like a SPARQL service description with VoRD restrictions.
For example, the following Turtle file describes the same restrictions as the objects for Wikidata above:

```turtle
@prefix sd: <http://www.w3.org/ns/sparql-service-description#> .
@prefix vord: <https://w3id.org/vord#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

[] a sd:Service ;
  sd:endpoint <https://query.wikidata.org/sparql> ;
  vord:hasRestriction [
    a vord:RateRestriction ;
    vord:metric vord:requestsPerWindow ;
    vord:maxValue 60 ;
    vord:windowDuration "PT1M"^^xsd:duration ;
    vord:returnsStatusCode 429
  ], [
    a vord:ResponseTimeRestriction ;
    vord:metric vord:evaluationTime ;
    vord:maxValue 60 ;
    vord:enforcement vord:RejectRequest
  ] .
```

The document is read in the same way as service descriptions that endpoints advertise:
* Restrictions are resources linked to a service with `vord:hasRestriction`,
  or with `sd:feature` if they are typed as `vord:Restriction` or one of its subclasses.
  Their properties are those in the table of restriction objects above.
* The restrictions of the service whose `sd:endpoint` (or IRI) is the endpoint URL are used.
  If no service matches, and the document describes the restrictions of a single service, those are used.
  So a document can describe several endpoints, and a document with a single service can be used for any endpoint.
* The query fails if the document cannot be read, or describes no restrictions for the endpoint.
  This also applies in lenient mode.

Documents can be in any RDF format that the engine can parse, such as Turtle or JSON-LD,
which is determined from the file extension or the `Content-Type` of the response.
They are read once per query.

**Local files:** URLs work in all engines.
Local files (paths relative to the current working directory, or `file://` URLs)
can only be read by engines that can query local files, such as
[`@comunica/query-sparql-file`](https://github.com/comunica/comunica/tree/master/engines/query-sparql-file)
(`comunica-sparql-file` on the command line).
Other engines, such as `@comunica/query-sparql`, fail with an error that says so.

## Install

```bash
$ yarn add @comunica/actor-context-preprocess-endpoint-restrictions
```

## Configure

After installing, this package can be added to your engine's configuration as follows:
```text
{
  "@context": [
    ...
    "https://linkedsoftwaredependencies.org/bundles/npm/@comunica/actor-context-preprocess-endpoint-restrictions/^5.0.0/components/context.jsonld"
  ],
  "actors": [
    ...
    {
      "@id": "urn:comunica:default:context-preprocess/actors#endpoint-restrictions",
      "@type": "ActorContextPreprocessEndpointRestrictions",
      "mediatorDereferenceRdf": { "@id": "urn:comunica:default:dereference-rdf/mediators#main" }
    }
  ]
}
```

This actor must run after `@comunica/actor-context-preprocess-convert-shortcuts`,
which converts the `endpointRestrictions` shortcut into the full context key.

### Config Parameters

* `mediatorDereferenceRdf`: A mediator over the [Dereference RDF bus](https://github.com/comunica/comunica/tree/master/packages/bus-dereference-rdf), for reading VoRD descriptions.

### Context entries

* `KeysQuerySourceIdentify.endpointRestrictions` (`endpointRestrictions`): the restrictions that users provide, as described above. This entry is removed once it has been read.
* `KeysQuerySourceIdentify.endpointRestrictionsMode` (`endpointRestrictionsMode`): `replace` (default), `compare` or `provided-only`, as described above. This actor checks its value; `@comunica/actor-query-source-dereference-link-force-sparql` and `@comunica/actor-query-source-identify-hypermedia-sparql` act on it.
* `KeysQuerySourceIdentify.endpointRestrictionsResolved`: set by this actor, with the restrictions (as `IEndpointRestriction` objects from `@comunica/types`) keyed by normalized endpoint URL. `@comunica/actor-query-source-identify-hypermedia-sparql` uses them instead of the advertised restrictions.
