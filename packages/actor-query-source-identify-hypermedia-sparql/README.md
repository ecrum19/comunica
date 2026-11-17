# Comunica SPARQL Query Source Identify Hypermedia Actor

[![npm version](https://badge.fury.io/js/%40comunica%2Factor-query-source-identify-hypermedia-sparql.svg)](https://www.npmjs.com/package/@comunica/actor-query-source-identify-hypermedia-sparql)

A [Query Source Identify Hypermedia](https://github.com/comunica/comunica/tree/master/packages/bus-query-source-identify-hypermedia) actor that handles [SPARQL endpoints](https://www.w3.org/TR/sparql11-protocol/).

This module is part of the [Comunica framework](https://github.com/comunica/comunica),
and should only be used by [developers that want to build their own query engine](https://comunica.dev/docs/modify/).

[Click here if you just want to query with Comunica](https://comunica.dev/docs/query/).

## Install

```bash
$ yarn add @comunica/actor-query-source-identify-hypermedia-sparql
```

## Configure

After installing, this package can be added to your engine's configuration as follows:
```text
{
  "@context": [
    ...
    "https://linkedsoftwaredependencies.org/bundles/npm/@comunica/actor-query-source-identify-hypermedia-sparql/^1.0.0/components/context.jsonld"
  ],
  "actors": [
    ...
    {
      "@id": "urn:comunica:default:query-source-identify-hypermedia/actors#sparql",
      "@type": "ActorQuerySourceIdentifyHypermediaSparql",
      "mediatorHttp": { "@id": "urn:comunica:default:http/mediators#main" },
      "mediatorMergeBindingsContext": { "@id": "urn:comunica:default:merge-bindings-context/mediators#main" },
      "mediatorQuerySerialize": { "@id": "urn:comunica:default:query-serialize/mediators#main" },
      "sparqlServerSoftwarePatterns": ["Virtuoso", "Fuseki"]
    }
  ]
}
```

### Config Parameters

* `mediatorHttp`: A mediator over the [HTTP bus](https://github.com/comunica/comunica/tree/master/packages/bus-http).
* `mediatorMergeBindingsContext`: A mediator over the [Merge Bindings Context bus](https://github.com/comunica/comunica/tree/master/packages/bus-merge-bindings-context).
* `mediatorQuerySerialize`: A mediator over the [Query Serialize bus](https://github.com/comunica/comunica/tree/master/packages/bus-query-serialize).
* `checkUrlSuffix`: If URLs ending with '/sparql' should also be considered SPARQL endpoints, defaults to `true`.
* `forceHttpGet`: If queries should be sent via HTTP GET instead of POST, defaults to `false`.
* `forceSourceType`: Forces all sources provided to be interpreted as SPARQL endpoints, defaults to `false`.
* `cacheSize`: The cache size for COUNT queries, defaults to `1024`.
* `bindMethod`: The query operation for communicating bindings, defaults to `'values'`, alt: `'union'` or `'filter'`.
* `countTimeout`: Timeout in ms of how long count queries are allowed to take. If the timeout is reached, an infinity cardinality is returned. For endpoints that advertise restrictions, requests may be delayed to respect them, so the timeout only starts once the count request is sent. Defaults to `3000`.
* `cardinalityCountQueries`: If count queries should be sent to obtain the cardinality of (sub)queries. If set to false, resulting cardinalities will always be considered infinity. Defaults to `true`
* `cardinalityEstimateConstruction`: If cardinality estimates for larger queries should be constructed locally from (sub)query cardinalities when possible. Defaults to `false`. If set to false, count queries will be sent for every operation at all levels.
* `sparqlServerSoftwarePatterns`: An optional list of regular expressions to match against the `Server` HTTP response header. If a match is found, the source is identified as a SPARQL endpoint.
* `restrictionAwarePlanning`: If the restrictions of endpoints (see below) should be taken into account when querying them: results are requested in pages if they would be truncated, the minimal time between requests is exposed to the query planner, and count queries are skipped if that time is longer than `countTimeout`. Defaults to `true`.

## Endpoint restrictions

Endpoints can advertise restrictions, such as rate limits and maximum result sizes, in their service description using the [VoRD vocabulary](https://w3id.org/vord#), which [`@comunica/actor-rdf-metadata-extract-vord`](https://github.com/comunica/comunica/tree/master/packages/actor-rdf-metadata-extract-vord) extracts.
Users can also provide restrictions for endpoints in the `endpointRestrictions` context entry (see [`@comunica/actor-context-preprocess-endpoint-restrictions`](https://github.com/comunica/comunica/tree/master/packages/actor-context-preprocess-endpoint-restrictions)).
Provided restrictions replace the advertised ones of the same endpoint.
This actor passes the restrictions of an endpoint to its requests, so that [`@comunica/actor-http-limit-restrictions`](https://github.com/comunica/comunica/tree/master/packages/actor-http-limit-restrictions) can respect them.

## Endpoint Server Header Report

The following endpoints have been observed to return the following `Server` headers (at the time of writing):

| Endpoint                                                          | Server Header                                                          |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------- |
| http://lod.sztaki.hu/sparql                                       | `Virtuoso/06.01.3127 (Linux) i686-pc-linux-gnu`                        |
| http://linguistic.linkeddata.es/sparql                            | `Virtuoso/06.01.3127 (Linux) x86_64-pc-linux-gnu`                      |
| http://www.genome.jp/sparql/linkdb                                | `Virtuoso/07.20.3217 (Linux) x86_64-unknown-linux-gnu`                 |
| http://sparql.archives-ouvertes.fr/sparql                         | `Virtuoso/07.20.3229 (Linux) x86_64-pc-linux-gnu`                      |
| http://data.persee.fr/sparql                                      | `Virtuoso/07.20.3230 (Linux) x86_64-generic_glibc25-linux-gnu`         |
| http://linkedgeodata.org/sparql                                   | `Virtuoso/07.20.3233 (Linux) x86_64-pc-linux-gnu`                      |
| http://kaiko.getalp.org/sparql                                    | `Virtuoso/07.20.3240 (Linux) x86_64-pc-linux-gnu`                      |
| http://data.cervantesvirtual.com/openrdf-sesame/repositories/data | `Virtuoso/07.20.3240 (Linux) x86_64-pc-linux-gnu`                      |
| http://sparql.hegroup.org/sparql/                                 | `Virtuoso/07.20.3241 (Linux) x86_64-pc-linux-gnu`                      |
| http://dbpedia.org/sparql                                         | `Virtuoso/08.03.3334 (Linux) x86_64-ubuntu_noble-linux-glibc2.39  VDB` |
| https://lov.linkeddata.es/dataset/lov/sparql                      | `Fuseki (1.1.1)`                                                       |
| http://lov.okfn.org/endpoint/lov                                  | `Fuseki (1.1.1)`                                                       |
