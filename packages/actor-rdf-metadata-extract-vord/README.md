# Comunica VoRD RDF Metadata Extract Actor

[![npm version](https://badge.fury.io/js/%40comunica%2Factor-rdf-metadata-extract-vord.svg)](https://www.npmjs.com/package/@comunica/actor-rdf-metadata-extract-vord)

An [RDF Metadata Extract](https://github.com/comunica/comunica/tree/master/packages/bus-rdf-metadata-extract) actor that
extracts the operational restrictions of an endpoint, such as rate limits and maximum result sizes,
as described in its [SPARQL Service Description](https://www.w3.org/TR/sparql11-service-description/)
using the [VoRD vocabulary](https://w3id.org/vord#).

Restrictions are linked to the `sd:Service` that applies to the requested URL via `vord:hasRestriction`,
or via `sd:feature` if they are typed as `vord:Restriction`.
If no service in the document applies to the requested URL, the restrictions of the only service with restrictions are used.

For endpoints that do not advertise their restrictions, users can provide them in the `endpointRestrictions` context entry, as objects or as a VoRD document that is read in the same way (see [`@comunica/actor-context-preprocess-endpoint-restrictions`](https://github.com/comunica/comunica/tree/master/packages/actor-context-preprocess-endpoint-restrictions)).

This module is part of the [Comunica framework](https://github.com/comunica/comunica),
and should only be used by [developers that want to build their own query engine](https://comunica.dev/docs/modify/).

[Click here if you just want to query with Comunica](https://comunica.dev/docs/query/).

## Install

```bash
$ yarn add @comunica/actor-rdf-metadata-extract-vord
```

## Metadata entries

This actor adds the following entries to the metadata object.

* `restrictions`: A list of `IEndpointRestriction` objects (from `@comunica/types`), one per `vord:Restriction`. Durations (`vord:windowDuration`, `vord:retryAfterHint`, `vord:penaltyDuration`) are converted to milliseconds, and `vord:requestsPerDay` restrictions without a window get a window of one day. Header terms (`vord:httpSignalHeader`, `vord:identificationHeader`) become lowercase header names, taken from the local name of their IRI or from their literal. `vord:IdentificationRestriction`s get the type `identification`, with their `vord:identificationFormat` (`vord:EmailAddress` or `vord:ProductWithContact`); `vord:costUnitsPerWindow` and `vord:concurrentRequests` metrics imply the types `costModel` and `concurrentRequests`. This entry is only set if at least one restriction is found.

## Configure

After installing, this package can be added to your engine's configuration as follows:
```json
{
  "@context": [
    "https://linkedsoftwaredependencies.org/bundles/npm/@comunica/actor-rdf-metadata-extract-vord/^5.0.0/components/context.jsonld"
  ],
  "actors": [
    {
      "@id": "urn:comunica:default:rdf-metadata-extract/actors#vord",
      "@type": "ActorRdfMetadataExtractVord"
    }
  ]
}
```
