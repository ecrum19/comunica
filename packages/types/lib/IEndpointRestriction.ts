/**
 * The kind of an endpoint restriction, corresponding to the restriction classes of the VoRD vocabulary.
 * @see https://w3id.org/vord#
 */
export type EndpointRestrictionType =
  'rate' |
  'quota' |
  'resultSize' |
  'costModel' |
  'serverLoad' |
  'concurrentRequests' |
  'responseTime' |
  'other';

/**
 * The action an endpoint takes when a restriction is reached,
 * corresponding to the enforcement modes of the VoRD vocabulary.
 */
export type EndpointRestrictionEnforcement =
  'reject' |
  'truncate' |
  'queue' |
  'throttle' |
  'degrade' |
  'other';

/**
 * An operational restriction of an endpoint, such as a rate limit or a maximum result size,
 * as advertised in its service description.
 * Durations are expressed in milliseconds.
 */
export interface IEndpointRestriction {
  /**
   * The kind of restriction.
   */
  type: EndpointRestrictionType;
  /**
   * The IRI of the measured metric, e.g. `https://w3id.org/vord#requestsPerWindow`.
   */
  metric?: string;
  /**
   * The primary threshold value.
   */
  maxValue?: number;
  /**
   * The optional minimum threshold value.
   */
  minValue?: number;
  /**
   * The additional threshold for short spikes.
   */
  burstValue?: number;
  /**
   * The IRI of the unit of the threshold values.
   */
  unit?: string;
  /**
   * The duration of the window in which the restriction is evaluated, in milliseconds.
   */
  windowDuration?: number;
  /**
   * The suggested waiting duration before retrying, in milliseconds.
   */
  retryAfterHint?: number;
  /**
   * The HTTP status code that is returned when the restriction is exceeded.
   */
  returnsStatusCode?: number;
  /**
   * The (lowercase) name of the HTTP header that signals the status of the restriction.
   */
  httpSignalHeader?: string;
  /**
   * The IRI of the scope in which the restriction is enforced, e.g. `https://w3id.org/vord#PerClientIP`.
   */
  scope?: string;
  /**
   * The action that is taken when the restriction is reached.
   */
  enforcement?: EndpointRestrictionEnforcement;
  /**
   * If the restriction is strictly enforced (true), or advisory (false).
   */
  hardRestriction?: boolean;
  /**
   * The IRI of the cost model that is used to interpret a cost model restriction.
   */
  costModel?: string;
}

/**
 * An endpoint restriction as given by users in the `endpointRestrictions` context entry.
 * It has the same fields as {@link IEndpointRestriction}, with these differences:
 * - `type` is optional if it follows from the metric (e.g. `vord:requestsPerWindow` gives `rate`),
 *   and may also be a VoRD restriction class, such as `vord:RateRestriction`.
 * - `windowDuration` and `retryAfterHint` are either milliseconds or xsd:duration strings, such as `PT1M`.
 * - `enforcement` may also be a VoRD enforcement mode, such as `vord:RejectRequest`.
 * - IRIs of VoRD terms (`metric`, `unit`, `scope`, `costModel`) may use the `vord:` prefix.
 */
export interface IEndpointRestrictionInput {
  /**
   * The kind of restriction: `rate`, `quota`, `resultSize`, `costModel`, `serverLoad`, `concurrentRequests`,
   * `responseTime` or `other`, or a VoRD restriction class.
   */
  type?: string;
  metric?: string;
  maxValue?: number;
  minValue?: number;
  burstValue?: number;
  unit?: string;
  /**
   * In milliseconds, or as an xsd:duration string.
   */
  windowDuration?: number | string;
  /**
   * In milliseconds, or as an xsd:duration string.
   */
  retryAfterHint?: number | string;
  returnsStatusCode?: number;
  httpSignalHeader?: string;
  scope?: string;
  /**
   * `reject`, `truncate`, `queue`, `throttle`, `degrade` or `other`, or a VoRD enforcement mode.
   */
  enforcement?: string;
  hardRestriction?: boolean;
  costModel?: string;
}

/**
 * Restrictions of endpoints that users provide, keyed by endpoint URL.
 * Each value is either the path or URL of an RDF document that describes the restrictions of the endpoint with VoRD,
 * like a SPARQL service description, or a list of restrictions.
 */
export type EndpointRestrictionsInput = Record<string, string | IEndpointRestrictionInput[]>;

/**
 * How the restrictions that users provide for an endpoint relate to the restrictions that it advertises:
 * - `replace`: the provided restrictions replace the advertised ones.
 *   The service description is fetched as for any endpoint.
 * - `compare`: as `replace`, and the advertised restrictions are compared with the provided ones,
 *   reporting whether they match, partially match, or do not match.
 *   The service description is always fetched, also for a single source of type `sparql`.
 * - `provided-only`: only the provided restrictions are used,
 *   and the service description is not fetched for endpoints with provided restrictions.
 */
export type EndpointRestrictionsMode = 'replace' | 'compare' | 'provided-only';
