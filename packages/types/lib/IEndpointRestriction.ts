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
  'identification' |
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
 * The format in which a client must identify itself,
 * corresponding to the identification formats of the VoRD vocabulary:
 * - `email`: an email address of the client's operator, as in the HTTP From header (vord:EmailAddress);
 * - `productWithContact`: a product identifier with contact information in a comment,
 *   as in the User-Agent value 'ExampleBot/1.0 (https://example.org; bot@example.org)' (vord:ProductWithContact).
 */
export type EndpointIdentificationFormat = 'email' | 'productWithContact' | 'other';

/**
 * Contact information with which the engine identifies itself to endpoints that require identification
 * (VoRD identification restrictions). It is only sent to endpoints whose restrictions require it.
 */
export interface IClientContact {
  /**
   * An email address at which the operator of the engine can be reached.
   */
  email?: string;
  /**
   * A URL with information about the engine or its operator.
   */
  url?: string;
}

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
  /**
   * The number of violations within the penalty duration after which the endpoint blocks the client.
   * A value of 1 means that the first violation is penalized.
   */
  penaltyThreshold?: number;
  /**
   * The duration for which the endpoint blocks a client that reached the penalty threshold, in milliseconds.
   */
  penaltyDuration?: number;
  /**
   * For identification restrictions, the (lowercase) name of the HTTP request header in which clients must identify.
   */
  identificationHeader?: string;
  /**
   * For identification restrictions, the format of the identification.
   */
  identificationFormat?: EndpointIdentificationFormat;
}

/**
 * An endpoint restriction as given by users in the `endpointRestrictions` context entry.
 * It has the same fields as {@link IEndpointRestriction}, with these differences:
 * - `type` is optional if it follows from the metric (e.g. `vord:requestsPerWindow` gives `rate`),
 *   and may also be a VoRD restriction class, such as `vord:RateRestriction`.
 * - `windowDuration`, `retryAfterHint` and `penaltyDuration` are either milliseconds or xsd:duration strings,
 *   such as `PT1M`.
 * - `enforcement` may also be a VoRD enforcement mode, such as `vord:RejectRequest`.
 * - `identificationFormat` may also be a VoRD identification format, such as `vord:EmailAddress`.
 * - IRIs of VoRD terms (`metric`, `unit`, `scope`, `costModel`) may use the `vord:` prefix.
 */
export interface IEndpointRestrictionInput {
  /**
   * The kind of restriction: `rate`, `quota`, `resultSize`, `costModel`, `serverLoad`, `concurrentRequests`,
   * `responseTime`, `identification` or `other`, or a VoRD restriction class.
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
  penaltyThreshold?: number;
  /**
   * In milliseconds, or as an xsd:duration string.
   */
  penaltyDuration?: number | string;
  identificationHeader?: string;
  /**
   * `email`, `productWithContact` or `other`, or a VoRD identification format.
   */
  identificationFormat?: string;
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
