import type { IEndpointRestriction } from '@comunica/types';
import {
  compareEndpointRestrictions,
  describeEndpointRestrictionComparison,
  getEndpointRestrictionDifferences,
} from '../lib/EndpointRestrictionComparison';

const VORD = 'https://w3id.org/vord#';
const ENDPOINT = 'http://example.org/sparql';

const rate: IEndpointRestriction = {
  type: 'rate',
  metric: `${VORD}requestsPerWindow`,
  maxValue: 60,
  windowDuration: 60_000,
  returnsStatusCode: 429,
};
const results: IEndpointRestriction = { type: 'resultSize', maxValue: 10_000, enforcement: 'truncate' };
const concurrency: IEndpointRestriction = { type: 'concurrentRequests', maxValue: 5 };

describe('EndpointRestrictionComparison', () => {
  describe('getEndpointRestrictionDifferences', () => {
    it('reports the fields with different values', () => {
      expect(getEndpointRestrictionDifferences(rate, { ...rate, maxValue: 10, windowDuration: 6_000 })).toEqual([
        { field: 'maxValue', provided: 60, advertised: 10 },
        { field: 'windowDuration', provided: 60_000, advertised: 6_000 },
      ]);
    });

    it('ignores fields that only one restriction specifies', () => {
      expect(getEndpointRestrictionDifferences({ type: 'rate', maxValue: 60, windowDuration: 60_000 }, rate))
        .toEqual([]);
    });

    it('considers restrictions strictly enforced unless they are advisory', () => {
      expect(getEndpointRestrictionDifferences(rate, { ...rate, hardRestriction: true })).toEqual([]);
      expect(getEndpointRestrictionDifferences(rate, { ...rate, hardRestriction: false })).toEqual([
        { field: 'hardRestriction', provided: true, advertised: false },
      ]);
    });
  });

  describe('compareEndpointRestrictions', () => {
    it('reports a match for the same restrictions in any order', () => {
      const comparison = compareEndpointRestrictions([ results, rate ], [ rate, results ]);
      expect(comparison.result).toBe('match');
      expect(comparison.matching).toEqual([
        { provided: results, advertised: results },
        { provided: rate, advertised: rate },
      ]);
      expect(describeEndpointRestrictionComparison(ENDPOINT, comparison))
        .toBe(`The restrictions provided for ${ENDPOINT} match the ones it advertises (2 restrictions)`);
    });

    it('reports a match if no restrictions are provided or advertised', () => {
      const comparison = compareEndpointRestrictions([], []);
      expect(comparison.result).toBe('match');
      expect(describeEndpointRestrictionComparison(ENDPOINT, comparison))
        .toBe(`The restrictions provided for ${ENDPOINT} match the ones it advertises (0 restrictions)`);
    });

    it('reports a partial match, with conflicts and restrictions that only one side has', () => {
      const comparison = compareEndpointRestrictions(
        [ rate, { ...results, maxValue: 1_000 }, concurrency ],
        [ rate, results, { type: 'responseTime', maxValue: 60 }],
      );
      expect(comparison.result).toBe('partial');
      expect(comparison.conflicting).toEqual([{
        provided: { ...results, maxValue: 1_000 },
        advertised: results,
        differences: [{ field: 'maxValue', provided: 1_000, advertised: 10_000 }],
      }]);
      expect(comparison.onlyProvided).toEqual([ concurrency ]);
      expect(comparison.onlyAdvertised).toEqual([{ type: 'responseTime', maxValue: 60 }]);
      expect(describeEndpointRestrictionComparison(ENDPOINT, comparison)).toBe(
        `The restrictions provided for ${ENDPOINT} partially match the ones it advertises: 1 of 3 match; ` +
        'resultSize differs in maxValue (provided 1000, advertised 10000); ' +
        'not advertised: concurrentRequests; not provided: responseTime',
      );
    });

    it('reports a partial match if all provided restrictions match, but others are advertised', () => {
      const comparison = compareEndpointRestrictions([ rate ], [ rate, results ]);
      expect(comparison.result).toBe('partial');
      expect(describeEndpointRestrictionComparison(ENDPOINT, comparison)).toBe(
        `The restrictions provided for ${ENDPOINT} partially match the ones it advertises: 1 of 1 match; not provided: resultSize`,
      );
    });

    it('pairs agreeing restrictions of the same type before disagreeing ones', () => {
      const daily: IEndpointRestriction = { ...rate, maxValue: 10_000, windowDuration: 86_400_000 };
      const comparison = compareEndpointRestrictions([ rate, daily ], [ daily, rate ]);
      expect(comparison.result).toBe('match');
    });

    it('reports a mismatch if no restriction agrees', () => {
      const comparison = compareEndpointRestrictions([{ ...rate, maxValue: 10 }], [ rate ]);
      expect(comparison.result).toBe('mismatch');
      expect(describeEndpointRestrictionComparison(ENDPOINT, comparison)).toBe(
        `The restrictions provided for ${ENDPOINT} do not match the ones it advertises: rate differs in maxValue (provided 10, advertised 60)`,
      );
    });

    it('reports a mismatch if the endpoint advertises no restrictions', () => {
      const comparison = compareEndpointRestrictions([ rate ], []);
      expect(comparison.result).toBe('mismatch');
      expect(describeEndpointRestrictionComparison(ENDPOINT, comparison)).toBe(
        `The restrictions provided for ${ENDPOINT} do not match the ones it advertises: it advertises no restrictions`,
      );
    });

    it('reports a mismatch if no restrictions are provided, but some are advertised', () => {
      const comparison = compareEndpointRestrictions([], [ rate ]);
      expect(comparison.result).toBe('mismatch');
      expect(describeEndpointRestrictionComparison(ENDPOINT, comparison)).toBe(
        `The restrictions provided for ${ENDPOINT} do not match the ones it advertises: not provided: rate`,
      );
    });
  });
});
