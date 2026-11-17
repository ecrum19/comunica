import { ActorRdfMetadataExtractVord } from '@comunica/actor-rdf-metadata-extract-vord';
import type {
  IActionContextPreprocess,
  IActorContextPreprocessArgs,
  IActorContextPreprocessOutput,
} from '@comunica/bus-context-preprocess';
import { ActorContextPreprocess } from '@comunica/bus-context-preprocess';
import type { MediatorDereferenceRdf } from '@comunica/bus-dereference-rdf';
import { KeysInitQuery, KeysQuerySourceIdentify } from '@comunica/context-entries';
import type { IActorTest, TestResult } from '@comunica/core';
import { passTestVoid } from '@comunica/core';
import type {
  EndpointRestrictionEnforcement,
  EndpointRestrictionType,
  IActionContext,
  IEndpointRestriction,
  IEndpointRestrictionInput,
} from '@comunica/types';

const VORD = 'https://w3id.org/vord#';

// The names of restriction types and enforcement modes, as used in IEndpointRestriction.
const TYPES = new Set<string>([ ...Object.values(ActorRdfMetadataExtractVord.RESTRICTION_TYPES), 'other' ]);
const ENFORCEMENTS = new Set<string>([ ...Object.values(ActorRdfMetadataExtractVord.ENFORCEMENTS), 'other' ]);

// The fields of restriction objects.
const FIELDS = [
  'type',
  'metric',
  'maxValue',
  'minValue',
  'burstValue',
  'unit',
  'windowDuration',
  'retryAfterHint',
  'returnsStatusCode',
  'httpSignalHeader',
  'scope',
  'enforcement',
  'hardRestriction',
  'costModel',
];

/**
 * A comunica Endpoint Restrictions Context Preprocess Actor.
 *
 * It reads the restrictions that users provide for endpoints in the endpointRestrictions context entry,
 * either from RDF documents that describe them with VoRD, or from restriction objects,
 * and stores them in KeysQuerySourceIdentify.endpointRestrictionsResolved for SPARQL sources to use.
 */
export class ActorContextPreprocessEndpointRestrictions extends ActorContextPreprocess {
  public readonly mediatorDereferenceRdf: MediatorDereferenceRdf;

  public constructor(args: IActorContextPreprocessEndpointRestrictionsArgs) {
    super(args);
    this.mediatorDereferenceRdf = args.mediatorDereferenceRdf;
  }

  public async test(_action: IActionContextPreprocess): Promise<TestResult<IActorTest>> {
    return passTestVoid();
  }

  public async run(action: IActionContextPreprocess): Promise<IActorContextPreprocessOutput> {
    let context = action.context;
    const input: unknown = context.get(KeysQuerySourceIdentify.endpointRestrictions);
    if (!action.initialize || input === undefined) {
      return { context };
    }
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new Error(`The endpointRestrictions context entry must be an object with endpoint URLs as keys`);
    }

    const resolved: Record<string, IEndpointRestriction[]> = {
      ...context.get(KeysQuerySourceIdentify.endpointRestrictionsResolved),
    };
    await Promise.all(Object.entries(input).map(async([ endpoint, value ]) => {
      let restrictions: IEndpointRestriction[];
      if (typeof value === 'string') {
        restrictions = await this.readRestrictions(endpoint, value, context);
      } else if (Array.isArray(value)) {
        restrictions = value.map((restriction: unknown, i) => ActorContextPreprocessEndpointRestrictions
          .parseRestriction(restriction, `Restriction ${i} of ${endpoint}`));
      } else {
        throw new TypeError(`The endpoint restrictions of ${endpoint} must be the path or URL of a VoRD description, or a list of restrictions`);
      }
      resolved[ActorContextPreprocessEndpointRestrictions.normalizeUrl(endpoint)] = restrictions;
    }));

    // The original entry is removed, so that documents are not read again if the context is preprocessed again.
    context = context
      .delete(KeysQuerySourceIdentify.endpointRestrictions)
      .set(KeysQuerySourceIdentify.endpointRestrictionsResolved, resolved);
    return { context };
  }

  /**
   * Read the restrictions of an endpoint from an RDF document that describes them with VoRD.
   * @param endpoint The URL of the endpoint.
   * @param location The path or URL of the document.
   * @param context The context.
   */
  public async readRestrictions(
    endpoint: string,
    location: string,
    context: IActionContext,
  ): Promise<IEndpointRestriction[]> {
    let quadsBySubject: Awaited<ReturnType<typeof ActorRdfMetadataExtractVord.indexQuadsBySubject>>;
    try {
      // Errors are not ignored in lenient mode, as they would silently drop the restrictions.
      const { data } = await this.mediatorDereferenceRdf
        .mediate({ url: location, context: context.delete(KeysInitQuery.lenient) });
      quadsBySubject = await ActorRdfMetadataExtractVord.indexQuadsBySubject(data);
    } catch (error: unknown) {
      const hint = /^https?:\/\//u.test(location) ?
        '' :
        ' Local files can only be read by engines that can query local files, such as @comunica/query-sparql-file.';
      throw new Error(`Could not read the restrictions of ${endpoint} from ${location}: ${(<Error> error).message}${hint}`);
    }

    const restrictions: IEndpointRestriction[] = [];
    for (const restrictionId of ActorRdfMetadataExtractVord.getRestrictionIds(quadsBySubject, endpoint)) {
      const restrictionQuads = quadsBySubject.get(restrictionId);
      if (restrictionQuads) {
        restrictions.push(ActorRdfMetadataExtractVord.parseRestriction(restrictionQuads));
      }
    }
    if (restrictions.length === 0) {
      throw new Error(`${location} describes no VoRD restrictions for ${endpoint}. It must describe a service with sd:endpoint <${endpoint}>, or a single service, that links to its restrictions with vord:hasRestriction.`);
    }
    return restrictions;
  }

  /**
   * Validate a restriction that a user provided as an object, and convert it into an endpoint restriction.
   * @param input A restriction object.
   * @param name A name for the restriction in error messages.
   */
  public static parseRestriction(input: unknown, name: string): IEndpointRestriction {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new Error(`${name} must be an object`);
    }

    let type: EndpointRestrictionType | undefined;
    const restriction: Omit<IEndpointRestriction, 'type'> = {};
    for (const [ field, value ] of Object.entries(<IEndpointRestrictionInput> input)) {
      if (value === undefined) {
        continue;
      }
      const fieldName = `The ${field} of ${name.charAt(0).toLowerCase()}${name.slice(1)}`;
      switch (field) {
        case 'type':
          type = ActorContextPreprocessEndpointRestrictions.parseType(value, fieldName);
          break;
        case 'metric':
        case 'unit':
        case 'scope':
        case 'costModel':
          restriction[field] = ActorContextPreprocessEndpointRestrictions.parseIri(value, fieldName);
          break;
        case 'maxValue':
        case 'minValue':
        case 'burstValue':
          restriction[field] = ActorContextPreprocessEndpointRestrictions.parseNumber(value, fieldName);
          break;
        case 'returnsStatusCode':
          restriction[field] = ActorContextPreprocessEndpointRestrictions.parseStatusCode(value, fieldName);
          break;
        case 'windowDuration':
        case 'retryAfterHint':
          restriction[field] = ActorContextPreprocessEndpointRestrictions.parseDuration(value, fieldName);
          break;
        case 'httpSignalHeader':
          restriction[field] = ActorContextPreprocessEndpointRestrictions.parseString(value, fieldName).toLowerCase();
          break;
        case 'enforcement':
          restriction[field] = ActorContextPreprocessEndpointRestrictions.parseEnforcement(value, fieldName);
          break;
        case 'hardRestriction':
          if (typeof value !== 'boolean') {
            throw new TypeError(`${fieldName} must be true or false`);
          }
          restriction[field] = value;
          break;
        default:
          throw new Error(`${name} has an unknown field '${field}'. Known fields are: ${FIELDS.join(', ')}`);
      }
    }

    // The type can be derived from the metric, in the same way as for restrictions described with VoRD.
    type ??= restriction.metric ? ActorRdfMetadataExtractVord.METRIC_TYPES[restriction.metric] : undefined;
    if (!type) {
      throw new Error(`${name} needs a type, such as 'rate', or a metric from which it follows, such as 'vord:requestsPerWindow'`);
    }

    // Daily request counts imply a window of one day.
    if (restriction.metric === `${VORD}requestsPerDay` && restriction.windowDuration === undefined) {
      restriction.windowDuration = ActorRdfMetadataExtractVord.DAY_MILLISECONDS;
    }

    // Restrictions that Comunica acts on need their limit, so that mistakes are not silently ignored.
    if ([ 'rate', 'quota', 'resultSize', 'concurrentRequests', 'responseTime' ].includes(type) &&
      !restriction.maxValue) {
      throw new Error(`${name} needs a maxValue above 0`);
    }
    if ((type === 'rate' || type === 'quota') && restriction.windowDuration === undefined) {
      throw new Error(`${name} needs a windowDuration, such as 'PT1M'`);
    }

    return { type, ...restriction };
  }

  /**
   * Parse a restriction type, given as a type name or as a VoRD restriction class.
   * @param value A value.
   * @param name A name for the value in error messages.
   */
  public static parseType(value: unknown, name: string): EndpointRestrictionType {
    const string = ActorContextPreprocessEndpointRestrictions.parseString(value, name);
    if (TYPES.has(string)) {
      return <EndpointRestrictionType> string;
    }
    const iri = ActorContextPreprocessEndpointRestrictions.expandIri(string);
    const type = ActorRdfMetadataExtractVord.RESTRICTION_TYPES[iri];
    if (!type) {
      throw new Error(`${name} must be one of ${[ ...TYPES ].join(', ')}, or a VoRD restriction class such as 'vord:RateRestriction'`);
    }
    return type;
  }

  /**
   * Parse an enforcement mode, given as a name or as a VoRD enforcement mode.
   * @param value A value.
   * @param name A name for the value in error messages.
   */
  public static parseEnforcement(value: unknown, name: string): EndpointRestrictionEnforcement {
    const string = ActorContextPreprocessEndpointRestrictions.parseString(value, name);
    if (ENFORCEMENTS.has(string)) {
      return <EndpointRestrictionEnforcement> string;
    }
    const iri = ActorContextPreprocessEndpointRestrictions.expandIri(string);
    const enforcement = ActorRdfMetadataExtractVord.ENFORCEMENTS[iri];
    if (!enforcement) {
      throw new Error(`${name} must be one of ${[ ...ENFORCEMENTS ].join(', ')}, or a VoRD enforcement mode such as 'vord:RejectRequest'`);
    }
    return enforcement;
  }

  /**
   * Parse an IRI, which may use the vord: prefix.
   * @param value A value.
   * @param name A name for the value in error messages.
   */
  public static parseIri(value: unknown, name: string): string {
    return ActorContextPreprocessEndpointRestrictions.expandIri(
      ActorContextPreprocessEndpointRestrictions.parseString(value, name),
    );
  }

  /**
   * Parse a number that is not negative.
   * @param value A value.
   * @param name A name for the value in error messages.
   */
  public static parseNumber(value: unknown, name: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new TypeError(`${name} must be a number of at least 0`);
    }
    return value;
  }

  /**
   * Parse an HTTP status code.
   * @param value A value.
   * @param name A name for the value in error messages.
   */
  public static parseStatusCode(value: unknown, name: string): number {
    const code = <number> value;
    if (!Number.isInteger(code) || code < 100 || code > 599) {
      throw new TypeError(`${name} must be an HTTP status code, such as 429`);
    }
    return code;
  }

  /**
   * Parse a duration, given in milliseconds or as an xsd:duration string, into milliseconds.
   * @param value A value.
   * @param name A name for the value in error messages.
   */
  public static parseDuration(value: unknown, name: string): number {
    const milliseconds = typeof value === 'string' ?
      ActorRdfMetadataExtractVord.parseDurationMilliseconds(value) :
      value;
    if (typeof milliseconds !== 'number' || !Number.isFinite(milliseconds) || milliseconds <= 0) {
      throw new TypeError(`${name} must be a number of milliseconds above 0, or an xsd:duration such as 'PT1M'`);
    }
    return milliseconds;
  }

  /**
   * Check that a value is a string.
   * @param value A value.
   * @param name A name for the value in error messages.
   */
  public static parseString(value: unknown, name: string): string {
    if (typeof value !== 'string') {
      throw new TypeError(`${name} must be a string`);
    }
    return value;
  }

  /**
   * Expand an IRI with the vord: prefix.
   * @param value An IRI, or a prefixed name with the vord: prefix.
   */
  public static expandIri(value: string): string {
    return value.startsWith('vord:') ? `${VORD}${value.slice(5)}` : value;
  }

  /**
   * Normalize a URL, so that equivalent URLs of the same endpoint match.
   * @param url A URL.
   */
  public static normalizeUrl(url: string): string {
    try {
      return new URL(url).href;
    } catch {
      return url;
    }
  }
}

export interface IActorContextPreprocessEndpointRestrictionsArgs extends IActorContextPreprocessArgs {
  /**
   * The mediator for reading RDF documents that describe endpoint restrictions.
   */
  mediatorDereferenceRdf: MediatorDereferenceRdf;
}
