import type { IEndpointRestriction } from '@comunica/types';

/**
 * The fields that are compared between two restrictions of the same type.
 */
const COMPARED_FIELDS: (keyof IEndpointRestriction)[] = [
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
 * How the restrictions that users provide for an endpoint compare to the ones it advertises.
 */
export interface IEndpointRestrictionComparison {
  /**
   * `match` if every provided restriction agrees with an advertised one and vice versa,
   * `partial` if some do, `mismatch` if none do.
   */
  result: 'match' | 'partial' | 'mismatch';
  /**
   * Pairs of a provided and an advertised restriction that agree.
   */
  matching: { provided: IEndpointRestriction; advertised: IEndpointRestriction }[];
  /**
   * Pairs of a provided and an advertised restriction of the same type that disagree, with the fields that differ.
   */
  conflicting: {
    provided: IEndpointRestriction;
    advertised: IEndpointRestriction;
    differences: IEndpointRestrictionDifference[];
  }[];
  /**
   * Provided restrictions without an advertised restriction of the same type.
   */
  onlyProvided: IEndpointRestriction[];
  /**
   * Advertised restrictions without a provided restriction of the same type.
   */
  onlyAdvertised: IEndpointRestriction[];
}

/**
 * A field whose value differs between a provided and an advertised restriction.
 */
export interface IEndpointRestrictionDifference {
  field: keyof IEndpointRestriction;
  provided: unknown;
  advertised: unknown;
}

/**
 * Determine the fields in which two restrictions of the same type differ.
 * Fields that only one of them specifies are not compared, as an unspecified value does not contradict a specified one.
 * Restrictions are strictly enforced unless hardRestriction is false.
 * @param provided A provided restriction.
 * @param advertised An advertised restriction.
 */
export function getEndpointRestrictionDifferences(
  provided: IEndpointRestriction,
  advertised: IEndpointRestriction,
): IEndpointRestrictionDifference[] {
  const differences: IEndpointRestrictionDifference[] = [];
  for (const field of COMPARED_FIELDS) {
    const providedValue = field === 'hardRestriction' ? provided.hardRestriction ?? true : provided[field];
    const advertisedValue = field === 'hardRestriction' ? advertised.hardRestriction ?? true : advertised[field];
    if (providedValue !== undefined && advertisedValue !== undefined && providedValue !== advertisedValue) {
      differences.push({ field, provided: providedValue, advertised: advertisedValue });
    }
  }
  return differences;
}

/**
 * Compare the restrictions that users provide for an endpoint to the ones that it advertises.
 * Every restriction is paired with at most one restriction of the same type:
 * first with one that it agrees with, otherwise with one that it differs from.
 * @param provided The provided restrictions.
 * @param advertised The advertised restrictions.
 */
export function compareEndpointRestrictions(
  provided: IEndpointRestriction[],
  advertised: IEndpointRestriction[],
): IEndpointRestrictionComparison {
  const remaining = [ ...advertised ];
  const take = (predicate: (restriction: IEndpointRestriction) => boolean): IEndpointRestriction | undefined => {
    const index = remaining.findIndex(predicate);
    return index < 0 ? undefined : remaining.splice(index, 1)[0];
  };

  // Agreeing pairs come first, so that a disagreeing restriction of the same type does not hide an agreeing one.
  const matching: IEndpointRestrictionComparison['matching'] = [];
  const unmatched: IEndpointRestriction[] = [];
  for (const restriction of provided) {
    const agreeing = take(candidate => candidate.type === restriction.type &&
      getEndpointRestrictionDifferences(restriction, candidate).length === 0);
    if (agreeing) {
      matching.push({ provided: restriction, advertised: agreeing });
    } else {
      unmatched.push(restriction);
    }
  }

  const conflicting: IEndpointRestrictionComparison['conflicting'] = [];
  const onlyProvided: IEndpointRestriction[] = [];
  for (const restriction of unmatched) {
    const sameType = take(candidate => candidate.type === restriction.type);
    if (sameType) {
      conflicting.push({
        provided: restriction,
        advertised: sameType,
        differences: getEndpointRestrictionDifferences(restriction, sameType),
      });
    } else {
      onlyProvided.push(restriction);
    }
  }

  let result: IEndpointRestrictionComparison['result'] = 'mismatch';
  if (conflicting.length === 0 && onlyProvided.length === 0 && remaining.length === 0) {
    result = 'match';
  } else if (matching.length > 0) {
    result = 'partial';
  }
  return { result, matching, conflicting, onlyProvided, onlyAdvertised: remaining };
}

/**
 * Describe the comparison of the restrictions of an endpoint in a sentence for users.
 * @param url The URL of the endpoint.
 * @param comparison The comparison.
 */
export function describeEndpointRestrictionComparison(url: string, comparison: IEndpointRestrictionComparison): string {
  const subject = `The restrictions provided for ${url}`;
  const providedCount = comparison.matching.length + comparison.conflicting.length + comparison.onlyProvided.length;
  if (comparison.result === 'match') {
    return `${subject} match the ones it advertises (${providedCount} restriction${providedCount === 1 ? '' : 's'})`;
  }
  const details: string[] = [];
  for (const { provided, differences } of comparison.conflicting) {
    details.push(`${provided.type} differs in ${differences
      .map(({ field, provided: providedValue, advertised }) =>
        `${field} (provided ${String(providedValue)}, advertised ${String(advertised)})`)
      .join(', ')}`);
  }
  if (comparison.onlyProvided.length > 0) {
    details.push(`not advertised: ${comparison.onlyProvided.map(restriction => restriction.type).join(', ')}`);
  }
  if (comparison.onlyAdvertised.length > 0) {
    details.push(`not provided: ${comparison.onlyAdvertised.map(restriction => restriction.type).join(', ')}`);
  }
  if (comparison.result === 'partial') {
    return `${subject} partially match the ones it advertises: ${comparison.matching.length} of ${providedCount} match; ${details.join('; ')}`;
  }
  const advertisedCount = comparison.conflicting.length + comparison.onlyAdvertised.length;
  if (advertisedCount === 0) {
    return `${subject} do not match the ones it advertises: it advertises no restrictions`;
  }
  return `${subject} do not match the ones it advertises: ${details.join('; ')}`;
}
