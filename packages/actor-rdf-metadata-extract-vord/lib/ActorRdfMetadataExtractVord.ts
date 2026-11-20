import type {
  IActionRdfMetadataExtract,
  IActorRdfMetadataExtractOutput,
  IActorRdfMetadataExtractArgs,
} from '@comunica/bus-rdf-metadata-extract';
import { ActorRdfMetadataExtract } from '@comunica/bus-rdf-metadata-extract';
import type { IActorTest, TestResult } from '@comunica/core';
import { passTestVoid } from '@comunica/core';
import type {
  EndpointIdentificationFormat,
  EndpointRestrictionEnforcement,
  EndpointRestrictionType,
  IEndpointRestriction,
} from '@comunica/types';
import { parseDuration } from '@comunica/utils-expression-evaluator';
import type * as RDF from '@rdfjs/types';

const VORD = 'https://w3id.org/vord#';
const SD = 'http://www.w3.org/ns/sparql-service-description#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/**
 * A comunica RDF Metadata Extract Actor for endpoint restrictions,
 * as described using the VoRD vocabulary (https://w3id.org/vord#) in SPARQL service descriptions.
 */
export class ActorRdfMetadataExtractVord extends ActorRdfMetadataExtract {
  public static readonly RESTRICTION_TYPES: Record<string, EndpointRestrictionType> = {
    [`${VORD}RateRestriction`]: 'rate',
    [`${VORD}QuotaRestriction`]: 'quota',
    [`${VORD}ResultSizeRestriction`]: 'resultSize',
    [`${VORD}CostModelRestriction`]: 'costModel',
    [`${VORD}ServerLoadRestriction`]: 'serverLoad',
    [`${VORD}ConcurrentRequestsRestriction`]: 'concurrentRequests',
    [`${VORD}ResponseTimeRestriction`]: 'responseTime',
    [`${VORD}IdentificationRestriction`]: 'identification',
  };

  public static readonly METRIC_TYPES: Record<string, EndpointRestrictionType> = {
    [`${VORD}requestsPerWindow`]: 'rate',
    [`${VORD}requestsPerDay`]: 'quota',
    [`${VORD}resultBindings`]: 'resultSize',
    [`${VORD}evaluationTime`]: 'responseTime',
    [`${VORD}estimatedCostUnits`]: 'costModel',
    [`${VORD}costUnitsPerWindow`]: 'costModel',
    [`${VORD}concurrentRequests`]: 'concurrentRequests',
  };

  public static readonly ENFORCEMENTS: Record<string, EndpointRestrictionEnforcement> = {
    [`${VORD}RejectRequest`]: 'reject',
    [`${VORD}TruncateResult`]: 'truncate',
    [`${VORD}QueueRequest`]: 'queue',
    [`${VORD}ThrottleResponse`]: 'throttle',
    [`${VORD}DegradeQuality`]: 'degrade',
  };

  public static readonly IDENTIFICATION_FORMATS: Record<string, EndpointIdentificationFormat> = {
    [`${VORD}EmailAddress`]: 'email',
    [`${VORD}ProductWithContact`]: 'productWithContact',
  };

  public static readonly DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;

  public constructor(args: IActorRdfMetadataExtractArgs) {
    super(args);
  }

  public async test(_action: IActionRdfMetadataExtract): Promise<TestResult<IActorTest>> {
    return passTestVoid();
  }

  public async run(action: IActionRdfMetadataExtract): Promise<IActorRdfMetadataExtractOutput> {
    const quadsBySubject = await ActorRdfMetadataExtractVord.indexQuadsBySubject(action.metadata);
    const restrictions: IEndpointRestriction[] = [];
    for (const restrictionId of ActorRdfMetadataExtractVord.getRestrictionIds(quadsBySubject, action.url)) {
      const restrictionQuads = quadsBySubject.get(restrictionId);
      if (restrictionQuads) {
        restrictions.push(ActorRdfMetadataExtractVord.parseRestriction(restrictionQuads));
      }
    }
    return { metadata: restrictions.length > 0 ? { restrictions } : {}};
  }

  /**
   * Consume the given metadata stream, and group its quads by subject value.
   * @param metadata A metadata quad stream.
   */
  public static indexQuadsBySubject(metadata: RDF.Stream): Promise<Map<string, RDF.Quad[]>> {
    return new Promise((resolve, reject) => {
      const quadsBySubject = new Map<string, RDF.Quad[]>();
      metadata.on('error', reject);
      metadata.on('data', (quad: RDF.Quad) => {
        let quads = quadsBySubject.get(quad.subject.value);
        if (!quads) {
          quads = [];
          quadsBySubject.set(quad.subject.value, quads);
        }
        quads.push(quad);
      });
      metadata.on('end', () => resolve(quadsBySubject));
    });
  }

  /**
   * Determine the restrictions of the service that applies to the given URL.
   * A service applies if it is identified by the URL, or if its sd:endpoint is the URL.
   * If no service applies in that way, the restrictions of the only service with restrictions are used.
   * Restrictions are linked to services via vord:hasRestriction, or via sd:feature if they are typed as restrictions.
   * @param quadsBySubject The quads of the metadata, grouped by subject value.
   * @param url The URL from which the metadata was obtained.
   */
  public static getRestrictionIds(quadsBySubject: Map<string, RDF.Quad[]>, url: string): Set<string> {
    const restrictionIdsMatching = new Set<string>();
    const restrictionIdsByService = new Map<string, Set<string>>();
    for (const [ subject, quads ] of quadsBySubject) {
      const restrictionIds = new Set<string>();
      let matchesUrl = subject === url;
      for (const quad of quads) {
        if (quad.predicate.value === `${VORD}hasRestriction` ||
          (quad.predicate.value === `${SD}feature` &&
            ActorRdfMetadataExtractVord.isRestriction(quadsBySubject.get(quad.object.value)))) {
          restrictionIds.add(quad.object.value);
        } else if (quad.predicate.value === `${SD}endpoint` && quad.object.value === url) {
          matchesUrl = true;
        }
      }
      if (restrictionIds.size > 0) {
        restrictionIdsByService.set(subject, restrictionIds);
        if (matchesUrl) {
          for (const restrictionId of restrictionIds) {
            restrictionIdsMatching.add(restrictionId);
          }
        }
      }
    }
    if (restrictionIdsMatching.size === 0 && restrictionIdsByService.size === 1) {
      return [ ...restrictionIdsByService.values() ][0];
    }
    return restrictionIdsMatching;
  }

  /**
   * Check if the given quads describe a VoRD restriction.
   * @param quads The quads of a single subject.
   */
  public static isRestriction(quads: RDF.Quad[] | undefined): boolean {
    return Boolean(quads?.some(quad => quad.predicate.value === RDF_TYPE &&
      (quad.object.value === `${VORD}Restriction` || quad.object.value in ActorRdfMetadataExtractVord.RESTRICTION_TYPES)));
  }

  /**
   * Convert the quads describing a single restriction into a restriction object.
   * @param quads The quads of a single restriction subject.
   */
  public static parseRestriction(quads: RDF.Quad[]): IEndpointRestriction {
    let type: EndpointRestrictionType | undefined;
    const restriction: Omit<IEndpointRestriction, 'type'> = {};
    for (const quad of quads) {
      const value = quad.object.value;
      switch (quad.predicate.value) {
        case RDF_TYPE:
          type = ActorRdfMetadataExtractVord.RESTRICTION_TYPES[value] ?? type;
          break;
        case `${VORD}metric`:
          restriction.metric = value;
          break;
        case `${VORD}maxValue`:
          restriction.maxValue = ActorRdfMetadataExtractVord.parseInteger(value);
          break;
        case `${VORD}minValue`:
          restriction.minValue = ActorRdfMetadataExtractVord.parseInteger(value);
          break;
        case `${VORD}burstValue`:
          restriction.burstValue = ActorRdfMetadataExtractVord.parseInteger(value);
          break;
        case `${VORD}returnsStatusCode`:
          restriction.returnsStatusCode = ActorRdfMetadataExtractVord.parseInteger(value);
          break;
        case `${VORD}windowDuration`:
          restriction.windowDuration = ActorRdfMetadataExtractVord.parseDurationMilliseconds(value);
          break;
        case `${VORD}retryAfterHint`:
          restriction.retryAfterHint = ActorRdfMetadataExtractVord.parseDurationMilliseconds(value);
          break;
        case `${VORD}unit`:
          restriction.unit = value;
          break;
        case `${VORD}hasScope`:
          restriction.scope = value;
          break;
        case `${VORD}enforcement`:
          restriction.enforcement = ActorRdfMetadataExtractVord.ENFORCEMENTS[value] ?? 'other';
          break;
        case `${VORD}hardRestriction`:
          restriction.hardRestriction = value === 'true' || value === '1';
          break;
        case `${VORD}httpSignalHeader`:
          restriction.httpSignalHeader = ActorRdfMetadataExtractVord.parseHeaderName(quad.object);
          break;
        case `${VORD}costModel`:
          restriction.costModel = value;
          break;
        case `${VORD}penaltyThreshold`:
          restriction.penaltyThreshold = ActorRdfMetadataExtractVord.parseInteger(value);
          break;
        case `${VORD}penaltyDuration`:
          restriction.penaltyDuration = ActorRdfMetadataExtractVord.parseDurationMilliseconds(value);
          break;
        case `${VORD}identificationHeader`:
          restriction.identificationHeader = ActorRdfMetadataExtractVord.parseHeaderName(quad.object);
          break;
        case `${VORD}identificationFormat`:
          restriction.identificationFormat = ActorRdfMetadataExtractVord.IDENTIFICATION_FORMATS[value] ?? 'other';
          break;
      }
    }

    // Fall back to the metric for determining the type, e.g. for restrictions only typed as vord:Restriction.
    type ??= (restriction.metric ? ActorRdfMetadataExtractVord.METRIC_TYPES[restriction.metric] : undefined) ??
      'other';

    // Daily request counts imply a window of one day.
    if (restriction.metric === `${VORD}requestsPerDay` && restriction.windowDuration === undefined) {
      restriction.windowDuration = ActorRdfMetadataExtractVord.DAY_MILLISECONDS;
    }

    return { type, ...restriction };
  }

  /**
   * Parse an integer value.
   * @param value A string value.
   * @return The integer, or undefined if the value is not a valid integer.
   */
  public static parseInteger(value: string): number | undefined {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  }

  /**
   * Parse an xsd:duration value into milliseconds.
   * Years and months are approximated as 365 and 30 days respectively.
   * @param value An xsd:duration value, such as "PT1M".
   * @return The number of milliseconds, or undefined if the value is not a valid positive duration.
   */
  public static parseDurationMilliseconds(value: string): number | undefined {
    let duration: ReturnType<typeof parseDuration>;
    try {
      duration = parseDuration(value);
    } catch {
      return undefined;
    }
    const days = ((duration.year ?? 0) * 365) + ((duration.month ?? 0) * 30) + (duration.day ?? 0);
    const seconds = (((((days * 24) + (duration.hours ?? 0)) * 60) + (duration.minutes ?? 0)) * 60) +
      (duration.seconds ?? 0);
    return seconds > 0 ? seconds * 1_000 : undefined;
  }

  /**
   * Determine the lowercase HTTP header name from a header term,
   * which is either a literal, or an IRI such as http://www.w3.org/2011/http-headers#retry-after.
   * @param term A header term.
   */
  public static parseHeaderName(term: RDF.Term): string {
    const value = term.termType === 'Literal' ?
      term.value :
      term.value.slice(Math.max(term.value.lastIndexOf('#'), term.value.lastIndexOf('/')) + 1);
    return value.toLowerCase();
  }
}
