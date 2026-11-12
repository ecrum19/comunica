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
