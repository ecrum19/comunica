# Comunica SPARQL

[![npm version](https://badge.fury.io/js/%40comunica%2Fquery-sparql.svg)](https://www.npmjs.com/package/@comunica/query-sparql)
[![Docker Pulls](https://img.shields.io/docker/pulls/comunica/query-sparql.svg)](https://hub.docker.com/r/comunica/query-sparql/)

Comunica SPARQL is a SPARQL query engine for JavaScript for querying over decentralized RDF knowledge graphs on the Web.

It's main distinguishing features are the following:

* Execute [SPARQL 1.1](https://www.w3.org/TR/sparql11-query/) or [GraphQL-LD](https://github.com/rubensworks/graphql-ld.js) queries.
* Federated querying over [heterogeneous interfaces](https://comunica.dev/docs/query/advanced/source_types/), such as RDF files, SPARQL endpoints, [Triple Pattern Fragments](https://linkeddatafragments.org/), or [Solid data pods](https://inrupt.com/solid).
* High modularity enabling [easy extensions and customization](https://comunica.dev/docs/modify/).
* Runs in JavaScript using [Node.JS](http://nodejs.org/), in the browser, and via the command-line.
* Update sources using [SPARQL 1.1 Update queries](https://www.w3.org/TR/sparql11-update/).

**[Learn more about Comunica on our website](https://comunica.dev/).**

**This actor can not query over local files for security reasons, but [Comunica SPARQL file](https://github.com/comunica/comunica/tree/master/engines/query-sparql-file#readme) can.**

_Internally, this is a [Comunica module](https://comunica.dev/) that is configured with modules to execute SPARQL queries._

## Supported by

Comunica is a community-driven project, sustained by the [Comunica Association](https://comunica.dev/association/).
If you are using Comunica, [becoming a sponsor or member](https://opencollective.com/comunica-association) is a way to make Comunica sustainable in the long-term.

Our top sponsors are shown below!

<a href="https://opencollective.com/comunica-association/sponsor/0/website" target="_blank"><img src="https://opencollective.com/comunica-association/sponsor/0/avatar.svg"></a>
<a href="https://opencollective.com/comunica-association/sponsor/1/website" target="_blank"><img src="https://opencollective.com/comunica-association/sponsor/1/avatar.svg"></a>
<a href="https://opencollective.com/comunica-association/sponsor/2/website" target="_blank"><img src="https://opencollective.com/comunica-association/sponsor/2/avatar.svg"></a>
<a href="https://opencollective.com/comunica-association/sponsor/3/website" target="_blank"><img src="https://opencollective.com/comunica-association/sponsor/3/avatar.svg"></a>

## Motivation

This Comunica actor was created for the TRIPLE Project and designed to enhance the reproducability of SPARQL query execution over federated SPARQL endpoints.

## Installation

To install the remote-cache version of Comunica, first clone the glithub repo and intall dependencies using yarn.

```bash
$ git clone https://github.com/ecrum19/comunica/tree/feature/remote-cache
$ cd comunica
$ yarn intsall
```

## Execute + save SPARQL queries & results to a solid-pod hosted query cache

This actor can be used to execute SPARQL queries from
the command line or within a Node.JS application. 
The queries and results can be saved specified query cache 
and that cache can be used to improve the performance of some queries.

### Initialzing a query cache in a Solid Pod

To use the query cache functionality provided by this actor, a pre-existing query cache must be present in your Solid pod
AND the cache must allow for PUBLIC read + write access.
For a guide about how to set-up a Solid Pod, initialize a query cache in that pod, and alter the permissions of that query cache see
_[**TRIPLE Start Guide**](https://knowledgeonwebscale.github.io/solid-cockpit/)._

### Usage from the command line

General CLI command help:

```bash
$ node engines/query-sparql-remote-cache/bin/query.js -h
```

Archytipical remote-cache CLI command:

```bash
$ node engines/query-sparql-remote-cache/bin/query.js sourece1-url source2-url -q "SPARQL query text" -t 'application/sparql-results+json' --location cache-queries.ttl-url --failOnCacheMiss boolean --saveToCache boolean
```

Simple demonstrator query:

```bash
$ node engines/query-sparql-remote-cache/bin/query.js https://sparql.rhea-db.org/sparql/ -q "SELECT DISTINCT ?s WHERE {?s ?t ?o .} LIMIT 10" -t 'application/json' --location "https://triple.ilabt.imec.be/test/querycache/queries.ttl" --failOnCacheMiss false --saveToCache true
```

Demonstrator query #4 (Rhea):
(Note: all TRIPLE Project demonstrator queries can be found in this root of this repo at `~/comunica/cache/demonstrator-queries/`)

```bash
$ node engines/query-sparql-remote-cache/bin/query.js https://sparql.rhea-db.org/sparql/ -f cache/demonstrator-queries/triple-rhea-4.rq -t 'application/json' --location "https://triple.ilabt.imec.be/test/querycache/queries.ttl" --failOnCacheMiss false --saveToCache true
```


## Learn more

This README just shows the tip of the iceberg!
Learn more about Comunica's functionalities in the following guides:

* _[Updating from the command line](https://comunica.dev/docs/query/getting_started/update_cli/)_
* _[Updating in a JavaScript app](https://comunica.dev/docs/query/getting_started/update_app/)_
* _[Querying in a JavaScript browser app](https://comunica.dev/docs/query/getting_started/query_browser_app/)_
* _[Passing query options](https://comunica.dev/docs/query/advanced/context/)_
* _[Supported source types](https://comunica.dev/docs/query/advanced/source_types/)_
* _[Supported destination types](https://comunica.dev/docs/query/advanced/destination_types/)_
* _[Formatting results](https://comunica.dev/docs/query/advanced/result_formats/)_
* _[Supported specifications](https://comunica.dev/docs/query/advanced/specifications/)_
* _[Logging and debugging](https://comunica.dev/docs/query/advanced/logging/)_
* _[Caching](https://comunica.dev/docs/query/advanced/caching/)_
* _[Using a proxy](https://comunica.dev/docs/query/advanced/proxying/)_
* _[HTTP basic authentication](https://comunica.dev/docs/query/advanced/basic_auth/)_
* _[GraphQL-LD](https://comunica.dev/docs/query/advanced/graphql_ld/)_
* _[Docker](https://comunica.dev/docs/query/getting_started/query_docker/)_
* _[*Full documentation*](https://comunica.dev/docs/)_
